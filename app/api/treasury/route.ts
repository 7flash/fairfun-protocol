import { measure } from 'measure-fn';
import { getRecentTreasuryEvents } from '../../../lib/database';
import { formatSOL } from '../../../lib/gravity';

export async function GET(req: Request) {
    return await measure('GET /api/treasury', async () => {
        const url = new URL(req.url);
        const wallet = url.searchParams.get('wallet') ?? undefined;
        const limit = Number(url.searchParams.get('limit') ?? 25);
        const events = getRecentTreasuryEvents(limit, wallet ?? undefined).map((event) => ({
            signature: event.signature,
            amountSol: event.amountSol,
            amountSolFormatted: formatSOL(event.amountSol),
            payoutAmountSol: event.payoutAmountSol,
            payoutAmountSolFormatted: formatSOL(event.payoutAmountSol),
            observedTotalDepositsSol: event.observedTotalDepositsSol,
            observedTotalDepositsSolFormatted: formatSOL(event.observedTotalDepositsSol),
            timestamp: event.timestamp,
        }));

        return Response.json({
            success: true,
            events,
            total: events.length,
            timestamp: Date.now(),
        });
    }, (error) => {
        console.error('Error loading treasury events:', error);
        return Response.json({ success: false, error: 'Unable to load treasury events.' }, { status: 500 });
    });
}
