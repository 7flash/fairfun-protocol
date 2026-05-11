import type { VersionedTransactionResponse } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { connection } from './solana';

function getStaticAccountKeys(tx: VersionedTransactionResponse) {
    return tx.transaction.message.getAccountKeys().staticAccountKeys;
}

export function derivePrimaryDepositorAddress(
    tx: VersionedTransactionResponse,
    treasury: PublicKey
) {
    const accountKeys = getStaticAccountKeys(tx);
    let bestSigner: { address: string; spentLamports: number } | null = null;
    let bestAny: { address: string; spentLamports: number } | null = null;

    for (let index = 0; index < accountKeys.length; index++) {
        const key = accountKeys[index];
        if (key.equals(treasury)) continue;

        const pre = tx.meta?.preBalances[index] ?? 0;
        const post = tx.meta?.postBalances[index] ?? 0;
        const spentLamports = pre - post;
        if (spentLamports <= 0) continue;

        const candidate = { address: key.toBase58(), spentLamports };
        if (!bestAny || spentLamports > bestAny.spentLamports) {
            bestAny = candidate;
        }
        if (tx.transaction.message.isAccountSigner(index) && (!bestSigner || spentLamports > bestSigner.spentLamports)) {
            bestSigner = candidate;
        }
    }

    return bestSigner?.address ?? bestAny?.address ?? accountKeys[0]?.toBase58() ?? '';
}

export async function fetchTreasuryDepositorAddress(signature: string, treasuryAddress: string) {
    if (!signature || !treasuryAddress) return '';

    const tx = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
    });

    if (!tx?.meta || !tx.transaction) return '';
    return derivePrimaryDepositorAddress(tx, new PublicKey(treasuryAddress));
}
