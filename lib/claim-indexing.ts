import { createHash } from 'crypto';
import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';

const EVENT_LOG_PREFIX = 'Program data: ';
const PROJECT_FEE_BPS = 1_000n;
const BASIS_POINTS_DENOMINATOR = 10_000n;
const LAMPORTS_PER_SOL = 1_000_000_000;

type RewardsClaimedEvent = {
    pool: string;
    tokenMint: string;
    user: string;
    grossClaimableAmount: bigint;
    projectFee: bigint;
    netClaimAmount: bigint;
    cumulativeEarned: bigint;
    observedTotalDeposits: bigint;
    totalClaimed: bigint;
};

type BatchRewardsClaimedEvent = {
    pool: string;
    tokenMint: string;
    executor: string;
    claimCount: number;
    totalGrossClaimedAmount: bigint;
    totalProjectFee: bigint;
};

type BatchRewardsClaimedToTokensEvent = {
    pool: string;
    tokenMint: string;
    executor: string;
    claimCount: number;
    totalGrossClaimedAmount: bigint;
    totalProjectFee: bigint;
    totalNetSwappedAmount: bigint;
    totalPurchasedTokens: bigint;
    totalClaimantTokens: bigint;
    tokenDust: bigint;
};

export type IndexedClaimRecipient = {
    claimantAddress: string;
    grossAmountSol: number;
    claimantAmountSol: number;
    projectFeeSol: number;
    totalClaimedSol: number;
};

export type IndexedClaimMaterialization = {
    signature: string;
    timestamp: number;
    mode: 'direct' | 'delegated' | 'delegated-batch-tokenized';
    delegatorAddress: string;
    recipients: IndexedClaimRecipient[];
};

function eventDiscriminator(name: string) {
    return createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
}

const REWARDS_CLAIMED_DISCRIMINATOR = eventDiscriminator('RewardsClaimed');
const BATCH_REWARDS_CLAIMED_DISCRIMINATOR = eventDiscriminator('BatchRewardsClaimed');
const BATCH_REWARDS_CLAIMED_TO_TOKENS_DISCRIMINATOR = eventDiscriminator('BatchRewardsClaimedToTokens');

function readPubkey(buffer: Buffer, offset: number) {
    return new PublicKey(buffer.subarray(offset, offset + 32)).toBase58();
}

function lamportsToSolNumber(amount: bigint) {
    return Number(amount) / LAMPORTS_PER_SOL;
}

function calculateDelegatedClaimSplit(claimable: bigint) {
    const projectFee = claimable * PROJECT_FEE_BPS / BASIS_POINTS_DENOMINATOR;
    const claimantAmount = claimable - projectFee;
    return { claimantAmount, projectFee };
}

function decodeRewardsClaimed(buffer: Buffer): RewardsClaimedEvent {
    if (buffer.length >= 152) {
        return {
            pool: readPubkey(buffer, 8),
            tokenMint: readPubkey(buffer, 40),
            user: readPubkey(buffer, 72),
            grossClaimableAmount: buffer.readBigUInt64LE(104),
            projectFee: buffer.readBigUInt64LE(112),
            netClaimAmount: buffer.readBigUInt64LE(120),
            cumulativeEarned: buffer.readBigUInt64LE(128),
            observedTotalDeposits: buffer.readBigUInt64LE(136),
            totalClaimed: buffer.readBigUInt64LE(144),
        };
    }
    const grossClaimableAmount = buffer.readBigUInt64LE(104);
    return {
        pool: readPubkey(buffer, 8),
        tokenMint: readPubkey(buffer, 40),
        user: readPubkey(buffer, 72),
        grossClaimableAmount,
        projectFee: 0n,
        netClaimAmount: grossClaimableAmount,
        cumulativeEarned: buffer.readBigUInt64LE(112),
        observedTotalDeposits: buffer.readBigUInt64LE(120),
        totalClaimed: buffer.readBigUInt64LE(128),
    };
}

function decodeBatchRewardsClaimed(buffer: Buffer): BatchRewardsClaimedEvent {
    if (buffer.length >= 124 && buffer.length < 132) {
        return {
            pool: readPubkey(buffer, 8),
            tokenMint: readPubkey(buffer, 40),
            executor: readPubkey(buffer, 72),
            claimCount: buffer.readUInt32LE(104),
            totalGrossClaimedAmount: buffer.readBigUInt64LE(108),
            totalProjectFee: buffer.readBigUInt64LE(116),
        };
    }
    return {
        pool: readPubkey(buffer, 8),
        tokenMint: readPubkey(buffer, 40),
        executor: readPubkey(buffer, 72),
        claimCount: buffer.readUInt32LE(104),
        totalGrossClaimedAmount: buffer.readBigUInt64LE(108),
        totalProjectFee: 0n,
    };
}

