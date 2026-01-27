/**
 * Update Galaxy Wheel Configuration
 * 
 * Updates the on-chain wheel config to match the new 5-tier Galaxy theme:
 * - SUPERNOVA (outer): 0.5% chance, 100% of jackpot
 * - NEBULA: 2% chance, 40% of jackpot
 * - STAR CLUSTER: 7.5% chance, 15% of jackpot
 * - COSMOS: 20% chance, 4% of jackpot
 * - STARDUST (inner): 70% chance, 1% of jackpot
 * 
 * Run with: bun run scripts/update-wheel-config.ts
 */

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import * as fs from 'fs';

// Configuration
const WHEEL_PROGRAM_ID = new PublicKey('3M12BfitAEYz14WJBMnjahEuSvhsWhjfGJXbzur26o2U');
const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=093c9b83-eb11-418c-8aeb-b96bf06c848e';

// New Galaxy Wheel configuration (5 tiers)
// Probabilities in basis points (10000 = 100%)
const NUM_TIERS = 5;
const PROBABILITIES = [
    50,    // SUPERNOVA: 0.5% chance
    200,   // NEBULA: 2% chance
    750,   // STAR CLUSTER: 7.5% chance
    2000,  // COSMOS: 20% chance
    7000,  // STARDUST: 70% chance (most common)
    0, 0, 0, 0, 0  // Unused tiers (padded to 10)
];
// Rewards in basis points (10000 = 100% of treasury)
const REWARD_BPS = [
    10000, // SUPERNOVA: 100% of jackpot (full treasury!)
    4000,  // NEBULA: 40% of jackpot
    1500,  // STAR CLUSTER: 15% of jackpot
    400,   // COSMOS: 4% of jackpot
    100,   // STARDUST: 1% of jackpot
    0, 0, 0, 0, 0  // Unused tiers (padded to 10)
];

async function main() {
    console.log('🌌 Galaxy Wheel Config Update Script');
    console.log('=====================================\n');

    // Load authority keypair
    const authorityPath = '/Users/gur/.config/solana/mainnet-deployer.json';
    const authorityKeypair = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(authorityPath, 'utf-8')))
    );
    console.log('Authority:', authorityKeypair.publicKey.toBase58());

    // Connect to mainnet
    const connection = new Connection(RPC_URL, 'confirmed');
    const balance = await connection.getBalance(authorityKeypair.publicKey);
    console.log('Balance:', balance / 1e9, 'SOL\n');

    // Derive state PDA
    const [statePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('wheel_state')],
        WHEEL_PROGRAM_ID
    );
    console.log('State PDA:', statePda.toBase58());

    // Check if initialized
    const stateInfo = await connection.getAccountInfo(statePda);
    if (!stateInfo) {
        console.log('❌ Wheel state not initialized! Run init-wheel.ts first.');
        return;
    }
    console.log('✓ Wheel state found\n');

    // Validate probabilities sum to 10000
    const totalProb = PROBABILITIES.slice(0, NUM_TIERS).reduce((a, b) => a + b, 0);
    console.log('New Configuration:');
    console.log('  Num Tiers:', NUM_TIERS);
    console.log('  Probabilities:', PROBABILITIES.slice(0, NUM_TIERS), '(sum:', totalProb, ')');
    console.log('  Reward BPS:', REWARD_BPS.slice(0, NUM_TIERS));
    console.log('');

    if (totalProb !== 10000) {
        console.log('❌ Probabilities must sum to 10000! Current sum:', totalProb);
        return;
    }

    console.log('Tier breakdown:');
    const tierNames = ['SUPERNOVA', 'NEBULA', 'STAR CLUSTER', 'COSMOS', 'STARDUST'];
    for (let i = 0; i < NUM_TIERS; i++) {
        const prob = PROBABILITIES[i] / 100;
        const reward = REWARD_BPS[i] / 100;
        console.log(`  ${tierNames[i]}: ${prob}% chance → ${reward}% of jackpot`);
    }
    console.log('');

    // Build set_probabilities instruction
    // Anchor discriminator for "set_probabilities"
    // sha256("global:set_probabilities")[:8]
    const crypto = await import('crypto');
    const hash = crypto.createHash('sha256').update('global:set_probabilities').digest();
    const discriminator = hash.slice(0, 8);

    // Serialize arguments
    const data = Buffer.alloc(8 + 1 + 20 + 20); // discriminator + num_tiers + probs + rewards
    let offset = 0;

    // discriminator (8 bytes)
    discriminator.copy(data, offset);
    offset += 8;

    // num_tiers: u8 (1 byte)
    data.writeUInt8(NUM_TIERS, offset);
    offset += 1;

    // probabilities: [u16; 10] (20 bytes)
    for (let i = 0; i < 10; i++) {
        data.writeUInt16LE(PROBABILITIES[i], offset);
        offset += 2;
    }

    // reward_bps: [u16; 10] (20 bytes)
    for (let i = 0; i < 10; i++) {
        data.writeUInt16LE(REWARD_BPS[i], offset);
        offset += 2;
    }

    const updateIx = new TransactionInstruction({
        programId: WHEEL_PROGRAM_ID,
        keys: [
            { pubkey: statePda, isSigner: false, isWritable: true },
            { pubkey: authorityKeypair.publicKey, isSigner: true, isWritable: false },
        ],
        data,
    });

    // Build and send transaction
    const tx = new Transaction().add(updateIx);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = authorityKeypair.publicKey;
    tx.sign(authorityKeypair);

    console.log('Sending config update transaction...');
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
            console.log('✅ Wheel config updated successfully!');
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
