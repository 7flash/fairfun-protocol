import { measure } from 'measure-fn';
import { PublicKey } from '@solana/web3.js';
import { config } from './config';
import { getMetaNumber, getRecentClaimEvents, getLeaderboard, recordClaimEvent, setMeta, updateHolderRewards } from './database';
import {
    claimSigningEnabled,
    fetchUserClaimState,
    lamportsToSolNumber,
    loadBackendKeypair,
    prepareClaimAmounts,
    solToLamportsBigInt,
} from './fairfun-program';
import { sendSignedDelegatedTokenBatchClaimTransaction } from './tokenized-claims';

let running = false;
const SAFE_MAX_TOKENIZED_BATCH_CLAIMANTS = 4;
function getMaxBatchClaimants() {
  const value = Math.floor(Number(config.claimer.maxBatchClaimants ?? 3));
  return Math.max(1, Math.min(SAFE_MAX_TOKENIZED_BATCH_CLAIMANTS, value));
}

function getMinBatchClaimants() {
  const value = Math.floor(Number(config.claimer.minBatchClaimants ?? 1));
  return Math.max(1, Math.min(getMaxBatchClaimants(), value));
}

function persistClaimerAttemptStatus(input: {
    now: number;
    status: 'running' | 'succeeded' | 'skipped' | 'failed';
    reason: string;
    claimantCount?: number;
    signature?: string | null;
}) {
    setMeta('claimerLastAttemptAt', input.now);
    setMeta('claimerLastAttemptStatus', input.status);
    setMeta('claimerLastAttemptReason', input.reason);
    setMeta('claimerLastAttemptClaimantCount', input.claimantCount ?? 0);
    setMeta('claimerLastAttemptSignature', input.signature ?? '');

    if (input.status === 'running') {
        setMeta('claimerCurrentRunStartedAt', input.now);
        return;
    }

    setMeta('claimerCurrentRunStartedAt', 0);
    if (input.status === 'succeeded') {
        setMeta('claimerLastSuccessAt', input.now);
    }
    if (input.status === 'failed') {
        setMeta('claimerLastFailureAt', input.now);
    }
}

function getEligibleHolders() {
    const threshold = config.claimer.minClaimSol;
    return getLeaderboard()
        .filter((holder) => holder.delegatedClaimsEnabled && holder.claimableSolRewards >= threshold)
        .sort((a, b) => b.claimableSolRewards - a.claimableSolRewards);
}

export function getClaimerPressureSnapshot() {
    const eligibleHolders = getEligibleHolders();
    const treasuryBalanceSol = getMetaNumber('treasuryBalanceSol', 0);
    const eligibleClaimableSol = eligibleHolders.reduce((sum, holder) => sum + holder.claimableSolRewards, 0);
    const coverageRatio = eligibleClaimableSol > 0 ? treasuryBalanceSol / eligibleClaimableSol : 0;
    return {
        treasuryBalanceSol,
        eligibleHolderCount: eligibleHolders.length,
        eligibleClaimableSol,
        coverageRatio,
    };
}

export function getRecommendedClaimerIntervalMs() {
    const baseIntervalMs = config.claimer.intervalMs;
    const thresholdSol = config.claimer.minClaimSol;
    const snapshot = getClaimerPressureSnapshot();

    let intervalMs = baseIntervalMs;
    if (snapshot.eligibleHolderCount === 0) {
        intervalMs = Math.max(baseIntervalMs, 15 * 60_000);
    } else if (snapshot.treasuryBalanceSol < thresholdSol) {
        intervalMs = Math.max(baseIntervalMs, 45 * 60_000);
    } else if (snapshot.coverageRatio < 0.15) {
        intervalMs = Math.max(baseIntervalMs, 30 * 60_000);
    } else if (snapshot.coverageRatio < 0.35) {
        intervalMs = Math.max(baseIntervalMs, 20 * 60_000);
    } else if (snapshot.coverageRatio < 0.75) {
        intervalMs = Math.max(baseIntervalMs, 10 * 60_000);
    }

    return {
        intervalMs,
        ...snapshot,
    };
}

async function fetchClaimStateWithRetry(claimant: PublicKey, attempts = 5, delayMs = 1200) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const claimState = await fetchUserClaimState(claimant);
        if (claimState) return claimState;
        if (attempt < attempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    return null;
}

