/**
 * Setup script for Stardust Protocol demo
 * Creates test users with airdropped SOL and initializes protocol
 */

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, setProvider, BN } from "@coral-xyz/anchor";
import * as fs from "fs";

const RPC_URL = "http://localhost:8899";
const PROGRAM_ID = new PublicKey("GYQP75VdPpCU1xPsJS7CUkcBqzL718j7ihNmgJ3VESd7");

// Load IDL
const idl = JSON.parse(fs.readFileSync("./target/idl/stardust.json", "utf-8"));

async function main() {
    const connection = new Connection(RPC_URL, "confirmed");

    // Load admin keypair
    const adminKeyPath = process.env.HOME + "/.config/solana/id.json";
    const adminKeypair = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(adminKeyPath, "utf-8")))
    );

    console.log("Admin:", adminKeypair.publicKey.toBase58());

    // Setup Anchor
    const wallet = new Wallet(adminKeypair);
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    setProvider(provider);

    const program = new Program(idl, PROGRAM_ID, provider);

    // Check if protocol is initialized
    const [statePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("state")],
        PROGRAM_ID
    );

    let stateAccount;
    try {
        stateAccount = await program.account.protocolState.fetch(statePda);
        console.log("Protocol already initialized");
        console.log("Authority:", stateAccount.authority.toBase58());
        console.log("Stardust Mint:", stateAccount.stardustMint.toBase58());
    } catch {
        console.log("Initializing protocol...");

        // Backend authority - generate a new one for demo
        const backendAuthority = Keypair.generate();
        console.log("Backend Authority:", backendAuthority.publicKey.toBase58());
        console.log("Backend Secret:", Buffer.from(backendAuthority.secretKey).toString("base64"));

        // Initialize
        const [mintPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("stardust_mint")],
            PROGRAM_ID
        );

        const tx = await program.methods
            .initialize(backendAuthority.publicKey)
            .accounts({
                state: statePda,
                stardustMint: mintPda,
                payer: adminKeypair.publicKey,
            })
            .rpc();

        console.log("Initialized! Tx:", tx);

        // Save backend authority for use
        fs.writeFileSync(
            "./backend/authority.json",
            JSON.stringify(Array.from(backendAuthority.secretKey))
        );
        console.log("Saved authority keypair to backend/authority.json");
    }

    // Create demo test users
    console.log("\n--- Creating Demo Users ---");
    const testUsers: Keypair[] = [];

    for (let i = 0; i < 3; i++) {
        const user = Keypair.generate();
        testUsers.push(user);

        // Airdrop SOL
        const sig = await connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(sig);

        console.log(`User ${i + 1}: ${user.publicKey.toBase58()} - 10 SOL`);
    }

    // Save test users
    const usersData = testUsers.map((u, i) => ({
        id: i + 1,
        publicKey: u.publicKey.toBase58(),
        secretKey: Buffer.from(u.secretKey).toString("base64"),
    }));

    fs.writeFileSync("./test-users.json", JSON.stringify(usersData, null, 2));
    console.log("\nSaved test users to test-users.json");
    console.log("\nSetup complete!");
}

main().catch(console.error);
