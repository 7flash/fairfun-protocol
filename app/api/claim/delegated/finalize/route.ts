import { PublicKey } from '@solana/web3.js';
import { getHolder, updateHolderRewards } from '../../../../../lib/database';
import { fetchUserClaimState, lamportsToSolNumber } from '../../../../../lib/fairfun-program';

const LAMPORT_IN_SOL = 1_000_000_000;
const MIN_CLAIMABLE_SOL = 1 / LAMPORT_IN_SOL;

function clampSolAmount(value: number) {
    return Math.abs(value) < MIN_CLAIMABLE_SOL ? 0 : value;
}

export async function POST(req: Request) {
    try {
        const body = await req.json() as { claimantAddress?: string; signature?: string };
        const claimantAddress = body.claimantAddress?.trim();
        const signature = body.signature?.trim();
        if (!claimantAddress || !signature) {
            return Response.json({ success: false, error: 'Missing claimant wallet address or signature' }, { status: 400 });
        }

        const claimState = await fetchUserClaimState(new PublicKey(claimantAddress));
        if (!claimState) {
            return Response.json({ success: false, error: 'Onchain claim state was not created yet.' }, { status: 409 });
        }

        const holder = getHolder(claimantAddress);
        if (holder) {
            const claimedSol = clampSolAmount(lamportsToSolNumber(claimState.claimedAmount));
            const claimable = clampSolAmount(Math.max(0, holder.totalSolRewardsEarned - claimedSol));
            updateHolderRewards(claimantAddress, {
                totalSolRewardsClaimed: claimedSol,
                claimableSolRewards: claimable,
            });
        }

        return Response.json({
            success: true,
            claimant: claimantAddress,
            signature,
            claimed: claimState.claimedAmount.toString()
        });
    } catch (error) {
        console.error('Error finalizing delegated claim:', error);
        return Response.json(
            { success: false, error: 'Failed to finalize delegated claim state' },
            { status: 500 }
        );
    }
}
