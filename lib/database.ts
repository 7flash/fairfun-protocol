import { mkdirSync } from 'fs';
import path from 'path';
import { Database as BunDatabase } from 'bun:sqlite';
import { Database, z } from 'sqlite-zod-orm';
import { config } from './config';
const MIN_DISTRIBUTION_GRAVITY_SHARE = 0.0001;

const dbPath = config.indexer.dbPath;
const dataDir = path.dirname(dbPath);
mkdirSync(dataDir, { recursive: true });

function resetLegacyTables() {
    const legacy = new BunDatabase(dbPath, { create: true });
    try {
        const columns = legacy.query<{ name: string }, []>('PRAGMA table_info(holders)').all();
        const names = new Set(columns.map((column) => column.name));
        if (columns.length > 0 && (!names.has('id') || !names.has('tokenBalance'))) {
            legacy.exec('DROP TABLE IF EXISTS holders');
        }
        if (columns.length > 0 && !names.has('delegatedClaimsEnabled')) {
            legacy.exec('ALTER TABLE holders ADD COLUMN delegatedClaimsEnabled INTEGER DEFAULT 1');
            legacy.exec('UPDATE holders SET delegatedClaimsEnabled = 1 WHERE delegatedClaimsEnabled IS NULL');
        }

        const claimEventIndexes = legacy.query<{ name: string; sql: string | null }, []>(
            "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'claimEvents'"
        ).all();
        const hasLegacyClaimSignatureUnique = claimEventIndexes.some((index) => index.name === 'uq_claimEvents_signature');
        const hasBatchClaimUnique = claimEventIndexes.some((index) => index.name === 'uq_claimEvents_signature_claimantAddress');
        if (hasLegacyClaimSignatureUnique && !hasBatchClaimUnique) {
            legacy.exec('DROP INDEX IF EXISTS uq_claimEvents_signature');
            legacy.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_claimEvents_signature_claimantAddress ON "claimEvents" ("signature", "claimantAddress")');
        }
    } finally {
        legacy.close();
    }
}

resetLegacyTables();

export const db = new Database(dbPath, {
    holders: z.object({
        address: z.string(),
        tokenBalance: z.number().default(0),
        tokenValueUsd: z.number().default(0),
        accumulatedGravity: z.number().default(0),
        totalSolRewardsEarned: z.number().default(0),
        totalSolRewardsClaimed: z.number().default(0),
        claimableSolRewards: z.number().default(0),
        delegatedClaimsEnabled: z.boolean().default(true),
        lastHoldingUpdate: z.number().default(0),
        lastGravityUpdate: z.number().default(0),
        updatedAt: z.number().default(0)
    }),
    metadata: z.object({
        key: z.string(),
        value: z.string()
    }),
    treasuryEvents: z.object({
        signature: z.string(),
        amountSol: z.number(),
        depositorAddress: z.string().default(''),
        observedTotalDepositsSol: z.number().default(0),
        slot: z.number().default(0),
        timestamp: z.number().default(0),
        createdAt: z.number().default(0)
    }),
    treasuryPayouts: z.object({
        signature: z.string(),
        address: z.string(),
        amountSol: z.number(),
        createdAt: z.number().default(0)
    }),
    claimEvents: z.object({
        signature: z.string(),
        claimantAddress: z.string(),
        delegatorAddress: z.string().default(''),
        grossAmountSol: z.number().default(0),
        claimantAmountSol: z.number().default(0),
        delegatorFeeSol: z.number().default(0),
        mode: z.string().default('direct'),
        timestamp: z.number().default(0),
        createdAt: z.number().default(0)
    })
}, {
    indexes: {
        holders: ['address', 'tokenBalance', 'accumulatedGravity', 'claimableSolRewards'],
        metadata: ['key'],
        treasuryEvents: ['signature', 'timestamp'],
        treasuryPayouts: ['signature', 'address'],
        claimEvents: ['signature', 'claimantAddress', 'delegatorAddress', 'timestamp']
    },
    unique: {
        holders: [['address']],
        metadata: [['key']],
        treasuryEvents: [['signature']],
        treasuryPayouts: [['signature', 'address']],
        claimEvents: [['signature', 'claimantAddress']]
    }
});

