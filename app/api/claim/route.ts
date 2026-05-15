import { PublicKey } from '@solana/web3.js';
import { getHolder, getMetaNumber, recordClaimEvent, updateHolderRewards } from '../../../lib/database';
import { buildClaimTransaction, claimSigningEnabled, fetchRewardPoolState, fetchUserClaimState, lamportsToSolNumber, solToLamportsBigInt } from '../../../lib/fairfun-program';

const LAMPORT_IN_SOL = 1_000_000_000;
const MIN_CLAIMABLE_SOL = 1 / LAMPORT_IN_SOL;

function clampSolAmount(value: number) {
    return Math.abs(value) < MIN_CLAIMABLE_SOL ? 0 : value;
}

export async function POST(req: Request) {
    try {
        if (!claimSigningEnabled()) {
            return Response.json({ success: false, error: 'Backend signer keypair is not configured.' }, { status: 501 });
        }

        const body = await req.json() as { address?: string };
        const address = body.address?.trim();
        if (!address) {
            return Response.json({ success: false, error: 'Missing wallet address' }, { status: 400 });
        }

        const holder = getHolder(address);
        if (!holder) {
            return Response.json({ success: false, error: 'Wallet has no indexed rewards yet.' }, { status: 404 });
        }

        const pool = await fetchRewardPoolState();
        if (!pool.active) {
            return Response.json({ success: false, error: 'Rewards pool is paused.' }, { status: 409 });
        }

        const cumulativeEarned = solToLamportsBigInt(holder.totalSolRewardsEarned);
        const observedTotalDeposits = solToLamportsBigInt(getMetaNumber('totalFeesAccumulatedSol'));
        if (cumulativeEarned <= 0n || observedTotalDeposits <= 0n) {
            return Response.json({ success: false, error: 'Nothing to claim yet.' }, { status: 409 });
        }

        const transactionResult = await buildClaimTransaction(new PublicKey(address), cumulativeEarned, observedTotalDeposits);
        return Response.json({
            success: true,
            transaction: transactionResult.transaction.serialize({ requireAllSignatures: false }).toString('base64'),
            blockhash: transactionResult.blockhash,
            lastValidBlockHeight: transactionResult.lastValidBlockHeight,
            expiresAt: transactionResult.expiresAt,
            observedTotalDeposits: observedTotalDeposits.toString(),
            cumulativeEarned: cumulativeEarned.toString(),
            signer: transactionResult.signerPubkey,
        });
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
        if (!claimSigningEnabled()) {
            return Response.json({ success: false, error: 'Backend signer keypair is not configured.' }, { status: 501 });
        }

        const body = await req.json() as { address?: string; signature?: string };
        const address = body.address?.trim();
        const signature = body.signature?.trim();
        if (!address || !signature) {
            return Response.json({ success: false, error: 'Missing wallet address or signature' }, { status: 400 });
        }

        const claimState = await fetchUserClaimState(new PublicKey(address));
        if (!claimState) {
            return Response.json({ success: false, error: 'Onchain claim state was not created yet.' }, { status: 409 });
        }

        const holder = getHolder(address);
        if (holder) {
            const previousClaimedSol = clampSolAmount(holder.totalSolRewardsClaimed);
            const claimedSol = clampSolAmount(lamportsToSolNumber(claimState.claimedAmount));
            const grossAmountSol = clampSolAmount(Math.max(0, claimedSol - previousClaimedSol));
            const claimable = clampSolAmount(Math.max(0, holder.totalSolRewardsEarned - claimedSol));
            updateHolderRewards(address, {
                totalSolRewardsClaimed: claimedSol,
                claimableSolRewards: claimable,
            });
            if (grossAmountSol > 0) {
                recordClaimEvent({
                    signature,
                    claimantAddress: address,
                    grossAmountSol,
                    claimantAmountSol: grossAmountSol,
                    delegatorFeeSol: 0,
                    mode: 'direct',
                });
            }
        }

        return Response.json({
            success: true,
            address,
            signature,
            claimed: claimState.claimedAmount.toString()
        });
    } catch (error) {
        console.error('Error finalizing claim:', error);
        return Response.json(
            { success: false, error: 'Failed to finalize claim state' },
            { status: 500 }
        );
    }
}
