import { measure } from 'measure-fn';
import { getRecentTreasuryEvents } from '../../../lib/database';
import { formatSOL, getCurrentSolPrice, formatUSD } from '../../../lib/gravity';
import { formatAddress } from '../../../lib/solana';
import { fetchTreasuryDepositorAddress } from '../../../lib/treasury';
import { config } from '../../../lib/config';

export async function GET(req: Request) {
    return await measure('GET /api/treasury', async () => {
        const url = new URL(req.url);
        const wallet = url.searchParams.get('wallet') ?? undefined;
        const limit = Number(url.searchParams.get('limit') ?? 25);
        const solPriceUsd = await getCurrentSolPrice();
        const rawEvents = getRecentTreasuryEvents(limit, wallet ?? undefined);
        const events = await Promise.all(rawEvents.map(async (event) => {
            const depositorAddress = event.depositorAddress
                || await fetchTreasuryDepositorAddress(event.signature, config.rewards.treasuryAddress);
            return {
                signature: event.signature,
                amountSol: event.amountSol,
                amountSolFormatted: formatSOL(event.amountSol),
                amountUsd: event.amountSol * solPriceUsd,
                amountUsdFormatted: formatUSD(event.amountSol * solPriceUsd),
                payoutAmountSol: event.payoutAmountSol,
                payoutAmountSolFormatted: formatSOL(event.payoutAmountSol),
                payoutAmountUsd: event.payoutAmountSol * solPriceUsd,
                payoutAmountUsdFormatted: formatUSD(event.payoutAmountSol * solPriceUsd),
                depositorAddress,
                depositorAddressShort: depositorAddress ? formatAddress(depositorAddress) : 'Unknown',
                timestamp: event.timestamp,
            };
        }));

        return Response.json({
            success: true,
            events,
            total: events.length,
            solPriceUsd,
            timestamp: Date.now(),
        });
    }, (error) => {
        console.error('Error loading treasury events:', error);
        return Response.json({ success: false, error: 'Unable to load treasury events.' }, { status: 500 });
    });
}
