import { Connection } from '@solana/web3.js';
import { measure } from 'measure-fn';
import { getClaimEventsBySignatures, getRecentClaimEvents } from '../../../lib/database';
import { formatSOL, getCurrentSolPrice, formatUSD } from '../../../lib/gravity';
import { getClaimStatsSummary } from '../../../lib/claim-stats';
import { getPositiveTokenDeltasByOwner } from '../../../lib/claim-token-deltas';
import { config } from '../../../lib/config';
import { formatAddress } from '../../../lib/solana';

const MAX_BATCH_CLAIMANTS = 8;

type ClaimRecipient = {
    claimantAddress: string;
    claimantAddressShort: string;
    grossAmountSol: number;
    grossAmountSolFormatted: string;
    grossAmountUsd: number;
    grossAmountUsdFormatted: string;
    claimantAmountSol: number;
    claimantAmountSolFormatted: string;
    claimantTokenAmount: number;
    claimantTokenAmountFormatted: string;
};

type ClaimBatch = {
    signature: string;
    mode: string;
    timestamp: number;
    claimantCount: number;
    claimantAddress: string;
    claimantAddressShort: string;
    delegatorAddress: string;
    delegatorAddressShort: string;
    grossAmountSol: number;
    grossAmountSolFormatted: string;
    grossAmountUsd: number;
    grossAmountUsdFormatted: string;
    claimantAmountSol: number;
    claimantAmountSolFormatted: string;
    projectFeeSol: number;
    projectFeeSolFormatted: string;
    claimantTokenAmount: number;
    claimantTokenAmountFormatted: string;
    recipients: ClaimRecipient[];
};

function formatTokenAmount(value: number) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function groupClaimBatches(
    rawEvents: ReturnType<typeof getRecentClaimEvents>,
    tokenDeltasBySignature: Map<string, Map<string, number>>,
    solPriceUsd: number,
) {
    const grouped = new Map<string, ReturnType<typeof getRecentClaimEvents>>();
    for (const event of rawEvents) {
        const existing = grouped.get(event.signature) ?? [];
        existing.push(event);
        grouped.set(event.signature, existing);
    }

    const batches = Array.from(grouped.values())
        .map((events) => {
            const sortedEvents = [...events].sort(
                (left, right) =>
                    right.claimantAmountSol - left.claimantAmountSol
                    || right.grossAmountSol - left.grossAmountSol
                    || right.timestamp - left.timestamp,
            );
            const first = sortedEvents[0];
            const tokenDeltas = tokenDeltasBySignature.get(first.signature) ?? new Map<string, number>();
            const recipients: ClaimRecipient[] = sortedEvents.map((event) => {
                const claimantTokenAmount =
                    event.mode === 'direct'
                        ? 0
                        : tokenDeltas.get(event.claimantAddress) ?? 0;
                return {
                    claimantAddress: event.claimantAddress,
                    claimantAddressShort: formatAddress(event.claimantAddress),
                    grossAmountSol: event.grossAmountSol,
                    grossAmountSolFormatted: formatSOL(event.grossAmountSol),
                    grossAmountUsd: event.grossAmountSol * solPriceUsd,
                    grossAmountUsdFormatted: formatUSD(event.grossAmountSol * solPriceUsd),
                    claimantAmountSol: event.claimantAmountSol,
                    claimantAmountSolFormatted: formatSOL(event.claimantAmountSol),
                    claimantTokenAmount,
                    claimantTokenAmountFormatted: formatTokenAmount(claimantTokenAmount),
                };
            });

            const grossAmountSol = recipients.reduce((sum, recipient) => sum + recipient.grossAmountSol, 0);
            const claimantAmountSol = recipients.reduce((sum, recipient) => sum + recipient.claimantAmountSol, 0);
            const claimantTokenAmount = recipients.reduce((sum, recipient) => sum + recipient.claimantTokenAmount, 0);
            const projectFeeSol = sortedEvents.reduce((sum, event) => sum + event.projectFeeSol, 0);

            return {
                signature: first.signature,
                mode: first.mode,
                timestamp: Math.max(...sortedEvents.map((event) => event.timestamp)),
                claimantCount: recipients.length,
                claimantAddress: first.claimantAddress,
                claimantAddressShort: formatAddress(first.claimantAddress),
                delegatorAddress: first.delegatorAddress,
                delegatorAddressShort: first.delegatorAddress ? formatAddress(first.delegatorAddress) : '',
                grossAmountSol,
                grossAmountSolFormatted: formatSOL(grossAmountSol),
                grossAmountUsd: grossAmountSol * solPriceUsd,
                grossAmountUsdFormatted: formatUSD(grossAmountSol * solPriceUsd),
                claimantAmountSol,
                claimantAmountSolFormatted: formatSOL(claimantAmountSol),
                projectFeeSol,
                projectFeeSolFormatted: formatSOL(projectFeeSol),
                claimantTokenAmount,
                claimantTokenAmountFormatted: formatTokenAmount(claimantTokenAmount),
                recipients,
            } satisfies ClaimBatch;
        })
        .sort((left, right) => right.timestamp - left.timestamp);

    return batches;
}

export async function GET(req: Request) {
    return await measure('GET /api/claims', async () => {
        const url = new URL(req.url);
        const wallet = url.searchParams.get('wallet') ?? undefined;
        const mineOnly = url.searchParams.get('mine') === '1';
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 50)));
        const rawLimit = Math.max(limit * MAX_BATCH_CLAIMANTS, limit);
        const solPriceUsd = await getCurrentSolPrice();
        const summary = await getClaimStatsSummary();

        const seedEvents = getRecentClaimEvents(rawLimit, mineOnly ? wallet : undefined)
            .filter((event) => event.grossAmountSol > 0 || event.claimantAmountSol > 0 || event.projectFeeSol > 0);
        const selectedSignatures = Array.from(new Set(seedEvents.map((event) => event.signature))).slice(0, limit);
        const rawEvents = getClaimEventsBySignatures(selectedSignatures)
            .filter((event) => event.grossAmountSol > 0 || event.claimantAmountSol > 0 || event.projectFeeSol > 0);

        const connection = new Connection(config.chain.rpcUrl, 'confirmed');
        const tokenDeltasBySignature = new Map<string, Map<string, number>>();

        for (let start = 0; start < selectedSignatures.length; start += 20) {
            const batchSignatures = selectedSignatures.slice(start, start + 20);
            const txs = await connection.getParsedTransactions(batchSignatures, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0,
            });
            for (let index = 0; index < batchSignatures.length; index++) {
                const tx = txs[index];
                tokenDeltasBySignature.set(
                    batchSignatures[index],
                    getPositiveTokenDeltasByOwner(tx, config.token.mint),
                );
            }
        }

        const events = groupClaimBatches(rawEvents, tokenDeltasBySignature, solPriceUsd);
        const latestAutoClaim = events.find((event) => event.mode === 'delegated-batch-tokenized');
        const nextAutoClaimAt = latestAutoClaim
            ? latestAutoClaim.timestamp + config.claimer.intervalMs
            : null;

        return Response.json({
            success: true,
            events,
            total: events.length,
            summary,
            nextAutoClaimAt,
            claimerIntervalMs: config.claimer.intervalMs,
            solPriceUsd,
            timestamp: Date.now(),
        });
    }, (error) => {
        console.error('Error loading claim events:', error);
        return Response.json({ success: false, error: 'Unable to load claim events.' }, { status: 500 });
    });
}
