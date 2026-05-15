import { PublicKey } from '@solana/web3.js';
import { getHolder, updateHolderRewards } from '../../../../lib/database';
import { buildSetDelegatedClaimsEnabledTransaction, fetchUserDelegationSettingsState } from '../../../../lib/fairfun-program';

export async function POST(req: Request) {
    try {
        const body = await req.json() as { address?: string; enabled?: boolean };
        const address = body.address?.trim();
        if (!address || typeof body.enabled !== 'boolean') {
            return Response.json({ success: false, error: 'Missing wallet address or enabled flag' }, { status: 400 });
        }

        const transactionResult = await buildSetDelegatedClaimsEnabledTransaction(new PublicKey(address), body.enabled);
        return Response.json({
            success: true,
            transaction: transactionResult.transaction.serialize({ requireAllSignatures: false }).toString('base64'),
            blockhash: transactionResult.blockhash,
            lastValidBlockHeight: transactionResult.lastValidBlockHeight,
            enabled: transactionResult.enabled,
        });
    } catch (error) {
        console.error('Error building delegated claim preference transaction:', error);
        return Response.json(
            { success: false, error: 'Failed to build delegated claim preference transaction' },
            { status: 500 }
        );
    }
}

export async function PUT(req: Request) {
    try {
        const body = await req.json() as { address?: string; signature?: string };
        const address = body.address?.trim();
        const signature = body.signature?.trim();
        if (!address || !signature) {
            return Response.json({ success: false, error: 'Missing wallet address or signature' }, { status: 400 });
        }

        const settings = await fetchUserDelegationSettingsState(new PublicKey(address));
        if (!settings) {
            return Response.json({ success: false, error: 'Delegation preference account was not created yet.' }, { status: 409 });
        }

        const holder = getHolder(address);
        if (holder) {
            updateHolderRewards(address, {
                delegatedClaimsEnabled: settings.delegatedClaimsEnabled,
            });
        }

        return Response.json({
            success: true,
            address,
            signature,
            delegatedClaimsEnabled: settings.delegatedClaimsEnabled,
        });
    } catch (error) {
        console.error('Error finalizing delegated claim preference:', error);
        return Response.json(
            { success: false, error: 'Failed to finalize delegated claim preference' },
            { status: 500 }
        );
    }
}
