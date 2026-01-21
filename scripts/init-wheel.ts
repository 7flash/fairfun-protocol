/**
 * Initialize Galaxy Wheel Program on Mainnet
 * 
 * This script:
 * 1. Initializes the wheel state PDA with tier configuration
 * 2. Optionally funds the treasury pool
 * 
 * Run with: bun run scripts/init-wheel.ts
 */

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import * as fs from 'fs';

// Configuration
const WHEEL_PROGRAM_ID = new PublicKey('3M12BfitAEYz14WJBMnjahEuSvhsWhjfGJXbzur26o2U');
const STARDUST_MINT = new PublicKey('XG3VfC9e8hzjaeQutPHrCs1YE6jwbdCqhfRpY8miWo5');
const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=15319bf4-5b40-4958-ac8d-6313aa55eb92';

// Wheel configuration (4 tiers)
const NUM_TIERS = 4;
const PROBABILITIES = [
    1000,  // Tier 0: 10% - Nothing
    7500,  // Tier 1: 75% - Small win (1% of treasury)
    1400,  // Tier 2: 14% - Medium win (10% of treasury)
    100,   // Tier 3: 1% - Jackpot (50% of treasury)
    0, 0, 0, 0, 0, 0  // Unused tiers (padded to 10)
];
const REWARD_BPS = [
    0,     // Tier 0: 0% of treasury
    100,   // Tier 1: 1% of treasury
    1000,  // Tier 2: 10% of treasury
    5000,  // Tier 3: 50% of treasury
    0, 0, 0, 0, 0, 0  // Unused tiers (padded to 10)
];
const COST_PER_SPIN = 1_000_000_000_000n; // 1000 stardust (9 decimals)

async function main() {
    console.log('🎡 Galaxy Wheel Initialization Script');
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

    // Derive PDAs
    const [statePda, stateBump] = PublicKey.findProgramAddressSync(
        [Buffer.from('wheel_state')],
        WHEEL_PROGRAM_ID
    );
    const [poolPda, poolBump] = PublicKey.findProgramAddressSync(
        [Buffer.from('wheel_pool')],
        WHEEL_PROGRAM_ID
    );

    console.log('PDAs:');
    console.log('  State PDA:', statePda.toBase58());
    console.log('  Pool PDA:', poolPda.toBase58());
    console.log('');

    // Check if already initialized
    const stateInfo = await connection.getAccountInfo(statePda);
    if (stateInfo) {
        console.log('⚠️  Wheel state already initialized!');
        console.log('State account size:', stateInfo.data.length, 'bytes');
        return;
    }

    console.log('Wheel Configuration:');
    console.log('  Num Tiers:', NUM_TIERS);
    console.log('  Cost per spin:', Number(COST_PER_SPIN) / 1e9, 'stardust');
    console.log('  Probabilities:', PROBABILITIES.slice(0, NUM_TIERS));
    console.log('  Reward BPS:', REWARD_BPS.slice(0, NUM_TIERS));
    console.log('');

    // Build initialize instruction
    // Anchor discriminator for "initialize" = sha256("global:initialize")[:8]
    const discriminator = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);

    // Serialize arguments
    const data = Buffer.alloc(8 + 8 + 1 + 20 + 20); // discriminator + cost + num_tiers + probs + rewards
    let offset = 0;

    // discriminator (8 bytes)
    discriminator.copy(data, offset);
    offset += 8;

    // cost_per_spin: u64 (8 bytes, little-endian)
    data.writeBigUInt64LE(COST_PER_SPIN, offset);
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

    const initIx = new TransactionInstruction({
        programId: WHEEL_PROGRAM_ID,
        keys: [
            { pubkey: statePda, isSigner: false, isWritable: true },
            { pubkey: poolPda, isSigner: false, isWritable: true },
            { pubkey: STARDUST_MINT, isSigner: false, isWritable: false },
            { pubkey: authorityKeypair.publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
    });

    // Build and send transaction
    const tx = new Transaction().add(initIx);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = authorityKeypair.publicKey;
    tx.sign(authorityKeypair);

    console.log('Sending initialization transaction...');
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
            console.log('✅ Wheel initialized successfully!');
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
