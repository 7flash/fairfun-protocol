import { measure } from 'measure-fn';
import { getRecentClaimEvents } from '../../../lib/database';
import { formatAddress } from '../../../lib/solana';
import { formatSOL, getCurrentSolPrice, formatUSD } from '../../../lib/gravity';

export async function GET(req: Request) {
    return await measure('GET /api/claims', async () => {
        const url = new URL(req.url);
        const wallet = url.searchParams.get('wallet') ?? undefined;
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const solPriceUsd = await getCurrentSolPrice();
        const events = getRecentClaimEvents(limit, wallet)
            .filter((event) => event.grossAmountSol > 0 || event.claimantAmountSol > 0 || event.delegatorFeeSol > 0)
            .map((event) => ({
            signature: event.signature,
            claimantAddress: event.claimantAddress,
            claimantAddressShort: formatAddress(event.claimantAddress),
            delegatorAddress: event.delegatorAddress,
            delegatorAddressShort: event.delegatorAddress ? formatAddress(event.delegatorAddress) : '',
            grossAmountSol: event.grossAmountSol,
            grossAmountSolFormatted: formatSOL(event.grossAmountSol),
            grossAmountUsd: event.grossAmountSol * solPriceUsd,
            grossAmountUsdFormatted: formatUSD(event.grossAmountSol * solPriceUsd),
            claimantAmountSol: event.claimantAmountSol,
            claimantAmountSolFormatted: formatSOL(event.claimantAmountSol),
            delegatorFeeSol: event.delegatorFeeSol,
            delegatorFeeSolFormatted: formatSOL(event.delegatorFeeSol),
            mode: event.mode,
            timestamp: event.timestamp,
        }));

        return Response.json({
            success: true,
            events,
            total: events.length,
            solPriceUsd,
            timestamp: Date.now(),
        });
    }, (error) => {
        console.error('Error loading claim events:', error);
        return Response.json({ success: false, error: 'Unable to load claim events.' }, { status: 500 });
    });
}
