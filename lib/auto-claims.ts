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

function getEligibleHolder() {
    const threshold = config.claimer.minClaimSol;
    return getLeaderboard()
        .filter((holder) => holder.delegatedClaimsEnabled && holder.claimableSolRewards >= threshold)
        .sort((a, b) => b.claimableSolRewards - a.claimableSolRewards)[0] ?? null;
}

export async function runAutomaticRewardClaimPass(now = Date.now()) {
    if (running || !claimSigningEnabled()) {
        return { attempted: false, completed: false, reason: running ? 'already-running' : 'signing-disabled' };
    }

    running = true;
    try {
        return await measure('Run automatic reward claim pass', async () => {
            const holder = getEligibleHolder();
            if (!holder) {
                return { attempted: false, completed: false, reason: 'no-eligible-holder' };
            }

            const backend = loadBackendKeypair();
            const claimant = new PublicKey(holder.address);
            const preparedClaim = await prepareClaimAmounts(
                claimant,
                solToLamportsBigInt(holder.totalSolRewardsEarned),
                solToLamportsBigInt(getMetaNumber('totalFeesAccumulatedSol')),
            );
            const previousClaimedSol = lamportsToSolNumber(preparedClaim.claimedAmount);
            const estimatedClaimableSol = lamportsToSolNumber(preparedClaim.estimatedClaimableLamports);

            if (
                !preparedClaim.poolActive
                || estimatedClaimableSol < config.claimer.minClaimSol
                || preparedClaim.cumulativeEarned <= preparedClaim.claimedAmount
            ) {
                return { attempted: false, completed: false, reason: 'claim-no-longer-eligible' };
            }

            const transactionResult = await sendSignedDelegatedTokenClaimTransaction(
                backend,
                claimant,
                preparedClaim.cumulativeEarned,
                preparedClaim.observedTotalDeposits,
                preparedClaim.estimatedClaimableLamports,
            );

            const refreshedClaimState = await fetchUserClaimState(claimant);
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

            return {
                attempted: true,
                completed: true,
                claimantAddress: holder.address,
                signature: transactionResult.signature,
                lookupTableAddress: transactionResult.lookupTableAddress,
                minimumTokenAmountOut: transactionResult.minimumTokenAmountOut,
                recentClaimsSeen: getRecentClaimEvents(1).length,
            };
        });
    } finally {
        running = false;
    }
}