export async function runAutomaticRewardClaimPass(now = Date.now()) {
    if (running || !claimSigningEnabled()) {
        return { attempted: false, completed: false, reason: running ? 'already-running' : 'signing-disabled' };
    }

    running = true;
    try {
        persistClaimerAttemptStatus({
            now,
            status: 'running',
            reason: 'started',
        });
        return await measure('Run automatic reward claim pass', async () => {
            const finalize = <T extends { attempted: boolean; completed: boolean; reason?: string; claimantCount?: number; signature?: string | null }>(result: T) => {
                persistClaimerAttemptStatus({
                    now,
                    status: result.attempted && result.completed ? 'succeeded' : 'skipped',
                    reason: result.reason ?? (result.attempted && result.completed ? 'completed' : 'skipped'),
                    claimantCount: result.claimantCount,
                    signature: result.signature ?? null,
                });
                return result;
            };

            let holders = getEligibleHolders();
            if (holders.length === 0) {
                return finalize({ attempted: false, completed: false, reason: 'no-eligible-holder' });
            }
            holders = holders.slice(0, getMaxBatchClaimants());

            const backend = loadBackendKeypair();
            const observedTotalDepositsLamports = solToLamportsBigInt(getMetaNumber('totalFeesAccumulatedSol'));
            const batchEntries: Array<{
                holder: ReturnType<typeof getEligibleHolders>[number];
                claimant: PublicKey;
                cumulativeEarned: bigint;
                observedTotalDeposits: bigint;
                estimatedClaimableLamports: bigint;
                previousClaimedSol: number;
            }> = [];

            for (const holder of holders) {
                const claimant = new PublicKey(holder.address);
                const preparedClaim = await prepareClaimAmounts(
                    claimant,
                    solToLamportsBigInt(holder.totalSolRewardsEarned),
                    observedTotalDepositsLamports,
                );
                const previousClaimedSol = lamportsToSolNumber(preparedClaim.claimedAmount);
                const estimatedClaimableSol = lamportsToSolNumber(preparedClaim.estimatedClaimableLamports);

                if (
                    !preparedClaim.poolActive
                    || estimatedClaimableSol < config.claimer.minClaimSol
                    || preparedClaim.cumulativeEarned <= preparedClaim.claimedAmount
                ) {
                    const reconciledClaimable = Math.max(0, holder.totalSolRewardsEarned - previousClaimedSol);
                    if (
                        Math.abs(holder.totalSolRewardsClaimed - previousClaimedSol) > 1e-9
                        || Math.abs(holder.claimableSolRewards - reconciledClaimable) > 1e-9
                    ) {
                        updateHolderRewards(holder.address, {
                            totalSolRewardsClaimed: previousClaimedSol,
                            claimableSolRewards: reconciledClaimable,
                        });
                    }
                    continue;
                }

                batchEntries.push({
                    holder,
                    claimant,
                    cumulativeEarned: preparedClaim.cumulativeEarned,
                    observedTotalDeposits: preparedClaim.observedTotalDeposits,
                    estimatedClaimableLamports: preparedClaim.estimatedClaimableLamports,
                    previousClaimedSol,
                });
                if (batchEntries.length >= getMaxBatchClaimants()) {
                    break;
                }
            }

            if (batchEntries.length === 0) {
                return finalize({ attempted: false, completed: false, reason: 'claim-no-longer-eligible' });
            }

            const transactionResult = await sendSignedDelegatedTokenBatchClaimTransaction(
                backend,
                batchEntries.map((entry) => ({
                    claimant: entry.claimant,
                    cumulativeEarned: entry.cumulativeEarned,
                    observedTotalDeposits: entry.observedTotalDeposits,
                    estimatedClaimableLamports: entry.estimatedClaimableLamports,
                })),
            );

            let totalGrossAmountSol = 0;
            for (const entry of batchEntries) {
                const refreshedClaimState = await fetchClaimStateWithRetry(entry.claimant);
                if (!refreshedClaimState) {
                    throw new Error(`Claim state missing after successful batch claim for ${entry.holder.address}`);
                }

                const totalClaimedSol = lamportsToSolNumber(refreshedClaimState.claimedAmount);
                const grossAmountSol = Math.max(0, totalClaimedSol - entry.previousClaimedSol);
                const nextClaimable = Math.max(0, entry.holder.totalSolRewardsEarned - totalClaimedSol);
                updateHolderRewards(entry.holder.address, {
                    totalSolRewardsClaimed: totalClaimedSol,
                    claimableSolRewards: nextClaimable,
                });
                if (grossAmountSol > 0) {
                    recordClaimEvent({
                        signature: transactionResult.signature,
                        claimantAddress: entry.holder.address,
                        delegatorAddress: backend.publicKey.toBase58(),
                        grossAmountSol,
                        claimantAmountSol: grossAmountSol * 0.9,
                        projectFeeSol: grossAmountSol * 0.1,
                        mode: 'delegated-batch-tokenized',
                        timestamp: now,
                    });
                }
                totalGrossAmountSol += grossAmountSol;
            }

            return finalize({
                attempted: true,
                completed: true,
                claimantCount: batchEntries.length,
                claimantAddresses: batchEntries.map((entry) => entry.holder.address),
                signature: transactionResult.signature,
                grossAmountSol: totalGrossAmountSol,
                lookupTableAddress: transactionResult.lookupTableAddress,
                minimumTokenAmountOut: transactionResult.minimumTokenAmountOut,
                totalEstimatedClaimableLamports: transactionResult.totalEstimatedClaimableLamports,
                recentClaimsSeen: getRecentClaimEvents(5).length,
            });
        });
    } catch (error) {
        persistClaimerAttemptStatus({
            now,
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
    } finally {
        running = false;
    }
}
