/**
 * Setup script for local development with real Solana transactions
 * 
 * This script:
 * 1. Creates a backend authority keypair
 * 2. Initializes the Stardust program
 * 3. Creates a STAR token mint (the token users hold)
 * 4. Funds test users with SOL and STAR tokens
 * 5. Saves all config to files for backend/frontend use
 */

import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    LAMPORTS_PER_SOL,
    sendAndConfirmTransaction,
    TransactionInstruction,
} from "@solana/web3.js";
import {
    createMint,
    getOrCreateAssociatedTokenAccount,
    mintTo,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddress,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("GYQP75VdPpCU1xPsJS7CUkcBqzL718j7ihNmgJ3VESd7");
const RPC_URL = "http://localhost:8899";

interface SetupConfig {
    programId: string;
    authority: {
        publicKey: string;
        secretKey: string; // base64 encoded
    };
    stardustMint: string;
    statePda: string;
    starTokenMint: string; // The token users hold to earn stardust
    testUsers: Array<{
        id: number;
        publicKey: string;
        secretKey: string; // base64 encoded
        starTokenAccount: string;
        stardustTokenAccount: string;
        starBalance: number;
    }>;
}

async function main() {
    console.log("🚀 Setting up Stardust Protocol on local validator...\n");

    const connection = new Connection(RPC_URL, "confirmed");

    // Check if validator is running
    try {
        const version = await connection.getVersion();
        console.log(`✅ Connected to Solana ${version["solana-core"]}`);
    } catch (e) {
        console.error("❌ Local validator not running. Start it with:");
        console.error("   solana-test-validator --reset --bpf-program GYQP75VdPpCU1xPsJS7CUkcBqzL718j7ihNmgJ3VESd7 target/deploy/stardust.so");
        process.exit(1);
    }

    // Create payer (use default solana keypair or generate new)
    let payer: Keypair;
    const defaultKeyPath = `${process.env.HOME}/.config/solana/id.json`;
    if (fs.existsSync(defaultKeyPath)) {
        const keyData = JSON.parse(fs.readFileSync(defaultKeyPath, "utf-8"));
        payer = Keypair.fromSecretKey(Uint8Array.from(keyData));
        console.log(`  Payer: ${payer.publicKey.toBase58()}`);
    } else {
        payer = Keypair.generate();
        console.log(`  Generated payer: ${payer.publicKey.toBase58()}`);
    }

    // Airdrop SOL to payer
    console.log("\n💰 Airdropping SOL to payer...");
    const payerBalance = await connection.getBalance(payer.publicKey);
    if (payerBalance < 10 * LAMPORTS_PER_SOL) {
        const sig = await connection.requestAirdrop(payer.publicKey, 100 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(sig);
        console.log(`  Airdropped 100 SOL to payer`);
    } else {
        console.log(`  Payer already has ${payerBalance / LAMPORTS_PER_SOL} SOL`);
    }

    // Create backend authority keypair
    console.log("\n🔑 Creating backend authority keypair...");
    const authority = Keypair.generate();
    console.log(`  Authority: ${authority.publicKey.toBase58()}`);

    // Calculate PDAs
    const [statePda, stateBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("state")],
        PROGRAM_ID
    );
    const [stardustMintPda, mintBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("stardust_mint")],
        PROGRAM_ID
    );
    console.log(`  State PDA: ${statePda.toBase58()}`);
    console.log(`  Stardust Mint PDA: ${stardustMintPda.toBase58()}`);

    // Check if already initialized
    const stateInfo = await connection.getAccountInfo(statePda);
    if (stateInfo) {
        console.log("\n⚠️  Protocol already initialized. Skipping initialization.");
    } else {
        // Initialize the protocol
        console.log("\n📝 Initializing Stardust Protocol...");

        // Load the IDL
        const idlPath = path.join(__dirname, "../target/idl/stardust.json");
        if (!fs.existsSync(idlPath)) {
            console.error("❌ IDL not found. Run 'anchor build' first.");
            process.exit(1);
        }
        const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

        // Create provider and program
        const wallet = new anchor.Wallet(payer);
        const provider = new anchor.AnchorProvider(connection, wallet, {
            commitment: "confirmed",
        });
        const program = new anchor.Program(idl, PROGRAM_ID, provider);

        // Call initialize
        try {
            const tx = await program.methods
                .initialize(authority.publicKey)
                .accounts({
                    state: statePda,
                    stardustMint: stardustMintPda,
                    payer: payer.publicKey,
                    systemProgram: SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    rent: anchor.web3.SYSVAR_RENT_PUBKEY,
                })
                .signers([payer])
                .rpc();

            console.log(`  ✅ Initialized! Tx: ${tx.slice(0, 20)}...`);
        } catch (e: any) {
            if (e.message?.includes("already in use")) {
                console.log("  ⚠️ Already initialized");
            } else {
                throw e;
            }
        }
    }

    // Create STAR token (the token users hold to earn stardust)
    console.log("\n⭐ Creating STAR token (the token users hold to earn stardust)...");
    const starTokenMint = await createMint(
        connection,
        payer,
        payer.publicKey, // mint authority
        payer.publicKey, // freeze authority
        9 // decimals
    );
    console.log(`  STAR Token Mint: ${starTokenMint.toBase58()}`);

    // Create test users
    console.log("\n👥 Creating and funding test users...");
    const testUsers: SetupConfig["testUsers"] = [];

    for (let i = 1; i <= 3; i++) {
        const user = Keypair.generate();
        console.log(`\n  User ${i}: ${user.publicKey.toBase58().slice(0, 12)}...`);

        // Airdrop SOL
        const sig = await connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(sig);
        console.log(`    ✅ Airdropped 10 SOL`);

        // Create STAR token account and mint some
        const starBalance = (i * 100) + Math.floor(Math.random() * 50); // 100-350 STAR each
        const starTokenAccount = await getOrCreateAssociatedTokenAccount(
            connection,
            payer,
            starTokenMint,
            user.publicKey
        );

        await mintTo(
            connection,
            payer,
            starTokenMint,
            starTokenAccount.address,
            payer,
            BigInt(starBalance * 1e9)
        );
        console.log(`    ✅ Minted ${starBalance} STAR`);

        // Create stardust token account (for receiving claims)
        const stardustTokenAccount = await getOrCreateAssociatedTokenAccount(
            connection,
            payer,
            stardustMintPda,
            user.publicKey
        );
        console.log(`    ✅ Created stardust token account`);

        testUsers.push({
            id: i,
            publicKey: user.publicKey.toBase58(),
            secretKey: Buffer.from(user.secretKey).toString("base64"),
            starTokenAccount: starTokenAccount.address.toBase58(),
            stardustTokenAccount: stardustTokenAccount.address.toBase58(),
            starBalance,
        });
    }

    // Save configuration
    const config: SetupConfig = {
        programId: PROGRAM_ID.toBase58(),
        authority: {
            publicKey: authority.publicKey.toBase58(),
            secretKey: Buffer.from(authority.secretKey).toString("base64"),
        },
        stardustMint: stardustMintPda.toBase58(),
        statePda: statePda.toBase58(),
        starTokenMint: starTokenMint.toBase58(),
        testUsers,
    };

    // Save to files
    const configPath = path.join(__dirname, "../local-config.json");
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`\n💾 Saved config to ${configPath}`);

    // Update test-users.json for backwards compatibility
    const testUsersPath = path.join(__dirname, "../test-users.json");
    fs.writeFileSync(testUsersPath, JSON.stringify(testUsers, null, 2));
    console.log(`💾 Saved test users to ${testUsersPath}`);

    // Print summary
    console.log("\n" + "=".repeat(60));
    console.log("                  SETUP COMPLETE");
    console.log("=".repeat(60));
    console.log(`\nProgram ID:      ${config.programId}`);
    console.log(`Authority:       ${config.authority.publicKey}`);
    console.log(`State PDA:       ${config.statePda}`);
    console.log(`Stardust Mint:   ${config.stardustMint}`);
    console.log(`STAR Token:      ${config.starTokenMint}`);
    console.log(`\nTest Users (with real STAR holdings):`);
    for (const user of testUsers) {
        console.log(`  ${user.id}. ${user.publicKey.slice(0, 12)}... - ${user.starBalance} STAR`);
    }
    console.log("\n✅ Ready! Restart the backend: bgr stardust-backend --restart");
}

main().catch((e) => {
    console.error("Setup failed:", e);
    process.exit(1);
});
