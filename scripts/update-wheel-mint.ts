/**
 * Update Stardust Mint in Galaxy Wheel
 * 
 * This script calls set_stardust_mint to fix the incorrect mint address.
 * Run AFTER upgrading the program: anchor upgrade ...
 * 
 * Run with: bun run scripts/update-wheel-mint.ts
 */

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import * as fs from 'fs';

const WHEEL_PROGRAM_ID = new PublicKey('3M12BfitAEYz14WJBMnjahEuSvhsWhjfGJXbzur26o2U');
const CORRECT_STARDUST_MINT = new PublicKey('XG3VfC9e8hzjaeQutPHrCs1YE6jwbdCqhfRpY8miWo5');
const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=093c9b83-eb11-418c-8aeb-b96bf06c848e';

async function main() {
    console.log('🔧 Update Stardust Mint Script');
    console.log('==============================\n');

    // Load authority keypair
    const authorityPath = '/Users/gur/.config/solana/mainnet-deployer.json';
    const authorityKeypair = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(authorityPath, 'utf-8')))
    );
    console.log('Authority:', authorityKeypair.publicKey.toBase58());

    const connection = new Connection(RPC_URL, 'confirmed');
    const balance = await connection.getBalance(authorityKeypair.publicKey);
    console.log('Balance:', balance / 1e9, 'SOL\n');

    // Derive state PDA
    const [statePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('wheel_state')],
        WHEEL_PROGRAM_ID
    );
    console.log('State PDA:', statePda.toBase58());
    console.log('New Mint:', CORRECT_STARDUST_MINT.toBase58());

    // Build set_stardust_mint instruction
    // Anchor discriminator for "set_stardust_mint" = sha256("global:set_stardust_mint")[:8]
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('global:set_stardust_mint').digest();
    const discriminator = hash.slice(0, 8);
    console.log('Discriminator:', discriminator.toString('hex'));

    // Serialize: discriminator (8) + new_mint pubkey (32)
    const data = Buffer.alloc(8 + 32);
    discriminator.copy(data, 0);
    CORRECT_STARDUST_MINT.toBuffer().copy(data, 8);

    const ix = new TransactionInstruction({
        programId: WHEEL_PROGRAM_ID,
        keys: [
            { pubkey: statePda, isSigner: false, isWritable: true },
            { pubkey: authorityKeypair.publicKey, isSigner: true, isWritable: false },
        ],
        data,
    });

    const tx = new Transaction().add(ix);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = authorityKeypair.publicKey;
    tx.sign(authorityKeypair);

    console.log('\nSending transaction...');
    try {
        const signature = await connection.sendRawTransaction(tx.serialize());
        console.log('Signature:', signature);

        const confirmation = await connection.confirmTransaction({
            signature,
            blockhash,
            lastValidBlockHeight,
        });

        if (confirmation.value.err) {
            console.error('❌ Transaction failed:', confirmation.value.err);
        } else {
            console.log('✅ Stardust mint updated successfully!');
            console.log('View on Solscan: https://solscan.io/tx/' + signature);
        }
    } catch (e: any) {
        console.error('❌ Error:', e.message);
        if (e.logs) {
            console.log('Logs:', e.logs);
        }
    }
}

main().catch(console.error);
