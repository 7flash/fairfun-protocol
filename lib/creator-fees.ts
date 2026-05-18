import { measure } from 'measure-fn';
import { Connection, ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { OnlinePumpSdk, hasCoinCreatorMigratedToSharingConfig } from '@pump-fun/pump-sdk';
import { config } from './config';
import { loadKeypairFromConfiguredValue } from './fairfun-program';
import { decodeBondingCurve } from './pump/bonding-curve';
import { bondingCurvePda } from './pump/pda';
import { getMetaNumber, setMeta } from './database';

let running = false;
let creatorFeeStatusCache: {
    expiresAt: number;
    value: CreatorFeeStatus;
} | null = null;
let lastTreasuryTopupAttemptAt = 0;

export interface CreatorFeeStatus {
    enabled: boolean;
    sharing: boolean;
    creator: string;
    claimer: string;
    currentUnclaimedLamports: string;
    currentUnclaimedSol: number;
    minClaimLamports: string;
    minClaimSol: number;
    trackedTreasuryTopupSol: number;
}

function getCreatorFeeWallet() {
    const configured = config.creatorFees.walletKeypairPath || config.rewards.backendKeypairPath;
    if (!configured) {
        throw new Error('Creator fee wallet keypair is not configured');
    }
    return loadKeypairFromConfiguredValue(configured);
}

async function sendVersionedInstructions(
    connection: Connection,
    payer: ReturnType<typeof getCreatorFeeWallet>,
    instructions: Parameters<TransactionMessage['compileToV0Message']>[0] extends never ? never : any[],
) {
    const latestBlockhash = await connection.getLatestBlockhash('processed');
    const message = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: config.creatorFees.computeUnitLimit }),
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: config.creatorFees.priorityFeeMicroLamports,
            }),
            ...instructions,
        ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([payer]);
    const signature = await connection.sendTransaction(tx, {
        skipPreflight: false,
        maxRetries: 5,
    });
    const confirmation = await connection.confirmTransaction({
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    }, 'confirmed');
    if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    return signature;
}

async function sendTreasuryTopup(
    connection: Connection,
    payer: ReturnType<typeof getCreatorFeeWallet>,
    lamports: bigint,
) {
    if (lamports <= 0n) {
        return null;
    }
    return await sendVersionedInstructions(connection, payer, [
        SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: new PublicKey(config.rewards.treasuryAddress),
            lamports: Number(lamports),
        }),
    ]);
}

async function maybeSendTreasuryTopup(
    connection: Connection,
    payer: ReturnType<typeof getCreatorFeeWallet>,
    now: number,
) {
    const cooldownMs = config.creatorFees.treasuryTopupCooldownMs;
    if (cooldownMs > 0 && now - lastTreasuryTopupAttemptAt < cooldownMs) {
        return {
            attempted: false,
            reason: 'cooldown',
            walletBalanceLamports: '0',
            topupLamports: '0',
            treasurySignature: null as string | null,
        };
    }

    lastTreasuryTopupAttemptAt = now;
    const walletBalanceLamports = BigInt(await connection.getBalance(payer.publicKey, 'confirmed'));
    const triggerLamports = BigInt(Math.round(config.creatorFees.treasuryTopupTriggerSol * 1_000_000_000));
    const reserveLamports = BigInt(Math.round(config.creatorFees.treasuryTopupReserveSol * 1_000_000_000));
    const minSendLamports = BigInt(Math.round(config.creatorFees.treasuryTopupMinSendSol * 1_000_000_000));

    if (walletBalanceLamports <= triggerLamports) {
        return {
            attempted: false,
            reason: 'wallet-below-trigger',
            walletBalanceLamports: walletBalanceLamports.toString(),
            topupLamports: '0',
            treasurySignature: null as string | null,
        };
    }

    const spendableLamports = walletBalanceLamports > reserveLamports
        ? walletBalanceLamports - reserveLamports
        : 0n;
    if (spendableLamports < minSendLamports) {
        return {
            attempted: false,
            reason: 'spendable-below-min-send',
            walletBalanceLamports: walletBalanceLamports.toString(),
            topupLamports: spendableLamports.toString(),
            treasurySignature: null as string | null,
        };
    }

    const treasurySignature = await sendTreasuryTopup(connection, payer, spendableLamports);
    if (treasurySignature && spendableLamports > 0n) {
        const topupSol = Number(spendableLamports) / 1_000_000_000;
        setMeta('creatorFeeTopupTotalSol', getMetaNumber('creatorFeeTopupTotalSol', 0) + topupSol);
        setMeta('creatorFeeLastTreasuryTopupSignature', treasurySignature);
        setMeta('creatorFeeLastTreasuryTopupLamports', spendableLamports.toString());
    }

    return {
        attempted: true,
        reason: 'sent',
        walletBalanceLamports: walletBalanceLamports.toString(),
        topupLamports: spendableLamports.toString(),
        treasurySignature,
    };
}

