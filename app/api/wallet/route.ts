import { measure } from 'measure-fn';
import { getHolder, getHolderRank, getMetaNumber } from '../../../lib/database';
import { formatAddress } from '../../../lib/solana';
import { formatGravity, formatSOL, formatUSD } from '../../../lib/gravity';
import { config } from '../../../lib/config';

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
                    claimEnabled: false,
                    claimDisabledReason: config.rewards.claimApiUrl
                        ? 'No claimable rewards yet.'
                        : 'Claim signer not configured for this deployment.'
                }
            });
        }

        let claimedSol = holder.totalSolRewardsClaimed;
        let claimableSol = holder.claimableSolRewards;

        if (config.rewards.claimApiUrl) {
            try {
                const earningsResponse = await fetch(`${config.rewards.claimApiUrl}/api/earnings/${address}`);
                if (earningsResponse.ok) {
                    const earnings = await earningsResponse.json();
                    claimedSol = clampSolAmount(Number(earnings.claimed ?? 0) / LAMPORT_IN_SOL);
                    claimableSol = clampSolAmount(Math.max(0, holder.totalSolRewardsEarned - claimedSol));
                }
            } catch {
                // Fall back to local indexed values if backend refresh is unavailable.
            }
        }

        claimedSol = clampSolAmount(claimedSol);
        claimableSol = clampSolAmount(claimableSol);
        const claimConfigured = Boolean(config.rewards.claimApiUrl);
        const claimEnabled = claimConfigured && claimableSol > 0;

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
                claimEnabled,
                claimDisabledReason: claimEnabled
                    ? ''
                    : (claimConfigured ? 'No claimable rewards yet.' : 'Claim signer not configured for this deployment.')
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
