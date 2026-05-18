import { Connection } from '@solana/web3.js';
import { getAllClaimEvents } from './database';
import { config } from './config';

export interface ClaimStatsSummary {
    totalClaims: number;
    totalGrossSol: number;
    totalClaimantSol: number;
    totalProjectFeeSol: number;
    totalClaimantTokens: number;
    totalDistributedTokens: number;
}

let cachedKey = '';
let cachedAt = 0;
let cachedSummary: ClaimStatsSummary | null = null;
let connection: Connection | null = null;

function getConnection() {
    if (!connection) {
        connection = new Connection(config.chain.rpcUrl, 'confirmed');
    }
    return connection;
}

function sumTokenDeltas(
    tx: Awaited<ReturnType<Connection['getParsedTransactions']>>[number],
    mint: string,
    claimant: string,
) {
    const pre = tx?.meta?.preTokenBalances ?? [];
    const post = tx?.meta?.postTokenBalances ?? [];
    const byKey = new Map<string, { owner: string; pre: number; post: number }>();

    for (const balance of pre) {
        if (balance.mint !== mint) continue;
        const key = `${balance.accountIndex}:${balance.owner ?? ''}`;
        const current = byKey.get(key) ?? { owner: balance.owner ?? '', pre: 0, post: 0 };
        current.owner = balance.owner ?? current.owner;
        current.pre = Number(balance.uiTokenAmount.uiAmountString ?? balance.uiTokenAmount.uiAmount ?? 0);
        byKey.set(key, current);
    }

    for (const balance of post) {
        if (balance.mint !== mint) continue;
        const key = `${balance.accountIndex}:${balance.owner ?? ''}`;
        const current = byKey.get(key) ?? { owner: balance.owner ?? '', pre: 0, post: 0 };
        current.owner = balance.owner ?? current.owner;
        current.post = Number(balance.uiTokenAmount.uiAmountString ?? balance.uiTokenAmount.uiAmount ?? 0);
        byKey.set(key, current);
    }

    let claimantDelta = 0;
    for (const row of byKey.values()) {
        const delta = row.post - row.pre;
        if (delta <= 0) continue;
        if (row.owner === claimant) claimantDelta += delta;
    }

    return {
        claimantDelta,
    };
}

export async function getClaimStatsSummary() {
    const events = getAllClaimEvents().filter((event) =>
        event.grossAmountSol > 0 || event.claimantAmountSol > 0 || event.projectFeeSol > 0
    );
    const cacheKey = `${events.length}:${events.at(-1)?.signature ?? ''}:${events.at(-1)?.timestamp ?? 0}`;
    const now = Date.now();
    if (cachedSummary && cachedKey === cacheKey && now - cachedAt < 60_000) {
        return cachedSummary;
    }

    let totalClaimantTokens = 0;
    const conn = getConnection();
    const eventsBySignature = new Map<string, typeof events>();
    for (const event of events) {
        const existing = eventsBySignature.get(event.signature) ?? [];
        existing.push(event);
        eventsBySignature.set(event.signature, existing);
    }

    const signatures = Array.from(eventsBySignature.keys());
    for (let start = 0; start < signatures.length; start += 20) {
        const batchSignatures = signatures.slice(start, start + 20);
        const txs = await conn.getParsedTransactions(
            batchSignatures,
            { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }
        );
        for (let index = 0; index < batchSignatures.length; index++) {
            const signature = batchSignatures[index];
            const tx = txs[index];
            if (!tx) continue;
            const signatureEvents = eventsBySignature.get(signature) ?? [];
            const seenClaimants = new Set<string>();
            for (const event of signatureEvents) {
                if (!seenClaimants.has(event.claimantAddress)) {
                    const deltas = sumTokenDeltas(tx, config.token.mint, event.claimantAddress);
                    totalClaimantTokens += deltas.claimantDelta;
                    seenClaimants.add(event.claimantAddress);
                }
            }
        }
    }

    cachedSummary = {
        totalClaims: events.length,
        totalGrossSol: events.reduce((sum, event) => sum + event.grossAmountSol, 0),
        totalClaimantSol: events.reduce((sum, event) => sum + event.claimantAmountSol, 0),
        totalProjectFeeSol: events.reduce((sum, event) => sum + event.projectFeeSol, 0),
        totalClaimantTokens,
        totalDistributedTokens: totalClaimantTokens,
    };
    cachedKey = cacheKey;
    cachedAt = now;
    return cachedSummary;
}
