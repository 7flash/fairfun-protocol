import { measure } from 'measure-fn';
import { getRecentTreasuryEvents, getTreasurySummaryStats } from '../../../lib/database';
import { formatSOL, getCurrentSolPrice, formatUSD } from '../../../lib/gravity';
import { formatAddress } from '../../../lib/solana';
import { fetchTreasuryDepositorAddress } from '../../../lib/treasury';
import { config } from '../../../lib/config';
import { getCreatorFeeStatus } from '../../../lib/creator-fees';

export async function GET(req: Request) {
    return await measure('GET /api/treasury', async () => {
        const url = new URL(req.url);
        const wallet = url.searchParams.get('wallet') ?? undefined;
        const limit = Number(url.searchParams.get('limit') ?? 25);
        const solPriceUsd = await getCurrentSolPrice();
        const creatorFeeStatus = await getCreatorFeeStatus();
        const rawEvents = getRecentTreasuryEvents(limit, wallet ?? undefined);
        const events = await Promise.all(rawEvents.map(async (event) => {
            const depositorAddress = event.depositorAddress
                || await fetchTreasuryDepositorAddress(event.signature, config.rewards.treasuryAddress);
            return {
                signature: event.signature,
                amountSol: event.amountSol,
                amountSolFormatted: formatSOL(event.amountSol),
                payoutAmountSol: event.payoutAmountSol,
                payoutAmountSolFormatted: formatSOL(event.payoutAmountSol),
                payoutAmountUsd: event.payoutAmountSol * solPriceUsd,
                payoutAmountUsdFormatted: formatUSD(event.payoutAmountSol * solPriceUsd),
                eligibleHolderCount: event.eligibleHolderCount,
                depositorAddress,
                depositorAddressShort: depositorAddress ? formatAddress(depositorAddress) : 'Unknown',
                timestamp: event.timestamp,
            };
        }));
        const summaryStats = getTreasurySummaryStats(creatorFeeStatus.claimer);

        return Response.json({
            success: true,
            events,
            total: events.length,
            summary: {
                totalDepositedSol: summaryStats.totalDepositedSol,
                creatorFeeTopupTotalSol: summaryStats.creatorFeeTopupTotalSol,
                externalRevenueSol: summaryStats.externalRevenueSol,
                currentUnclaimedCreatorFeeSol: creatorFeeStatus.currentUnclaimedSol,
            },
            solPriceUsd,
            timestamp: Date.now(),
        });
    }, (error) => {
        console.error('Error loading treasury events:', error);
        return Response.json({ success: false, error: 'Unable to load treasury events.' }, { status: 500 });
    });
}
