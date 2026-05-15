import { PublicKey } from '@solana/web3.js';

export const PUMP_PROGRAM_ID = new PublicKey(
    process.env.PUMP_PROGRAM_ID ?? '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
);