export interface HolderRecord {
    id?: number;
    address: string;
    tokenBalance: number;
    tokenValueUsd: number;
    accumulatedGravity: number;
    totalSolRewardsEarned: number;
    totalSolRewardsClaimed: number;
    claimableSolRewards: number;
    delegatedClaimsEnabled: boolean;
    lastHoldingUpdate: number;
    lastGravityUpdate: number;
    updatedAt: number;
}

export interface HolderSnapshotInput {
    address: string;
    tokenBalance: number;
    tokenValueUsd: number;
    now?: number;
}

export interface TreasuryEventRecord {
    id?: number;
    signature: string;
    amountSol: number;
    depositorAddress: string;
    observedTotalDepositsSol: number;
    slot: number;
    timestamp: number;
    createdAt: number;
}

export interface TreasuryPayoutRecord {
    id?: number;
    signature: string;
    address: string;
    amountSol: number;
    createdAt: number;
}

export interface ClaimEventRecord {
    id?: number;
    signature: string;
    claimantAddress: string;
    delegatorAddress: string;
    grossAmountSol: number;
    claimantAmountSol: number;
    delegatorFeeSol: number;
    mode: string;
    timestamp: number;
    createdAt: number;
}

export interface TreasuryEventInput {
    signature: string;
    amountSol: number;
    depositorAddress?: string;
    observedTotalDepositsSol?: number;
    slot?: number;
    timestamp?: number;
}

export function getMeta(key: string): string | null {
    return db.metadata.select().where({ key }).get()?.value ?? null;
}

export function setMeta(key: string, value: string | number) {
    db.metadata.upsert({ key }, { key, value: String(value) });
}

