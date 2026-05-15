import { PublicKey } from '@solana/web3.js';
import { accountDiscriminator } from './anchor';

export interface BondingCurveState {
    complete: boolean;
    creator: PublicKey;
}

const BONDING_CURVE_D8 = accountDiscriminator('BondingCurve');

export function decodeBondingCurve(data: Buffer): BondingCurveState {
    const minimumLegacyLen = 8 + 8 * 5 + 1 + 32;
    if (data.length < minimumLegacyLen) {
        throw new Error(`BondingCurve account too short: ${data.length}`);
    }

    const d8 = data.subarray(0, 8);
    if (!d8.equals(BONDING_CURVE_D8)) {
        throw new Error(`Unexpected BondingCurve discriminator: 0x${d8.toString('hex')}`);
    }

    const complete = data[48] !== 0;
    const creator = new PublicKey(data.subarray(49, 81));
    return { complete, creator };
}
