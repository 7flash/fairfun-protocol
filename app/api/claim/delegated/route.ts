import { PublicKey } from '@solana/web3.js';
import { getHolder, getMetaNumber } from '../../../../lib/database';
import { BASIS_POINTS_DENOMINATOR, PROJECT_FEE_BPS, calculateNetClaimLamports, calculateProjectFeeLamports, claimSigningEnabled, fetchUserDelegationSettingsState, loadBackendKeypair, prepareClaimAmounts, solToLamportsBigInt } from '../../../../lib/fairfun-program';
import { buildVersionedDelegatedTokenClaimTransaction } from '../../../../lib/tokenized-claims';

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

        const claimantPublicKey = new PublicKey(claimantAddress);
        const delegatorPublicKey = new PublicKey(delegatorAddress);
        const backend = loadBackendKeypair();
        const preparedClaim = await prepareClaimAmounts(
            claimantPublicKey,
            solToLamportsBigInt(holder.totalSolRewardsEarned),
            solToLamportsBigInt(getMetaNumber('totalFeesAccumulatedSol')),
        );
        if (!preparedClaim.poolActive) {
            return Response.json({ success: false, error: 'Rewards pool is paused.' }, { status: 409 });
        }
        if (preparedClaim.estimatedClaimableLamports <= 0n || preparedClaim.observedTotalDeposits <= 0n) {
            return Response.json({ success: false, error: 'Nothing to claim yet.' }, { status: 409 });
        }

        const transactionResult = await buildVersionedDelegatedTokenClaimTransaction(
            backend,
            delegatorPublicKey,
            claimantPublicKey,
            preparedClaim.cumulativeEarned,
            preparedClaim.observedTotalDeposits,
            preparedClaim.estimatedClaimableLamports,
        );
        const grossClaimLamports = preparedClaim.estimatedClaimableLamports;
        const projectFeeLamports = calculateProjectFeeLamports(grossClaimLamports);
        const claimantPayoutLamports = calculateNetClaimLamports(grossClaimLamports);

        return Response.json({
            success: true,
            transaction: Buffer.from(transactionResult.transaction.serialize()).toString('base64'),
            version: 0,
            blockhash: transactionResult.blockhash,
            lastValidBlockHeight: transactionResult.lastValidBlockHeight,
            observedTotalDeposits: preparedClaim.observedTotalDeposits.toString(),
            cumulativeEarned: preparedClaim.cumulativeEarned.toString(),
            estimatedClaimable: grossClaimLamports.toString(),
            claimantPayout: claimantPayoutLamports.toString(),
            projectFee: projectFeeLamports.toString(),
            projectFeeBps: PROJECT_FEE_BPS,
            signer: backend.publicKey.toBase58(),
            claimant: claimantPublicKey.toBase58(),
            delegator: delegatorPublicKey.toBase58(),
            lookupTableAddress: transactionResult.lookupTableAddress,
            minimumTokenAmountOut: transactionResult.minimumTokenAmountOut,
        });
    } catch (error) {
        console.error('Error building delegated claim transaction:', error);
        return Response.json(
            { success: false, error: 'Failed to build delegated claim transaction' },
            { status: 500 }
        );
    }
}
