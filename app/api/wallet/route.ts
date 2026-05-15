import { measure } from 'measure-fn';
import { PublicKey } from '@solana/web3.js';
import { getHolder, getHolderRank, getMetaNumber } from '../../../lib/database';
import { formatAddress } from '../../../lib/solana';
import { formatGravity, formatSOL, formatUSD } from '../../../lib/gravity';
import { BASIS_POINTS_DENOMINATOR, DELEGATED_CLAIM_FEE_BPS, claimSigningEnabled, fetchUserDelegationSettingsState, lamportsToSolNumber, prepareClaimAmounts, solToLamportsBigInt } from '../../../lib/fairfun-program';

const LAMPORT_IN_SOL = 1_000_000_000;
const MIN_CLAIMABLE_SOL = 1 / LAMPORT_IN_SOL;

function clampSolAmount(value: number) {
    return Math.abs(value) < MIN_CLAIMABLE_SOL ? 0 : value;
}

export async function GET(req: Request) {
    return await measure('GET /api/wallet', async () => {
        const url = new URL(req.url);
        const address = url.searchParams.get('address');
        if (!address) {
            return Response.json({ success: false, error: 'Missing wallet address' }, { status: 400 });
        }

        const holder = getHolder(address);
        const totalAccumulatedGravity = getMetaNumber('totalAccumulatedGravity');
        if (!holder) {
            return Response.json({
                success: true,
                wallet: {
                    address,
                    addressShort: formatAddress(address),
                    rank: null,
                    tokenBalance: 0,
                    balanceFormatted: '0',
                    tokenValueUsd: 0,
                    tokenValueUsdFormatted: '$0.00',
                    accumulatedGravity: 0,
                    gravityFormatted: '0.00',
                    gravityShare: 0,
                    gravityShareFormatted: '0.000%',
                    totalSolRewardsEarned: 0,
                    totalSolRewardsEarnedFormatted: '0 SOL',
                    totalSolRewardsClaimed: 0,
                    totalSolRewardsClaimedFormatted: '0 SOL',
                    claimableSolRewards: 0,
                    claimableSolRewardsFormatted: '0 SOL',
                    delegatedClaimsEnabled: true,
                    delegatedClaimFeeBps: DELEGATED_CLAIM_FEE_BPS,
                    delegatedClaimFeePercent: DELEGATED_CLAIM_FEE_BPS / BASIS_POINTS_DENOMINATOR * 100,
                    claimEnabled: false,
                    claimDisabledReason: claimSigningEnabled()
                        ? 'No claimable rewards yet.'
                        : 'Backend signer keypair is not configured on the web process.'
                }
            });
        }

        let claimedSol = holder.totalSolRewardsClaimed;
        let claimableSol = holder.claimableSolRewards;
        let delegatedClaimsEnabled = holder.delegatedClaimsEnabled;
        let poolActive = true;

        try {
            const preparedClaim = await prepareClaimAmounts(
                new PublicKey(address),
                solToLamportsBigInt(holder.totalSolRewardsEarned),
                solToLamportsBigInt(getMetaNumber('totalFeesAccumulatedSol')),
            );
            poolActive = preparedClaim.poolActive;
            claimedSol = clampSolAmount(lamportsToSolNumber(preparedClaim.claimedAmount));
            claimableSol = clampSolAmount(lamportsToSolNumber(preparedClaim.estimatedClaimableLamports));
            const delegationSettings = await fetchUserDelegationSettingsState(new PublicKey(address));
            if (delegationSettings) {
                delegatedClaimsEnabled = delegationSettings.delegatedClaimsEnabled;
            }
        } catch {
            // Fall back to indexed claim state if the onchain read fails.
        }

        claimedSol = clampSolAmount(claimedSol);
        claimableSol = clampSolAmount(claimableSol);
        const claimConfigured = claimSigningEnabled();
        const claimEnabled = claimConfigured && poolActive && claimableSol > 0;

        return Response.json({
            success: true,
            wallet: {
                address: holder.address,
                addressShort: formatAddress(holder.address),
                rank: getHolderRank(holder.address),
                tokenBalance: holder.tokenBalance,
                balanceFormatted: holder.tokenBalance.toLocaleString(undefined, { maximumFractionDigits: 4 }),
                tokenValueUsd: holder.tokenValueUsd,
                tokenValueUsdFormatted: formatUSD(holder.tokenValueUsd),
                accumulatedGravity: holder.accumulatedGravity,
                gravityFormatted: formatGravity(holder.accumulatedGravity),
                gravityShare: totalAccumulatedGravity > 0 ? holder.accumulatedGravity / totalAccumulatedGravity * 100 : 0,
                gravityShareFormatted: totalAccumulatedGravity > 0
                    ? `${(holder.accumulatedGravity / totalAccumulatedGravity * 100).toFixed(3)}%`
                    : '0.000%',
                totalSolRewardsEarned: holder.totalSolRewardsEarned,
                totalSolRewardsEarnedFormatted: formatSOL(holder.totalSolRewardsEarned),
                totalSolRewardsClaimed: claimedSol,
                totalSolRewardsClaimedFormatted: formatSOL(claimedSol),
                claimableSolRewards: claimableSol,
                claimableSolRewardsFormatted: formatSOL(claimableSol),
                delegatedClaimsEnabled,
                delegatedClaimFeeBps: DELEGATED_CLAIM_FEE_BPS,
                delegatedClaimFeePercent: DELEGATED_CLAIM_FEE_BPS / BASIS_POINTS_DENOMINATOR * 100,
                claimEnabled,
                claimDisabledReason: claimEnabled
                    ? ''
                    : (!claimConfigured
                        ? 'Backend signer keypair is not configured on the web process.'
                        : (!poolActive ? 'Rewards pool is paused.' : 'No claimable rewards yet.'))
            }
        });
    }, (error) => {
        console.error('Error loading wallet totals:', error);
        return Response.json(
            { success: false, error: String(error), timestamp: Date.now() },
            { status: 500 }
        );
    });
}
