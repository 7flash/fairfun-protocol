/**
 * Initialize Stardust Protocol on Mainnet
 * 
 * This script initializes the deployed stardust program with an authority keypair.
 */

import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction,
    sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import bs58 from "bs58";

const PROGRAM_ID = new PublicKey("HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A");
const RPC_URL = "https://api.mainnet-beta.solana.com";

// Anchor instruction discriminators (first 8 bytes of sha256("global:initialize"))
const INITIALIZE_DISCRIMINATOR = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);

async function main() {
    console.log("🚀 Initializing Stardust Protocol on Mainnet...\n");

    const connection = new Connection(RPC_URL, "confirmed");

    // Load deployer keypair
    const deployerKeyPath = `${process.env.HOME}/.config/solana/mainnet-deployer.json`;
    if (!fs.existsSync(deployerKeyPath)) {
        console.error("❌ Deployer keypair not found at", deployerKeyPath);
        process.exit(1);
    }
    const keyData = JSON.parse(fs.readFileSync(deployerKeyPath, "utf-8"));
    const payer = Keypair.fromSecretKey(Uint8Array.from(keyData));
    console.log(`  Payer: ${payer.publicKey.toBase58()}`);

    // Check balance
    const balance = await connection.getBalance(payer.publicKey);
    console.log(`  Balance: ${balance / 1e9} SOL\n`);

    // Generate or load authority keypair for signing claims
    // This is the key that will sign claim messages from the backend
    let authority: Keypair;
    const authorityKeyPath = path.join(__dirname, "../mainnet-authority.json");

    if (fs.existsSync(authorityKeyPath)) {
        const authorityData = JSON.parse(fs.readFileSync(authorityKeyPath, "utf-8"));
        authority = Keypair.fromSecretKey(Uint8Array.from(authorityData));
        console.log(`  Loaded existing authority: ${authority.publicKey.toBase58()}`);
    } else {
        authority = Keypair.generate();
        fs.writeFileSync(authorityKeyPath, JSON.stringify(Array.from(authority.secretKey)));
        console.log(`  Generated new authority: ${authority.publicKey.toBase58()}`);
        console.log(`  ⚠️  SAVE THIS KEY! It's required for the backend to sign claims.`);
    }

    // Calculate PDAs
    const [statePda, stateBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("state")],
        PROGRAM_ID
    );
    const [stardustMintPda, mintBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("stardust_mint")],
        PROGRAM_ID
    );
    console.log(`\n  State PDA: ${statePda.toBase58()}`);
    console.log(`  Stardust Mint PDA: ${stardustMintPda.toBase58()}`);

    // Check if already initialized
    const stateInfo = await connection.getAccountInfo(statePda);
    if (stateInfo) {
        console.log("\n⚠️  Protocol already initialized!");
        console.log("   State account exists with", stateInfo.data.length, "bytes");

        // Save config anyway
        saveConfig(authority, statePda, stardustMintPda);
        return;
    }

    // Build initialize instruction
    // Instruction data: [8-byte discriminator][32-byte authority pubkey]
    const instructionData = Buffer.concat([
        INITIALIZE_DISCRIMINATOR,
        authority.publicKey.toBuffer(),
    ]);

    const initializeIx = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
            { pubkey: statePda, isSigner: false, isWritable: true },
            { pubkey: stardustMintPda, isSigner: false, isWritable: true },
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
        ],
        data: instructionData,
    });

    console.log("\n📝 Sending initialize transaction...");

    try {
        const tx = new Transaction().add(initializeIx);
        const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
            commitment: "confirmed",
        });

        console.log(`  ✅ Initialized! Tx: ${sig}`);
        console.log(`     View on Solscan: https://solscan.io/tx/${sig}`);
    } catch (e: any) {
        console.error("❌ Initialize failed:", e.message);
        if (e.logs) {
            console.error("Logs:", e.logs);
        }
        process.exit(1);
    }

    // Save configuration
    saveConfig(authority, statePda, stardustMintPda);
}

function saveConfig(authority: Keypair, statePda: PublicKey, stardustMintPda: PublicKey) {
    const config = {
        programId: PROGRAM_ID.toBase58(),
        authority: {
            publicKey: authority.publicKey.toBase58(),
            secretKey: Buffer.from(authority.secretKey).toString("base64"),
        },
        stardustMint: stardustMintPda.toBase58(),
        statePda: statePda.toBase58(),
        network: "mainnet-beta",
        rpcUrl: RPC_URL,
    };

    const configPath = path.join(__dirname, "../mainnet-config.json");
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`\n💾 Saved config to ${configPath}`);

    // Print summary
    console.log("\n" + "=".repeat(60));
    console.log("            MAINNET INITIALIZATION COMPLETE");
    console.log("=".repeat(60));
    console.log(`\nProgram ID:      ${config.programId}`);
    console.log(`Authority:       ${config.authority.publicKey}`);
    console.log(`State PDA:       ${config.statePda}`);
    console.log(`Stardust Mint:   ${config.stardustMint}`);
    console.log(`\n⚠️  IMPORTANT: Update backend/.config.toml with:`);
    console.log(`   SOLANA_RPC = "${RPC_URL}"`);
    console.log(`   AUTHORITY_SECRET_KEY = "<base58 encoded from mainnet-authority.json>"`);
}

main().catch((e) => {
    console.error("Initialization failed:", e);
    process.exit(1);
});
