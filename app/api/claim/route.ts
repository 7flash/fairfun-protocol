import { config } from '../../../lib/config';

const LAMPORT_IN_SOL = 1_000_000_000;
const MIN_CLAIMABLE_SOL = 1 / LAMPORT_IN_SOL;

function clampSolAmount(value: number) {
    return Math.abs(value) < MIN_CLAIMABLE_SOL ? 0 : value;
}

export async function POST(req: Request) {
    try {
        if (!config.rewards.claimApiUrl) {
            return Response.json({ success: false, error: 'Claim signer not configured.' }, { status: 501 });
        }

        const body = await req.json() as { address?: string };
        const address = body.address?.trim();
        if (!address) {
            return Response.json({ success: false, error: 'Missing wallet address' }, { status: 400 });
        }

        const response = await fetch(`${config.rewards.claimApiUrl}/api/claim-transaction`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ wallet: address })
        });

        const data = await response.json();
        return Response.json(data, { status: response.status });
    } catch (error) {
        console.error('Error building claim transaction:', error);
        return Response.json(
            { success: false, error: 'Failed to build claim transaction' },
            { status: 500 }
        );
    }
}

export async function PUT(req: Request) {
    try {
        if (!config.rewards.claimApiUrl) {
            return Response.json({ success: false, error: 'Claim signer not configured.' }, { status: 501 });
        }

        const body = await req.json() as { address?: string; signature?: string };
        const address = body.address?.trim();
        const signature = body.signature?.trim();
        if (!address || !signature) {
            return Response.json({ success: false, error: 'Missing wallet address or signature' }, { status: 400 });
        }

        const confirmedResponse = await fetch(`${config.rewards.claimApiUrl}/api/claim-confirmed`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ wallet: address, signature })
        });
        const confirmedData = await confirmedResponse.json();
        if (!confirmedResponse.ok) {
            return Response.json(confirmedData, { status: confirmedResponse.status });
        }

        const earningsResponse = await fetch(`${config.rewards.claimApiUrl}/api/earnings/${address}`);
        const earningsData = await earningsResponse.json();
        if (!earningsResponse.ok) {
            return Response.json({ success: false, error: 'Failed to refresh claimed totals' }, { status: 500 });
        }

        const { getHolder, updateHolderRewards } = await import('../../../lib/database');
        const holder = getHolder(address);
        if (holder) {
            const claimedSol = clampSolAmount(Number(earningsData.claimed ?? 0) / LAMPORT_IN_SOL);
            const claimable = clampSolAmount(Math.max(0, holder.totalSolRewardsEarned - claimedSol));
            updateHolderRewards(address, {
                totalSolRewardsClaimed: claimedSol,
                claimableSolRewards: claimable,
            });
        }

        return Response.json({
            success: true,
            address,
            signature,
            claimed: earningsData.claimed ?? '0'
        });
    } catch (error) {
        console.error('Error finalizing claim:', error);
        return Response.json(
            { success: false, error: 'Failed to finalize claim state' },
            { status: 500 }
        );
    }
}
