import { measure } from 'measure-fn';
import { Connection, ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { OnlinePumpSdk, hasCoinCreatorMigratedToSharingConfig } from '@pump-fun/pump-sdk';
import { config } from './config';
import { loadKeypairFromConfiguredValue } from './fairfun-program';
import { decodeBondingCurve } from './pump/bonding-curve';
import { bondingCurvePda } from './pump/pda';

let running = false;

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

            if (sharing) {
                const distributable = await sdk.getMinimumDistributableFee(mint);
                claimableLamports = BigInt(distributable.distributableFees.toString());
                if (!distributable.canDistribute || claimableLamports < config.creatorFees.minClaimLamports) {
                    return {
                        attempted: false,
                        completed: false,
                        reason: 'below-threshold',
                        sharing,
                        claimableLamports: claimableLamports.toString(),
                    };
                }

                const built = await sdk.buildDistributeCreatorFeesInstructions(mint);
                claimSignature = await sendVersionedInstructions(connection, wallet, built.instructions);
            } else {
                claimableLamports = BigInt((await sdk.getCreatorVaultBalanceBothPrograms(creator)).toString());
                if (claimableLamports < config.creatorFees.minClaimLamports) {
                    return {
                        attempted: false,
                        completed: false,
                        reason: 'below-threshold',
                        sharing,
                        claimableLamports: claimableLamports.toString(),
                    };
                }

                const instructions = await sdk.collectCoinCreatorFeeInstructions(creator, creator);
                claimSignature = await sendVersionedInstructions(connection, wallet, instructions);
            }

            const afterClaimBalance = BigInt(await connection.getBalance(wallet.publicKey, 'confirmed'));
            const reserveLamports = BigInt(Math.round(config.creatorFees.treasuryTopupReserveSol * 1_000_000_000));
            const spendableLamports = afterClaimBalance > reserveLamports ? afterClaimBalance - reserveLamports : 0n;
            const topupLamports = spendableLamports < claimableLamports ? spendableLamports : claimableLamports;
            const treasurySignature = await sendTreasuryTopup(connection, wallet, topupLamports);

            return {
                attempted: true,
                completed: true,
                sharing,
                creator: creator.toBase58(),
                claimer: wallet.publicKey.toBase58(),
                claimableLamports: claimableLamports.toString(),
                claimSignature,
                treasurySignature,
                treasuryTopupLamports: topupLamports.toString(),
                walletBalanceBeforeLamports: beforeBalance.toString(),
                walletBalanceAfterClaimLamports: afterClaimBalance.toString(),
            };
        });
    } finally {
        running = false;
    }
}
