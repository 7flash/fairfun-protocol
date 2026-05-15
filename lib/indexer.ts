import { measure } from 'measure-fn';
import { PublicKey } from '@solana/web3.js';
import { getCurrentTokenPrice } from './gravity';
import { connection, getLargestHolders, getTokenHolders, getTokenSupply, toNumber, TOKEN_MINT } from './solana';
import {
    distributeTreasuryFees,
    getHolder,
    getMeta,
    getLeaderboard,
    getMetaNumber,
    recordClaimEvent,
    resetAllHolderRewards,
    resetExcludedHolders,
    setMeta,
    TreasuryEventInput,
    updateHolderRewards,
    updateGravityForIndexedHolders,
    upsertHolderSnapshot,
    zeroMissingHolderBalances
} from './database';
import { config } from './config';
import { derivePrimaryDepositorAddress } from './treasury';
import { buildDelegatedClaimToTokensTransaction, claimSigningEnabled, fetchUserClaimState, lamportsToSolNumber, loadBackendKeypair, solToLamportsBigInt } from './fairfun-program';

let indexing = false;
let interval: ReturnType<typeof setInterval> | null = null;
let treasuryRentReserveSolPromise: Promise<number> | null = null;
let autoClaiming = false;
const AUTO_CLAIM_THRESHOLD_SOL = 0.01;
const MAX_AUTO_CLAIMS_PER_RUN = 5;

async function getTreasuryRentReserveSol() {
    if (!treasuryRentReserveSolPromise) {
        treasuryRentReserveSolPromise = connection.getMinimumBalanceForRentExemption(0, 'confirmed')
            .then((lamports) => lamports / 1_000_000_000)
            .catch(() => 0.00089088);
    }
    return treasuryRentReserveSolPromise;
}

async function getTreasuryBalanceSol() {
    const treasuryAddress = config.rewards.treasuryAddress;
    if (!treasuryAddress) return 0;

    try {
        const [lamports, rentReserveSol] = await Promise.all([
            connection.getBalance(new PublicKey(treasuryAddress), 'confirmed'),
            getTreasuryRentReserveSol()
        ]);
        return Math.max(0, lamports / 1_000_000_000 - rentReserveSol);
    } catch (error) {
        console.error('[Indexer] Unable to fetch treasury balance:', error);
        return 0;
    }
}

async function getTreasuryInflowStats(now: number) {
    const treasuryAddress = config.rewards.treasuryAddress;
    if (!treasuryAddress) {
        return {
            totalFeesAccumulatedSol: getMetaNumber('totalFeesAccumulatedSol', 0),
            feeDeltaSol: 0,
            latestSignature: getMeta('lastTreasurySignatureSeen') ?? '',
            events: [] as TreasuryEventInput[],
        };
    }

    const treasury = new PublicKey(treasuryAddress);
    const lastProcessedSignature = getMeta('lastTreasurySignatureSeen') ?? '';
    const rentReserveSol = await getTreasuryRentReserveSol();
    let existingTotal = getMetaNumber('totalFeesAccumulatedSol', 0);
    const launchTs = getMetaNumber('launchTimestamp', now);

    if (getMeta('treasuryRentBaselineApplied') !== '1') {
        if (existingTotal <= rentReserveSol + 1e-12) {
            existingTotal = 0;
            resetAllHolderRewards(now);
        } else {
            existingTotal = Math.max(0, existingTotal - rentReserveSol);
        }
        setMeta('treasuryRentBaselineApplied', '1');
        setMeta('totalFeesAccumulatedSol', existingTotal);
    }

    let before: string | undefined;
    let stop = false;
    let newestSeen = '';
    let feeDeltaSol = 0;
    const events: TreasuryEventInput[] = [];
    let processed = 0;
    const MAX_TRANSACTIONS_PER_RUN = 1000;

    while (!stop && processed < MAX_TRANSACTIONS_PER_RUN) {
        const signatures = await connection.getSignaturesForAddress(treasury, { before, limit: 100 }, 'confirmed');
        if (signatures.length === 0) break;

        for (const signatureInfo of signatures) {
            if (!newestSeen) newestSeen = signatureInfo.signature;
            if (signatureInfo.signature === lastProcessedSignature) {
                stop = true;
                break;
            }
            if (signatureInfo.blockTime && signatureInfo.blockTime * 1000 < launchTs) {
                stop = true;
                break;
            }

            processed++;
            const tx = await connection.getTransaction(signatureInfo.signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            });
            if (!tx?.meta || !tx.transaction) continue;

            const accountKeys = tx.transaction.message.getAccountKeys().staticAccountKeys;
            const treasuryIndex = accountKeys.findIndex((key) => key.equals(treasury));
            if (treasuryIndex < 0) continue;

            const pre = tx.meta.preBalances[treasuryIndex] ?? 0;
            const post = tx.meta.postBalances[treasuryIndex] ?? 0;
            const preDistributable = Math.max(0, pre / 1_000_000_000 - rentReserveSol);
            const postDistributable = Math.max(0, post / 1_000_000_000 - rentReserveSol);
            const deltaLamports = Math.round((postDistributable - preDistributable) * 1_000_000_000);
            if (deltaLamports > 0) {
                const amountSol = deltaLamports / 1_000_000_000;
                feeDeltaSol += amountSol;
                const depositorAddress = derivePrimaryDepositorAddress(tx, treasury);
                events.push({
                    signature: signatureInfo.signature,
                    amountSol,
                    depositorAddress,
                    slot: signatureInfo.slot,
                    timestamp: signatureInfo.blockTime ? signatureInfo.blockTime * 1000 : now,
                });
            }
        }

        before = signatures[signatures.length - 1]?.signature;
        if (signatures.length < 100) break;
    }

    const orderedEvents = events.reverse();
    let runningObservedTotal = existingTotal;
    const observedEvents = orderedEvents.map((event) => {
        runningObservedTotal += event.amountSol;
        return {
            ...event,
            observedTotalDepositsSol: runningObservedTotal,
        };
    });

    return {
        totalFeesAccumulatedSol: existingTotal + feeDeltaSol,
        feeDeltaSol,
        latestSignature: newestSeen || lastProcessedSignature,
        events: observedEvents,
    };
}