export function getMetaNumber(key: string, fallback = 0): number {
    const value = getMeta(key);
    if (!value) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function upsertHolderSnapshot(input: HolderSnapshotInput): HolderRecord {
    const now = input.now ?? Date.now();
    const existing = getHolder(input.address);

    const row: HolderRecord = {
        address: input.address,
        tokenBalance: input.tokenBalance,
        tokenValueUsd: input.tokenValueUsd,
        accumulatedGravity: existing?.accumulatedGravity ?? 0,
        totalSolRewardsEarned: existing?.totalSolRewardsEarned ?? 0,
        totalSolRewardsClaimed: existing?.totalSolRewardsClaimed ?? 0,
        claimableSolRewards: existing?.claimableSolRewards ?? 0,
        delegatedClaimsEnabled: existing?.delegatedClaimsEnabled ?? true,
        lastHoldingUpdate: now,
        lastGravityUpdate: existing?.lastGravityUpdate ?? now,
        updatedAt: now
    };

    db.holders.upsert({ address: input.address }, row);
    return getHolder(input.address) ?? row;
}

export function getHolder(address: string): HolderRecord | null {
    return db.holders.select().where({ address }).get() as HolderRecord | null;
}

export function getAllHolders(): HolderRecord[] {
    return db.holders.select()
        .where({ $or: [{ tokenBalance: { $gt: 0 } }, { accumulatedGravity: { $gt: 0 } }] })
        .orderBy('accumulatedGravity', 'desc')
        .all() as HolderRecord[];
}

export function getLeaderboard(limit?: number): HolderRecord[] {
    const query = db.holders.select()
        .where({ $or: [{ tokenBalance: { $gt: 0 } }, { accumulatedGravity: { $gt: 0 } }] })
        .orderBy('accumulatedGravity', 'desc');

    if (typeof limit === 'number') {
        return query.limit(limit).all() as HolderRecord[];
    }

    return query.all() as HolderRecord[];
}

export function getHolderRank(address: string): number | null {
    const holders = getLeaderboard();
    const index = holders.findIndex((holder) => holder.address.toLowerCase() === address.toLowerCase());
    return index >= 0 ? index + 1 : null;
}

export function updateGravityForIndexedHolders(now = Date.now()) {
    const holders = getAllHolders();
    let updated = 0;

    for (const holder of holders) {
        const elapsedMinutes = Math.max(0, (now - holder.lastGravityUpdate) / 60000);
        if (elapsedMinutes < 1) continue;

        const gravityBase = holder.tokenValueUsd > 0 ? holder.tokenValueUsd : holder.tokenBalance;
        const gravityAdded = gravityBase * elapsedMinutes;

        db.holders.update(holder.id as number, {
            accumulatedGravity: holder.accumulatedGravity + gravityAdded,
            lastGravityUpdate: now,
            updatedAt: now
        });
        updated++;
    }

    return { updated, timestamp: now };
}

export function getTotalAccumulatedGravity() {
    return getAllHolders().reduce((sum, holder) => sum + holder.accumulatedGravity, 0);
}

export function getTotalClaimedSol() {
    return getAllHolders().reduce((sum, holder) => sum + holder.totalSolRewardsClaimed, 0);
}

export function zeroMissingHolderBalances(activeAddresses: Set<string>, now = Date.now()) {
    const holders = getAllHolders();
    for (const holder of holders) {
        if (activeAddresses.has(holder.address.toLowerCase())) continue;
        if (!holder.id) continue;
        if (holder.tokenBalance === 0 && holder.tokenValueUsd === 0) continue;

        db.holders.update(holder.id, {
            tokenBalance: 0,
            tokenValueUsd: 0,
            lastHoldingUpdate: now,
            updatedAt: now
        });
    }
}

export function resetExcludedHolders(excludedAddresses: Set<string>, now = Date.now()) {
    if (excludedAddresses.size === 0) return;

    const holders = getAllHolders();
    for (const holder of holders) {
        if (!holder.id) continue;
        if (!excludedAddresses.has(holder.address.toLowerCase())) continue;

        db.holders.update(holder.id, {
            tokenBalance: 0,
            tokenValueUsd: 0,
            accumulatedGravity: 0,
            totalSolRewardsEarned: 0,
            totalSolRewardsClaimed: 0,
            claimableSolRewards: 0,
            delegatedClaimsEnabled: true,
            lastHoldingUpdate: now,
            lastGravityUpdate: now,
            updatedAt: now
        });
    }
}

export function distributeTreasuryFees(params: {
    events: TreasuryEventInput[];
    now?: number;
}) {
    const now = params.now ?? Date.now();
    if (params.events.length === 0) {
        return {
            distributed: 0,
            totalGravity: getTotalAccumulatedGravity()
        };
    }

    const gravityHolders = getAllHolders().filter((holder) => holder.accumulatedGravity > 0);
    const totalGravity = gravityHolders.reduce((sum, holder) => sum + holder.accumulatedGravity, 0);
    if (totalGravity <= 0) {
        return { distributed: 0, totalGravity };
    }

    const minimumEligibleGravity = totalGravity * MIN_DISTRIBUTION_GRAVITY_SHARE;
    const holders = gravityHolders.filter((holder) => holder.accumulatedGravity >= minimumEligibleGravity);
    if (holders.length === 0) {
        return { distributed: 0, totalGravity };
    }

    const holderState = new Map<string, HolderRecord>(
        holders.map((holder) => [holder.address.toLowerCase(), { ...holder }])
    );

    let distributed = 0;

    for (const event of params.events) {
        if (event.amountSol <= 0) continue;

        db.treasuryEvents.upsert(
            { signature: event.signature },
            {
                signature: event.signature,
                amountSol: event.amountSol,
                depositorAddress: event.depositorAddress ?? '',
                observedTotalDepositsSol: event.observedTotalDepositsSol ?? 0,
                slot: event.slot ?? 0,
                timestamp: event.timestamp ?? now,
                createdAt: now,
            }
        );

        for (const holder of holders) {
            const current = holderState.get(holder.address.toLowerCase());
            if (!current?.id) continue;

            const earnedDelta = event.amountSol * (current.accumulatedGravity / totalGravity);
            const totalEarned = current.totalSolRewardsEarned + earnedDelta;
            const claimable = Math.max(0, totalEarned - current.totalSolRewardsClaimed);

            db.holders.update(current.id, {
                totalSolRewardsEarned: totalEarned,
                claimableSolRewards: claimable,
                updatedAt: now
            });

            current.totalSolRewardsEarned = totalEarned;
            current.claimableSolRewards = claimable;

            db.treasuryPayouts.upsert(
                { signature: event.signature, address: current.address },
                {
                    signature: event.signature,
                    address: current.address,
                    amountSol: earnedDelta,
                    createdAt: now,
                }
            );
        }

        distributed += event.amountSol;
        const observedTotalDepositsSol = event.observedTotalDepositsSol ?? 0;
        if (observedTotalDepositsSol > 0) {
            setMeta('lastObservedTotalDepositsSol', observedTotalDepositsSol);
        }
    }

    return {
        distributed,
        totalGravity
    };
}

export function getRecentTreasuryEvents(limit = 25, walletAddress?: string) {
    const events = db.treasuryEvents.select()
        .orderBy('timestamp', 'desc')
        .limit(limit)
        .all() as TreasuryEventRecord[];

    const walletLower = walletAddress?.toLowerCase();
    return events.map((event) => {
        let payoutAmountSol = 0;
        if (walletLower) {
            const payout = db.treasuryPayouts.select().where({
                signature: event.signature,
                address: walletAddress as string
            }).get() as TreasuryPayoutRecord | undefined;
            payoutAmountSol = payout?.amountSol ?? 0;
        }

        return {
            ...event,
            payoutAmountSol
        };
    });
}

export function updateHolderRewards(
    address: string,
    rewards: Partial<Pick<HolderRecord, 'totalSolRewardsEarned' | 'totalSolRewardsClaimed' | 'claimableSolRewards' | 'delegatedClaimsEnabled'>>
) {
    const holder = getHolder(address);
    if (!holder?.id) return null;

    db.holders.update(holder.id, {
        ...rewards,
        updatedAt: Date.now()
    });

    return getHolder(address);
}

export function recordClaimEvent(event: {
    signature: string;
    claimantAddress: string;
    delegatorAddress?: string;
    grossAmountSol: number;
    claimantAmountSol: number;
    delegatorFeeSol?: number;
    mode: 'direct' | 'delegated' | 'delegated-batch-tokenized';
    timestamp?: number;
}) {
    const now = Date.now();
    db.claimEvents.upsert(
        { signature: event.signature, claimantAddress: event.claimantAddress },
        {
            signature: event.signature,
            claimantAddress: event.claimantAddress,
            delegatorAddress: event.delegatorAddress ?? '',
            grossAmountSol: event.grossAmountSol,
            claimantAmountSol: event.claimantAmountSol,
            delegatorFeeSol: event.delegatorFeeSol ?? 0,
            mode: event.mode,
            timestamp: event.timestamp ?? now,
            createdAt: now,
        }
    );
}

export function getRecentClaimEvents(limit = 50, walletAddress?: string) {
    const query = db.claimEvents.select().orderBy('timestamp', 'desc');
    const events = (typeof limit === 'number' ? query.limit(limit) : query).all() as ClaimEventRecord[];
    if (!walletAddress) return events;

    const walletLower = walletAddress.toLowerCase();
    return events.filter((event) =>
        event.claimantAddress.toLowerCase() === walletLower
        || event.delegatorAddress.toLowerCase() === walletLower
    );
}

export function getAllClaimEvents() {
    return db.claimEvents.select()
        .orderBy('timestamp', 'asc')
        .all() as ClaimEventRecord[];
}

export function resetAllHolderRewards(now = Date.now()) {
    const holders = db.holders.select().all() as HolderRecord[];
    for (const holder of holders) {
        if (!holder.id) continue;
        db.holders.update(holder.id, {
            totalSolRewardsEarned: 0,
            totalSolRewardsClaimed: 0,
            claimableSolRewards: 0,
            delegatedClaimsEnabled: holder.delegatedClaimsEnabled,
            updatedAt: now
        });
    }
}

export function recomputeTreasuryDistributionsFromStoredEvents(now = Date.now()) {
    const holders = db.holders.select().all() as HolderRecord[];
    for (const holder of holders) {
        if (!holder.id) continue;
        db.holders.update(holder.id, {
            totalSolRewardsEarned: 0,
            claimableSolRewards: Math.max(0, 0 - holder.totalSolRewardsClaimed),
            updatedAt: now
        });
    }

    const raw = new BunDatabase(dbPath, { create: true });
    try {
        raw.exec('DELETE FROM treasuryPayouts');
    } finally {
        raw.close();
    }

    const events = db.treasuryEvents.select()
        .orderBy('timestamp', 'asc')
        .all() as TreasuryEventRecord[];

    return distributeTreasuryFees({
        events: events.map((event) => ({
            signature: event.signature,
            amountSol: event.amountSol,
            depositorAddress: event.depositorAddress,
            observedTotalDepositsSol: event.observedTotalDepositsSol,
            slot: event.slot,
            timestamp: event.timestamp,
        })),
        now
    });
}