export async function getCreatorFeeStatus(forceRefresh = false): Promise<CreatorFeeStatus> {
    const now = Date.now();
    if (!forceRefresh && creatorFeeStatusCache && creatorFeeStatusCache.expiresAt > now) {
        return creatorFeeStatusCache.value;
    }

    const connection = new Connection(config.chain.rpcUrl, 'processed');
    const sdk = new OnlinePumpSdk(connection);
    const wallet = getCreatorFeeWallet();
    const mint = new PublicKey(config.creatorFees.mint || config.token.mint);
    const curve = bondingCurvePda(mint);
    const curveInfo = await connection.getAccountInfo(curve, 'processed');
    if (!curveInfo) {
        throw new Error(`Missing bonding curve for mint ${mint.toBase58()}`);
    }

    const decoded = decodeBondingCurve(Buffer.from(curveInfo.data));
    const creator = decoded.creator;
    const sharing = hasCoinCreatorMigratedToSharingConfig({ mint, creator });
    const currentUnclaimedLamports = sharing
        ? BigInt((await sdk.getMinimumDistributableFee(mint)).distributableFees.toString())
        : BigInt((await sdk.getCreatorVaultBalanceBothPrograms(creator)).toString());

    const value: CreatorFeeStatus = {
        enabled: config.creatorFees.enabled,
        sharing,
        creator: creator.toBase58(),
        claimer: wallet.publicKey.toBase58(),
        currentUnclaimedLamports: currentUnclaimedLamports.toString(),
        currentUnclaimedSol: Number(currentUnclaimedLamports) / 1_000_000_000,
        minClaimLamports: config.creatorFees.minClaimLamports.toString(),
        minClaimSol: Number(config.creatorFees.minClaimLamports) / 1_000_000_000,
        trackedTreasuryTopupSol: getMetaNumber('creatorFeeTopupTotalSol', 0),
    };
    creatorFeeStatusCache = {
        value,
        expiresAt: now + 30_000,
    };
    return value;
}

export async function runCreatorFeeClaimPass() {
    if (running || !config.creatorFees.enabled) {
        return {
            attempted: false,
            completed: false,
            reason: running ? 'already-running' : 'disabled',
        };
    }

    running = true;
    try {
        return await measure('Run creator fee claim pass', async () => {
            const connection = new Connection(config.chain.rpcUrl, 'processed');
            const sdk = new OnlinePumpSdk(connection);
            const wallet = getCreatorFeeWallet();
            const mint = new PublicKey(config.creatorFees.mint || config.token.mint);
            const curve = bondingCurvePda(mint);
            const curveInfo = await connection.getAccountInfo(curve, 'processed');
            if (!curveInfo) {
                throw new Error(`Missing bonding curve for mint ${mint.toBase58()}`);
            }

            const decoded = decodeBondingCurve(Buffer.from(curveInfo.data));
            const creator = decoded.creator;
            const sharing = hasCoinCreatorMigratedToSharingConfig({ mint, creator });

            if (!sharing && !wallet.publicKey.equals(creator)) {
                throw new Error(
                    `Configured creator fee wallet ${wallet.publicKey.toBase58()} is not the mint creator ${creator.toBase58()}`,
                );
            }

            const beforeBalance = BigInt(await connection.getBalance(wallet.publicKey, 'confirmed'));
            const now = Date.now();
            let claimableLamports = 0n;
            let claimSignature: string | null = null;

            if (sharing) {
                const distributable = await sdk.getMinimumDistributableFee(mint);
                claimableLamports = BigInt(distributable.distributableFees.toString());
                if (!distributable.canDistribute || claimableLamports < config.creatorFees.minClaimLamports) {
                    const topup = await maybeSendTreasuryTopup(connection, wallet, now);
                    return {
                        attempted: false,
                        completed: topup.attempted && !!topup.treasurySignature,
                        reason: 'below-threshold',
                        sharing,
                        claimableLamports: claimableLamports.toString(),
                        treasuryTopup: topup,
                    };
                }

                const built = await sdk.buildDistributeCreatorFeesInstructions(mint);
                claimSignature = await sendVersionedInstructions(connection, wallet, built.instructions);
            } else {
                claimableLamports = BigInt((await sdk.getCreatorVaultBalanceBothPrograms(creator)).toString());
                if (claimableLamports < config.creatorFees.minClaimLamports) {
                    const topup = await maybeSendTreasuryTopup(connection, wallet, now);
                    return {
                        attempted: false,
                        completed: topup.attempted && !!topup.treasurySignature,
                        reason: 'below-threshold',
                        sharing,
                        claimableLamports: claimableLamports.toString(),
                        treasuryTopup: topup,
                    };
                }

                const instructions = await sdk.collectCoinCreatorFeeInstructions(creator, creator);
                claimSignature = await sendVersionedInstructions(connection, wallet, instructions);
            }

            const afterClaimBalance = BigInt(await connection.getBalance(wallet.publicKey, 'confirmed'));
            const topup = await maybeSendTreasuryTopup(connection, wallet, now);
            if (claimSignature) {
                setMeta('creatorFeeLastClaimSignature', claimSignature);
            }
            creatorFeeStatusCache = null;

            return {
                attempted: true,
                completed: true,
                sharing,
                creator: creator.toBase58(),
                claimer: wallet.publicKey.toBase58(),
                claimableLamports: claimableLamports.toString(),
                claimSignature,
                treasurySignature: topup.treasurySignature,
                treasuryTopupLamports: topup.topupLamports,
                walletBalanceBeforeLamports: beforeBalance.toString(),
                walletBalanceAfterClaimLamports: afterClaimBalance.toString(),
                treasuryTopup: topup,
            };
        });
    } finally {
        running = false;
    }
}
