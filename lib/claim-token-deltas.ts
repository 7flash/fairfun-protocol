import type { Connection } from '@solana/web3.js';

type ParsedTransaction = Awaited<
    ReturnType<Connection['getParsedTransactions']>
>[number];

export function getPositiveTokenDeltasByOwner(
    tx: ParsedTransaction,
    mint: string,
) {
    const pre = tx?.meta?.preTokenBalances ?? [];
    const post = tx?.meta?.postTokenBalances ?? [];
    const byAccount = new Map<string, { owner: string; pre: number; post: number }>();

    for (const balance of pre) {
        if (balance.mint !== mint) continue;
        const key = `${balance.accountIndex}:${balance.owner ?? ''}`;
        const current = byAccount.get(key) ?? { owner: balance.owner ?? '', pre: 0, post: 0 };
        current.owner = balance.owner ?? current.owner;
        current.pre = Number(
            balance.uiTokenAmount.uiAmountString ?? balance.uiTokenAmount.uiAmount ?? 0,
        );
        byAccount.set(key, current);
    }

    for (const balance of post) {
        if (balance.mint !== mint) continue;
        const key = `${balance.accountIndex}:${balance.owner ?? ''}`;
        const current = byAccount.get(key) ?? { owner: balance.owner ?? '', pre: 0, post: 0 };
        current.owner = balance.owner ?? current.owner;
        current.post = Number(
            balance.uiTokenAmount.uiAmountString ?? balance.uiTokenAmount.uiAmount ?? 0,
        );
        byAccount.set(key, current);
    }

    const byOwner = new Map<string, number>();
    for (const row of byAccount.values()) {
        const delta = row.post - row.pre;
        if (delta <= 0 || !row.owner) continue;
        byOwner.set(row.owner, (byOwner.get(row.owner) ?? 0) + delta);
    }

    return byOwner;
}
