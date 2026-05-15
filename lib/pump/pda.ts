import { PublicKey } from '@solana/web3.js';
import { PUMP_PROGRAM_ID } from './constants';

function pda(seeds: Buffer[], programId = PUMP_PROGRAM_ID) {
    return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export function bondingCurvePda(mint: PublicKey) {
    return pda([Buffer.from('bonding-curve'), mint.toBuffer()]);
}
