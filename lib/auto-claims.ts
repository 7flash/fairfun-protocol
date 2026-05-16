import { measure } from 'measure-fn';
import { PublicKey } from '@solana/web3.js';
import { config } from './config';
import { getMetaNumber, getRecentClaimEvents, getLeaderboard, recordClaimEvent, updateHolderRewards } from './database';
import {
    claimSigningEnabled,
    fetchUserClaimState,
    lamportsToSolNumber,
    loadBackendKeypair,
    prepareClaimAmounts,
    solToLamportsBigInt,
} from './fairfun-program';
import { sendSignedDelegatedTokenClaimTransaction } from './tokenized-claims';

let running = false;

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
        return await measure('Run automatic reward claim pass', async () => {
            const holders = getEligibleHolders();
            if (holders.length === 0) {
                return { attempted: false, completed: false, reason: 'no-eligible-holder' };
            }

            const backend = loadBackendKeypair();
            const observedTotalDepositsLamports = solToLamportsBigInt(getMetaNumber('totalFeesAccumulatedSol'));

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

                const transactionResult = await sendSignedDelegatedTokenClaimTransaction(
                    backend,
                    claimant,
                    preparedClaim.cumulativeEarned,
                    preparedClaim.observedTotalDeposits,
                    preparedClaim.estimatedClaimableLamports,
                );

                const refreshedClaimState = await fetchClaimStateWithRetry(claimant);
                if (!refreshedClaimState) {
                    throw new Error(`Claim state missing after successful claim for ${holder.address}`);
                }

                const totalClaimedSol = lamportsToSolNumber(refreshedClaimState.claimedAmount);
                const grossAmountSol = Math.max(0, totalClaimedSol - previousClaimedSol);
                const nextClaimable = Math.max(0, holder.totalSolRewardsEarned - totalClaimedSol);
                updateHolderRewards(holder.address, {
                    totalSolRewardsClaimed: totalClaimedSol,
                    claimableSolRewards: nextClaimable,
                });
                if (grossAmountSol > 0) {
                    recordClaimEvent({
                        signature: transactionResult.signature,
                        claimantAddress: holder.address,
                        delegatorAddress: backend.publicKey.toBase58(),
                        grossAmountSol,
                        claimantAmountSol: grossAmountSol * 0.9,
                        delegatorFeeSol: grossAmountSol * 0.1,
                        mode: 'delegated',
                        timestamp: now,
                    });
                }

                return {
                    attempted: true,
                    completed: true,
                    claimantAddress: holder.address,
                    signature: transactionResult.signature,
                    grossAmountSol,
                    lookupTableAddress: transactionResult.lookupTableAddress,
                    minimumTokenAmountOut: transactionResult.minimumTokenAmountOut,
                    recentClaimsSeen: getRecentClaimEvents(1).length,
                };
            }

            return { attempted: false, completed: false, reason: 'claim-no-longer-eligible' };
        });
    } finally {
        running = false;
    }
}