function decodeBatchRewardsClaimedToTokens(buffer: Buffer): BatchRewardsClaimedToTokensEvent {
    if (buffer.length >= 156) {
        return {
            pool: readPubkey(buffer, 8),
            tokenMint: readPubkey(buffer, 40),
            executor: readPubkey(buffer, 72),
            claimCount: buffer.readUInt32LE(104),
            totalGrossClaimedAmount: buffer.readBigUInt64LE(108),
            totalProjectFee: buffer.readBigUInt64LE(116),
            totalNetSwappedAmount: buffer.readBigUInt64LE(124),
            totalPurchasedTokens: buffer.readBigUInt64LE(132),
            totalClaimantTokens: buffer.readBigUInt64LE(140),
            tokenDust: buffer.readBigUInt64LE(148),
        };
    }
    return {
        pool: readPubkey(buffer, 8),
        tokenMint: readPubkey(buffer, 40),
        executor: readPubkey(buffer, 72),
        claimCount: buffer.readUInt32LE(104),
        totalGrossClaimedAmount: buffer.readBigUInt64LE(108),
        totalProjectFee: 0n,
        totalNetSwappedAmount: buffer.readBigUInt64LE(108),
        totalPurchasedTokens: buffer.readBigUInt64LE(116),
        totalClaimantTokens: buffer.readBigUInt64LE(124),
        tokenDust: buffer.readBigUInt64LE(132),
    };
}

function extractEventPayloads(logMessages: string[] | null | undefined) {
    const payloads: Buffer[] = [];
    for (const line of logMessages ?? []) {
        const trimmed = line.trim();
        const index = trimmed.indexOf(EVENT_LOG_PREFIX);
        if (index < 0) continue;
        const raw = trimmed.slice(index + EVENT_LOG_PREFIX.length).trim();
        if (!raw) continue;
        try {
            payloads.push(Buffer.from(raw, 'base64'));
        } catch {
            continue;
        }
    }
    return payloads;
}

function getPayerAddress(tx: VersionedTransactionResponse) {
    const accountKeys = tx.transaction.message.getAccountKeys({
        accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined,
    }).keySegments().flat();
    return accountKeys[0]?.toBase58() ?? '';
}

function deriveClaimMode(
    logMessages: string[] | null | undefined,
    hasBatchTokenized: boolean,
    hasBatchDelegated: boolean,
): IndexedClaimMaterialization['mode'] {
    const joined = (logMessages ?? []).join('\n');
    if (hasBatchTokenized) return 'delegated-batch-tokenized';
    if (hasBatchDelegated) return 'delegated';
    if (
        joined.includes('Instruction: DelegatedClaim')
        || joined.includes('Instruction: DelegatedClaimToTokens')
        || joined.includes('Instruction: DelegatedClaimMany')
        || joined.includes('Instruction: DelegatedClaimManyToTokens')
    ) {
        return 'delegated';
    }
    return 'direct';
}

export function materializeClaimEventsFromTransaction(
    signature: string,
    tx: VersionedTransactionResponse | null,
) {
    if (!tx?.meta?.logMessages?.length) return null;

    const rewardsClaimed: RewardsClaimedEvent[] = [];
    let batchRewardsClaimed: BatchRewardsClaimedEvent | null = null;
    let batchRewardsClaimedToTokens: BatchRewardsClaimedToTokensEvent | null = null;

    for (const payload of extractEventPayloads(tx.meta.logMessages)) {
        if (payload.length < 8) continue;
        const discriminator = payload.subarray(0, 8);

        if (discriminator.equals(REWARDS_CLAIMED_DISCRIMINATOR) && payload.length >= 136) {
            rewardsClaimed.push(decodeRewardsClaimed(payload));
            continue;
        }
        if (discriminator.equals(BATCH_REWARDS_CLAIMED_DISCRIMINATOR) && payload.length >= 124) {
            batchRewardsClaimed = decodeBatchRewardsClaimed(payload);
            continue;
        }
        if (discriminator.equals(BATCH_REWARDS_CLAIMED_TO_TOKENS_DISCRIMINATOR) && payload.length >= 140) {
            batchRewardsClaimedToTokens = decodeBatchRewardsClaimedToTokens(payload);
        }
    }

    if (rewardsClaimed.length === 0) return null;

    const mode = deriveClaimMode(
        tx.meta.logMessages,
        Boolean(batchRewardsClaimedToTokens),
        Boolean(batchRewardsClaimed),
    );
    const delegatorAddress =
        batchRewardsClaimedToTokens?.executor
        ?? batchRewardsClaimed?.executor
        ?? (mode === 'direct' ? '' : getPayerAddress(tx));
    const timestamp = tx.blockTime ? tx.blockTime * 1000 : Date.now();

    const recipients: IndexedClaimRecipient[] = rewardsClaimed.map((event) => {
        const split = event.projectFee === 0n
            && event.netClaimAmount === event.grossClaimableAmount
            && mode !== 'direct'
            ? calculateDelegatedClaimSplit(event.grossClaimableAmount)
            : { claimantAmount: event.netClaimAmount, projectFee: event.projectFee };
        return {
            claimantAddress: event.user,
            grossAmountSol: lamportsToSolNumber(event.grossClaimableAmount),
            claimantAmountSol: lamportsToSolNumber(split.claimantAmount),
            projectFeeSol: lamportsToSolNumber(split.projectFee),
            totalClaimedSol: lamportsToSolNumber(event.totalClaimed),
        };
    });

    return {
        signature,
        timestamp,
        mode,
        delegatorAddress,
        recipients,
    } satisfies IndexedClaimMaterialization;
}
