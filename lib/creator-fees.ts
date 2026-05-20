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

function getTreasuryTopupReserveLamports() {
    return BigInt(Math.round(config.creatorFees.treasuryTopupReserveSol * 1_000_000_000));
}

function getSpendableLamports(walletBalanceLamports: bigint) {
    const reserveLamports = getTreasuryTopupReserveLamports();
    return walletBalanceLamports > reserveLamports
        ? walletBalanceLamports - reserveLamports
        : 0n;
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

function buildTreasuryTopupInstruction(
    payer: ReturnType<typeof getCreatorFeeWallet>,
    lamports: bigint,
) {
    if (lamports <= 0n) {
        return null;
    }
    return SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: new PublicKey(config.rewards.treasuryAddress),
        lamports: Number(lamports),
    });
}

async function maybeSweepWalletSurplusToTreasury(
    connection: Connection,
    payer: ReturnType<typeof getCreatorFeeWallet>,
) {
    const walletBalanceLamports = BigInt(await connection.getBalance(payer.publicKey, 'confirmed'));
    const spendableLamports = getSpendableLamports(walletBalanceLamports);
    if (spendableLamports <= 0n) {
        return {
            attempted: false,
            reason: 'wallet-at-or-below-reserve',
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
            let claimableLamports = 0n;
            let claimSignature: string | null = null;
            let treasurySignature: string | null = null;
            let treasuryTopupLamports = 0n;

            if (sharing) {
                const distributable = await sdk.getMinimumDistributableFee(mint);
                claimableLamports = BigInt(distributable.distributableFees.toString());
                if (!distributable.canDistribute || claimableLamports < config.creatorFees.minClaimLamports) {
                    const topup = await maybeSweepWalletSurplusToTreasury(connection, wallet);
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
                treasuryTopupLamports = getSpendableLamports(beforeBalance + claimableLamports);
                const topupInstruction = buildTreasuryTopupInstruction(wallet, treasuryTopupLamports);
                claimSignature = await sendVersionedInstructions(
                    connection,
                    wallet,
                    topupInstruction ? [...built.instructions, topupInstruction] : built.instructions,
                );
                treasurySignature = topupInstruction ? claimSignature : null;
            } else {
                claimableLamports = BigInt((await sdk.getCreatorVaultBalanceBothPrograms(creator)).toString());
                if (claimableLamports < config.creatorFees.minClaimLamports) {
                    const topup = await maybeSweepWalletSurplusToTreasury(connection, wallet);
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
                treasuryTopupLamports = getSpendableLamports(beforeBalance + claimableLamports);
                const topupInstruction = buildTreasuryTopupInstruction(wallet, treasuryTopupLamports);
                claimSignature = await sendVersionedInstructions(
                    connection,
                    wallet,
                    topupInstruction ? [...instructions, topupInstruction] : instructions,
                );
                treasurySignature = topupInstruction ? claimSignature : null;
            }

            const afterClaimBalance = BigInt(await connection.getBalance(wallet.publicKey, 'confirmed'));
            if (claimSignature) {
                setMeta('creatorFeeLastClaimSignature', claimSignature);
            }
            if (treasurySignature && treasuryTopupLamports > 0n) {
                const topupSol = Number(treasuryTopupLamports) / 1_000_000_000;
                setMeta('creatorFeeTopupTotalSol', getMetaNumber('creatorFeeTopupTotalSol', 0) + topupSol);
                setMeta('creatorFeeLastTreasuryTopupSignature', treasurySignature);
                setMeta('creatorFeeLastTreasuryTopupLamports', treasuryTopupLamports.toString());
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
                treasurySignature,
                treasuryTopupLamports: treasuryTopupLamports.toString(),
                walletBalanceBeforeLamports: beforeBalance.toString(),
                walletBalanceAfterClaimLamports: afterClaimBalance.toString(),
                treasuryTopup: {
                    attempted: treasuryTopupLamports > 0n,
                    reason: treasuryTopupLamports > 0n ? 'sent-inline-with-claim' : 'claim-left-wallet-at-or-below-reserve',
                    walletBalanceLamports: beforeBalance.toString(),
                    topupLamports: treasuryTopupLamports.toString(),
                    treasurySignature,
                },
            };
        });
    } finally {
        running = false;
    }
}
