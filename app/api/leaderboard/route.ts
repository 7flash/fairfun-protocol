import { measure } from 'measure-fn';
import { getHolderRank, getLeaderboard, getMetaNumber, getTotalClaimedSol } from '../../../lib/database';
import { formatAddress, formatTokenAmount, TOKEN_MINT } from '../../../lib/solana';
import { formatGravity, formatSOL, formatUSD } from '../../../lib/gravity';

export async function GET(req: Request) {
    return await measure('GET /api/leaderboard', async () => {
        const url = new URL(req.url);
        const wallet = url.searchParams.get('wallet');
        const totalSupply = getMetaNumber('totalSupply');
        const tokenPriceUsd = getMetaNumber('tokenPriceUsd');
        const lastIndexedAt = getMetaNumber('lastIndexedAt');
        const epochIndex = getMetaNumber('epochIndex');
        const launchTimestamp = getMetaNumber('launchTimestamp');
        const totalFeesAccumulatedSol = getMetaNumber('totalFeesAccumulatedSol');
        const lastFeeDeltaSol = getMetaNumber('lastFeeDeltaSol');
        const totalClaimedSol = getTotalClaimedSol();
        const treasuryBalanceSol = getMetaNumber('treasuryBalanceSol');
        const totalAccumulatedGravity = getMetaNumber('totalAccumulatedGravity');
        const lastGravityDelta = getMetaNumber('lastGravityDelta');
        const limit = Number(url.searchParams.get('limit') ?? 0);

        const entries = getLeaderboard(limit > 0 ? limit : undefined)
            .filter((holder) => holder.tokenBalance > 0)
            .map((holder, index) => {
            const rank = index + 1;
            const percentSupply = totalSupply > 0 ? holder.tokenBalance / totalSupply * 100 : 0;
            const gravityShare = totalAccumulatedGravity > 0 ? holder.accumulatedGravity / totalAccumulatedGravity * 100 : 0;

            return {
                rank,
                address: holder.address,
                addressShort: formatAddress(holder.address),
                tokenBalance: holder.tokenBalance,
                balanceFormatted: formatTokenAmount(holder.tokenBalance),
                tokenValueUsd: holder.tokenValueUsd,
                tokenValueUsdFormatted: formatUSD(holder.tokenValueUsd),
                percentSupply,
                percentSupplyFormatted: `${percentSupply.toFixed(3)}%`,
                accumulatedGravity: holder.accumulatedGravity,
                gravityFormatted: formatGravity(holder.accumulatedGravity),
                gravityShare,
                gravityShareFormatted: `${gravityShare.toFixed(3)}%`,
                totalSolRewardsEarned: holder.totalSolRewardsEarned,
                totalSolRewardsEarnedFormatted: formatSOL(holder.totalSolRewardsEarned),
                totalSolRewardsClaimed: holder.totalSolRewardsClaimed,
                claimableSolRewards: holder.claimableSolRewards,
                claimableSolRewardsFormatted: formatSOL(holder.claimableSolRewards),
                delegatedClaimsEnabled: holder.delegatedClaimsEnabled,
                lastUpdated: holder.updatedAt
            };
            });

        return Response.json({
            success: true,
            entries,
            walletRank: wallet ? getHolderRank(wallet) : null,
            total: entries.length,
            totalSupply,
            tokenPriceUsd,
            epochIndex,
            launchTimestamp,
            totalFeesAccumulatedSol,
            lastFeeDeltaSol,
            totalClaimedSol,
            treasuryBalanceSol,
            totalAccumulatedGravity,
            lastGravityDelta,
            tokenMint: TOKEN_MINT,
            source: 'sqlite-index',
            lastIndexedAt,
            timestamp: Date.now()
        });
    }, (error) => {
        console.error('Error loading indexed leaderboard:', error);
        return Response.json(
            {
                success: false,
                error: 'Unable to load indexed leaderboard data',
                tokenMint: TOKEN_MINT,
                entries: [],
                total: 0,
                totalSupply: 0,
                timestamp: Date.now()
            },
            { status: 503 }
        );
    });
}
