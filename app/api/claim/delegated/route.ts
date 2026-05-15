import { PublicKey } from '@solana/web3.js';
import { getHolder, getMetaNumber } from '../../../../lib/database';
import { BASIS_POINTS_DENOMINATOR, DELEGATED_CLAIM_FEE_BPS, buildDelegatedClaimTransaction, claimSigningEnabled, fetchRewardPoolState, fetchUserDelegationSettingsState, solToLamportsBigInt } from '../../../../lib/fairfun-program';

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

        const body = await req.json() as { delegatorAddress?: string; claimantAddress?: string };
        const delegatorAddress = body.delegatorAddress?.trim();
        const claimantAddress = body.claimantAddress?.trim();

        if (!delegatorAddress || !claimantAddress) {
            return Response.json({ success: false, error: 'Missing delegator or claimant wallet address' }, { status: 400 });
        }

        if (delegatorAddress === claimantAddress) {
            return Response.json({ success: false, error: 'Delegator and claimant cannot be the same address.' }, { status: 400 });
        }

        const holder = getHolder(claimantAddress);
        if (!holder) {
            return Response.json({ success: false, error: 'Claimant wallet has no indexed rewards yet.' }, { status: 404 });
        }
        const delegationSettings = await fetchUserDelegationSettingsState(new PublicKey(claimantAddress));
        const delegatedClaimsEnabled = delegationSettings?.delegatedClaimsEnabled ?? holder.delegatedClaimsEnabled ?? true;
        if (!delegatedClaimsEnabled) {
            return Response.json({ success: false, error: 'This wallet disabled delegated claims.' }, { status: 409 });
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

        const transactionResult = await buildDelegatedClaimTransaction(
            new PublicKey(delegatorAddress),
            new PublicKey(claimantAddress),
            cumulativeEarned,
            observedTotalDeposits,
        );
        const grossClaimLamports = cumulativeEarned;
        const delegatorFeeLamports = grossClaimLamports * BigInt(DELEGATED_CLAIM_FEE_BPS) / BigInt(BASIS_POINTS_DENOMINATOR);
        const claimantPayoutLamports = grossClaimLamports - delegatorFeeLamports;

        return Response.json({
            success: true,
            transaction: transactionResult.transaction.serialize({ requireAllSignatures: false }).toString('base64'),
            blockhash: transactionResult.blockhash,
            lastValidBlockHeight: transactionResult.lastValidBlockHeight,
            expiresAt: transactionResult.expiresAt,
            observedTotalDeposits: observedTotalDeposits.toString(),
            cumulativeEarned: cumulativeEarned.toString(),
            claimantPayout: claimantPayoutLamports.toString(),
            delegatorFee: delegatorFeeLamports.toString(),
            delegatedClaimFeeBps: DELEGATED_CLAIM_FEE_BPS,
            signer: transactionResult.signerPubkey,
            claimant: transactionResult.claimantPubkey,
            delegator: transactionResult.delegatorPubkey,
        });
    } catch (error) {
        console.error('Error building delegated claim transaction:', error);
        return Response.json(
            { success: false, error: 'Failed to build delegated claim transaction' },
            { status: 500 }
        );
    }
}
