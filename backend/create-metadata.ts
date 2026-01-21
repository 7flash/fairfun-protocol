/**
 * Call create_metadata instruction on the stardust program
 * 
 * This script creates Metaplex token metadata for the stardust mint
 * so it displays properly in Phantom and other wallets.
 * 
 * Run with: bun run create-metadata.ts
 */

import { Connection, Keypair, PublicKey, TransactionInstruction, Transaction } from "@solana/web3.js";
import * as fs from "fs";

// Load mainnet config
const configPath = fs.existsSync("./mainnet-config.json")
    ? "./mainnet-config.json"
    : "../mainnet-config.json";

if (!fs.existsSync(configPath)) {
    console.error("❌ mainnet-config.json not found");
    process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
console.log("✅ Loaded config");
console.log(`   Program ID: ${config.programId}`);
console.log(`   Stardust Mint: ${config.stardustMint}`);
console.log(`   Authority: ${config.authority.publicKey}`);

// Token metadata (matching stardust-metadata.json)
const TOKEN_NAME = "Galaxy Stardust";
const TOKEN_SYMBOL = "GXYSTAR";
// Using the shelbynet hosted metadata JSON
const TOKEN_URI = "https://api.shelbynet.shelby.xyz/shelby/v1/blobs/0x2031c1b6866a0ad467fd5f0fee5850574fb3dbdb2b74105004c6fca71b7fdfc8/stardust-metadata.json";

// Metaplex Token Metadata Program ID
const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// Derive metadata PDA
function findMetadataPda(mint: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("metadata"),
            TOKEN_METADATA_PROGRAM_ID.toBuffer(),
            mint.toBuffer(),
        ],
        TOKEN_METADATA_PROGRAM_ID
    );
    return pda;
}

// Derive state PDA
function findStatePda(programId: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("state")],
        programId
    );
    return pda;
}

async function main() {
    // Setup connection
    const connection = new Connection(
        "https://mainnet.helius-rpc.com/?api-key=15319bf4-5b40-4958-ac8d-6313aa55eb92",
        "confirmed"
    );

    // Load authority keypair
    const secretKeyBytes = Buffer.from(config.authority.secretKey, "base64");
    const authority = Keypair.fromSecretKey(new Uint8Array(secretKeyBytes));
    console.log(`\n🔐 Using authority: ${authority.publicKey.toBase58()}`);

    // Derive PDAs
    const programId = new PublicKey(config.programId);
    const stardustMint = new PublicKey(config.stardustMint);
    const statePda = findStatePda(programId);
    const metadataPda = findMetadataPda(stardustMint);

    console.log(`\n📍 PDAs:`);
    console.log(`   State PDA: ${statePda.toBase58()}`);
    console.log(`   Metadata PDA: ${metadataPda.toBase58()}`);

    // Check if metadata already exists
    const metadataAccount = await connection.getAccountInfo(metadataPda);
    if (metadataAccount) {
        console.log("\n✅ Metadata already exists!");
        console.log(`   Account size: ${metadataAccount.data.length} bytes`);
        console.log(`   Owner: ${metadataAccount.owner.toBase58()}`);
        console.log("\n   To update metadata, use update_metadata instruction.");
        process.exit(0);
    }

    console.log("\n🚀 Creating metadata account...");

    // Build create_metadata instruction
    // Instruction data: [8-byte discriminator] + [name string] + [symbol string] + [uri string]
    // Anchor discriminator for create_metadata: sha256("global:create_metadata")[0..8]
    const crypto = await import("crypto");
    const hash = crypto.createHash("sha256").update("global:create_metadata").digest();
    const discriminator = hash.slice(0, 8);

    // Encode strings with Borsh (4-byte length prefix + UTF-8 bytes)
    function encodeString(s: string): Buffer {
        const strBytes = Buffer.from(s, "utf-8");
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32LE(strBytes.length, 0);
        return Buffer.concat([lenBuf, strBytes]);
    }

    const instructionData = Buffer.concat([
        discriminator,
        encodeString(TOKEN_NAME),
        encodeString(TOKEN_SYMBOL),
        encodeString(TOKEN_URI),
    ]);

    console.log(`\n📝 Instruction data (first 50 bytes): ${instructionData.slice(0, 50).toString("hex")}...`);

    // Accounts for CreateMetadata instruction (in order from struct):
    // 1. state - Protocol state PDA
    // 2. stardust_mint - The token mint
    // 3. metadata - Metadata PDA (mut)
    // 4. payer - Transaction payer (signer, mut)
    // 5. token_metadata_program - Metaplex program
    // 6. system_program - System program
    // 7. rent - Rent sysvar
    const instruction = new TransactionInstruction({
        keys: [
            { pubkey: statePda, isSigner: false, isWritable: false },
            { pubkey: stardustMint, isSigner: false, isWritable: true },
            { pubkey: metadataPda, isSigner: false, isWritable: true },
            { pubkey: authority.publicKey, isSigner: true, isWritable: true },
            { pubkey: TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
            { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
        ],
        programId,
        data: instructionData,
    });

    // Build and send transaction
    const transaction = new Transaction().add(instruction);
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = authority.publicKey;

    // Sign and send
    transaction.sign(authority);

    console.log(`\n📤 Sending transaction...`);
    try {
        const signature = await connection.sendRawTransaction(transaction.serialize());
        console.log(`   Signature: ${signature}`);

        // Wait for confirmation
        console.log(`   Waiting for confirmation...`);
        const confirmation = await connection.confirmTransaction(signature, "confirmed");

        if (confirmation.value.err) {
            console.error(`❌ Transaction failed:`, confirmation.value.err);
        } else {
            console.log(`✅ Token metadata created successfully!`);
            console.log(`   Metadata Account: ${metadataPda.toBase58()}`);
            console.log(`\n   View on Solscan: https://solscan.io/account/${metadataPda.toBase58()}`);
        }
    } catch (e: any) {
        console.error(`❌ Transaction failed:`, e.message);
        if (e.logs) {
            console.log("\n📋 Transaction logs:");
            e.logs.forEach((log: string) => console.log(`   ${log}`));
        }
    }
}

main().catch(console.error);