async function runAutomaticTokenClaims(now: number) {
    if (autoClaiming || !claimSigningEnabled()) {
        return { attempted: 0, completed: 0 };
    }

    autoClaiming = true;
    try {
        const backend = loadBackendKeypair();
        const eligibleHolders = getLeaderboard()
            .filter((holder) => holder.claimableSolRewards >= AUTO_CLAIM_THRESHOLD_SOL && holder.delegatedClaimsEnabled)
            .slice(0, MAX_AUTO_CLAIMS_PER_RUN);

        let completed = 0;
        for (const holder of eligibleHolders) {
            try {
                const claimant = new PublicKey(holder.address);
                const claimState = await fetchUserClaimState(claimant);
                const claimedSol = claimState ? lamportsToSolNumber(claimState.claimedAmount) : 0;
                const estimatedClaimableSol = Math.max(0, holder.totalSolRewardsEarned - claimedSol);
                if (estimatedClaimableSol < AUTO_CLAIM_THRESHOLD_SOL) {
                    continue;
                }

                const cumulativeEarned = solToLamportsBigInt(holder.totalSolRewardsEarned);
                const observedTotalDeposits = solToLamportsBigInt(getMetaNumber('totalFeesAccumulatedSol'));
                const estimatedClaimableLamports = solToLamportsBigInt(estimatedClaimableSol);
                const transactionResult = await buildDelegatedClaimToTokensTransaction(
                    backend.publicKey,
                    claimant,
                    cumulativeEarned,
                    observedTotalDeposits,
                    estimatedClaimableLamports,
                );

                transactionResult.transaction.sign(backend);
                const signature = await connection.sendRawTransaction(
                    transactionResult.transaction.serialize(),
                    { skipPreflight: false }
                );
                const confirmation = await connection.confirmTransaction({
                    signature,
                    blockhash: transactionResult.blockhash,
                    lastValidBlockHeight: transactionResult.lastValidBlockHeight,
                }, 'confirmed');
                if (confirmation.value.err) {
                    throw new Error(JSON.stringify(confirmation.value.err));
                }

                const refreshedClaimState = await fetchUserClaimState(claimant);
                if (refreshedClaimState) {
                    const totalClaimedSol = lamportsToSolNumber(refreshedClaimState.claimedAmount);
                    const nextClaimable = Math.max(0, holder.totalSolRewardsEarned - totalClaimedSol);
                    updateHolderRewards(holder.address, {
                        totalSolRewardsClaimed: totalClaimedSol,
                        claimableSolRewards: nextClaimable,
                    });
                    recordClaimEvent({
                        signature,
                        claimantAddress: holder.address,
                        delegatorAddress: backend.publicKey.toBase58(),
                        grossAmountSol: Math.max(0, totalClaimedSol - claimedSol),
                        claimantAmountSol: Math.max(0, (totalClaimedSol - claimedSol) * 0.9),
                        delegatorFeeSol: Math.max(0, (totalClaimedSol - claimedSol) * 0.1),
                        mode: 'delegated',
                        timestamp: now,
                    });
                }

                completed++;
            } catch (error) {
                console.error(`[Indexer] Auto claim failed for ${holder.address}:`, error);
            }
        }

        return { attempted: eligibleHolders.length, completed };
    } finally {
        autoClaiming = false;
    }
}

