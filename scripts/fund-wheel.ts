/**
 * Fund Galaxy Wheel Treasury Pool
 * Run with: bun run scripts/fund-wheel.ts <amount_in_sol>
 */

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import * as fs from 'fs';
import * as crypto from 'crypto';

const WHEEL_PROGRAM_ID = new PublicKey('3M12BfitAEYz14WJBMnjahEuSvhsWhjfGJXbzur26o2U');
const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=15319bf4-5b40-4958-ac8d-6313aa55eb92';

async function main() {
    const amountSol = parseFloat(process.argv[2] || '0.1');
    const amountLamports = BigInt(Math.floor(amountSol * 1e9));

    console.log(`🏦 Funding Galaxy Wheel Treasury`);
    console.log(`================================\n`);
    console.log(`Amount: ${amountSol} SOL (${amountLamports} lamports)\n`);

    // Load authority
    const authorityPath = '/Users/gur/.config/solana/mainnet-deployer.json';
    const authorityKeypair = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(authorityPath, 'utf-8')))
    );

    const connection = new Connection(RPC_URL, 'confirmed');
    const balance = await connection.getBalance(authorityKeypair.publicKey);
    console.log('Funder:', authorityKeypair.publicKey.toBase58());
    console.log('Balance:', balance / 1e9, 'SOL\n');

    // Derive pool PDA
    const [poolPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('wheel_pool')],
        WHEEL_PROGRAM_ID
    );
    console.log('Pool PDA:', poolPda.toBase58());

    const poolBalance = await connection.getBalance(poolPda);
    console.log('Current pool balance:', poolBalance / 1e9, 'SOL\n');

    // Calculate correct discriminator: first 8 bytes of sha256("global:fund_pool")
    const hash = crypto.createHash('sha256').update('global:fund_pool').digest();
    const discriminator = hash.slice(0, 8);
    console.log('Discriminator:', discriminator.toString('hex'));

    const data = Buffer.alloc(8 + 8);
    discriminator.copy(data, 0);
    data.writeBigUInt64LE(amountLamports, 8);

    const fundIx = new TransactionInstruction({
        programId: WHEEL_PROGRAM_ID,
        keys: [
            { pubkey: poolPda, isSigner: false, isWritable: true },
            { pubkey: authorityKeypair.publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
    });

    const tx = new Transaction().add(fundIx);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = authorityKeypair.publicKey;
    tx.sign(authorityKeypair);

    console.log('Sending fund transaction...');
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
            console.log('✅ Treasury funded successfully!');
            const newBalance = await connection.getBalance(poolPda);
            console.log('New pool balance:', newBalance / 1e9, 'SOL');
            console.log('View on Solscan: https://solscan.io/tx/' + signature);
        }
    } catch (e: any) {
        console.error('❌ Error:', e.message);
        if (e.logs) console.log('Logs:', e.logs);
    }
}

main().catch(console.error);