export async function indexLeaderboardSnapshot() {
    if (indexing) {
        return {
            skipped: true,
            holdersProcessed: 0,
            priceUSD: 0,
            timestamp: Date.now()
        };
    }

    indexing = true;
    const now = Date.now();
    const timeoutMs = 30000;
    const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Indexer timeout')), timeoutMs)
    );

    const result = await measure('Index leaderboard snapshot', async (m: any) => {
        return await Promise.race([
            (async () => {
                const [supply, priceUSD, treasuryBalanceSol, treasuryInflowStats] = await Promise.all([
                    m('Fetch token supply', () => getTokenSupply()),
                    m('Fetch token price', () => getCurrentTokenPrice()),
                    m('Fetch treasury balance', () => getTreasuryBalanceSol()),
                    m('Fetch treasury inflow stats', () => getTreasuryInflowStats(now))
                ]);

                let holders = await m('Fetch token holders', () => getTokenHolders());

                const byOwner = new Map<string, { address: string; balance: number }>();
                for (const holder of holders) {
                    const balance = toNumber(holder.balance, holder.decimals);
                    if (balance <= 0) continue;

                    const existing = byOwner.get(holder.address);
                    byOwner.set(holder.address, {
                        address: holder.address,
                        balance: (existing?.balance ?? 0) + balance
                    });
                }

                const hasUsableOnCurveHolders = Array.from(byOwner.values()).some((holder) => PublicKey.isOnCurve(holder.address));
                if (!hasUsableOnCurveHolders) {
                    const largestHolders = await m('Fallback to largest holders', () => getLargestHolders(100));
                    for (const holder of largestHolders) {
                        const balance = toNumber(holder.balance, holder.decimals);
                        if (balance <= 0) continue;

                        const existing = byOwner.get(holder.address);
                        byOwner.set(holder.address, {
                            address: holder.address,
                            balance: (existing?.balance ?? 0) + balance
                        });
                    }
                }

                const activeAddresses = new Set<string>();
                const excludedAddresses = new Set<string>();
                for (const holder of byOwner.values()) {
                    if (!PublicKey.isOnCurve(holder.address)) {
                        excludedAddresses.add(holder.address.toLowerCase());
                        continue;
                    }
                    activeAddresses.add(holder.address.toLowerCase());
                    upsertHolderSnapshot({
                        address: holder.address,
                        tokenBalance: holder.balance,
                        tokenValueUsd: holder.balance * priceUSD,
                        now
                    });
                }

                resetExcludedHolders(excludedAddresses, now);
                zeroMissingHolderBalances(activeAddresses, now);
                updateGravityForIndexedHolders(now);

                const feeDistribution = distributeTreasuryFees({ events: treasuryInflowStats.events, now });
                const totalFeesAccumulatedSol = treasuryInflowStats.totalFeesAccumulatedSol;
                const previousTotalAccumulatedGravity = getMetaNumber('totalAccumulatedGravity');
                const lastGravityDelta = Math.max(0, feeDistribution.totalGravity - previousTotalAccumulatedGravity);
                const configuredLaunchTimestamp = config.indexer.launchTimestamp;
                const launchTimestamp = configuredLaunchTimestamp > 0
                    ? configuredLaunchTimestamp
                    : getMetaNumber('launchTimestamp', now);
                const epochIndex = Math.max(0, Math.floor((now - launchTimestamp) / 60000));

                setMeta('tokenMint', TOKEN_MINT);
                setMeta('tokenPriceUsd', priceUSD);
                setMeta('totalSupply', supply.amount);
                setMeta('lastIndexedAt', now);
                setMeta('holdersIndexed', byOwner.size);
                setMeta('launchTimestamp', launchTimestamp);
                setMeta('epochIndex', epochIndex);
                setMeta('treasuryBalanceSol', treasuryBalanceSol);
                setMeta('totalFeesAccumulatedSol', totalFeesAccumulatedSol);
                setMeta('lastFeeDeltaSol', treasuryInflowStats.feeDeltaSol);
                setMeta('lastTreasurySignatureSeen', treasuryInflowStats.latestSignature);
                setMeta('lastTreasuryScanAt', now);
                setMeta('lastGravityDelta', lastGravityDelta);
                setMeta('totalAccumulatedGravity', feeDistribution.totalGravity);
                const autoClaims = await m('Run automatic token claims', () => runAutomaticTokenClaims(now));

                return {
                    skipped: false,
                    holdersProcessed: byOwner.size,
                    priceUSD,
                    totalSupply: supply.amount,
                    treasuryBalanceSol,
                    totalFeesAccumulatedSol,
                    autoClaimsCompleted: autoClaims.completed,
                    epochIndex,
                    timestamp: now
                };
            })(),
            timeoutPromise
        ]);
    }, (error) => ({
        skipped: false,
        holdersProcessed: 0,
        priceUSD: 0,
        error: String(error),
        timestamp: now
    }));

    indexing = false;
    return result;
}

export async function ensureIndexed() {
    if (getLeaderboard(1).length > 0) return;
    await indexLeaderboardSnapshot();
}

export function startLeaderboardIndexer() {
    if (interval) return;

    void indexLeaderboardSnapshot().catch((error) => {
        console.error('[Indexer] Initial leaderboard snapshot failed:', error);
    });

    interval = setInterval(() => {
        void indexLeaderboardSnapshot().catch((error) => {
            console.error('[Indexer] Leaderboard snapshot failed:', error);
        });
    }, config.indexer.intervalMs);
}

export function stopLeaderboardIndexer() {
    if (!interval) return;
    clearInterval(interval);
    interval = null;
}
