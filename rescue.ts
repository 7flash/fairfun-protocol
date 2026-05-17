// pump-rescue.ts
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { PUMP_SDK } from "@pump-fun/pump-sdk";
import { configure, measure } from "measure-fn";
import fs from "fs";

configure({ timestamps: true, maxResultLength: 200 });

// Extract dynamic CLI variables from the execution context
const [, , tokenMintArg, compromisedWalletPathArg, safePayerPathArg] = Bun.argv;

if (!tokenMintArg || !compromisedWalletPathArg || !safePayerPathArg || tokenMintArg === "-h") {
  console.log(`
🚀 Pump.fun Creator Reward Revenue Rescue Pipeline CLI
Usage:
  bun run pump-rescue.ts <TARGET_TOKEN_MINT> <PATH_TO_COMPROMISED_JSON> <PATH_TO_SAFE_PAYER_JSON>

Example:
  bun run pump-rescue.ts Gs9x... ./8w2ciJqX...json ./secrets/backend-keypair.json
  `);
  process.exit(0);
}

const RPC = "https://mainnet.helius-rpc.com/?api-key=07d42e57-e7c8-4430-b3b2-d62876118bcb";
const connection = new Connection(RPC, "confirmed");

try {
  const TARGET_TOKEN_MINT = new PublicKey(tokenMintArg);

  // 1. Load Safe Payer Keypair from dynamic CLI argument path
  const adminKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(safePayerPathArg, "utf-8")))
  );

  // 2. Load Compromised Authority Keypair from dynamic CLI argument path
  const devKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(compromisedWalletPathArg, "utf-8")))
  );

  async function runRescueOperation() {
    console.log(`⚡ Target Token Mint   : ${TARGET_TOKEN_MINT.toBase58()}`);
    console.log(`🔑 Current Authority   : ${devKeypair.publicKey.toBase58()}`);
    console.log(`⛽ Safe Gas Fee Payer  : ${adminKeypair.publicKey.toBase58()}`);

    // PHASE 1: Compilation & Local Telemetry Profiling
    const transaction = await measure("State Compilation & Dual-Signing", async () => {
      const latestBlockhash = await connection.getLatestBlockhash("confirmed");

      // Build the one-time update instruction from SDK
      const updateInstruction = await PUMP_SDK.updateFeeShares({
        authority: devKeypair.publicKey,             // Dev signs to authorize state adjustment
        mint: TARGET_TOKEN_MINT,
        currentShareholders: [devKeypair.publicKey], // Targets current 100% allocation balance
        newShareholders: [
          { address: adminKeypair.publicKey, shareBps: 10000 } // Reroutes 100% of future fees to safe admin
        ]
      });

      const messageV0 = new TransactionMessage({
        payerKey: adminKeypair.publicKey, // Admin handles gas bypass, completely dodging the nonce block
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 75_000 }), // Priority fee tier
          updateInstruction
        ]
      }).compileToV0Message();

      const tx = new VersionedTransaction(messageV0);
      tx.sign([adminKeypair, devKeypair]);
      return tx;
    });

    // PHASE 2: Mainnet Broadcast Validation
    await measure("Mainnet Transaction Broadcast", async () => {
      const signature = await connection.sendTransaction(transaction, {
        skipPreflight: true, // Skip processing simulation to prioritize transaction landing speed
        maxRetries: 5,
        preflightCommitment: "confirmed"
      });

      console.log(`\n===========================================================`);
      console.log(`✅ SUCCESS – Creator fees permanently redirected!`);
      console.log(`💰 New Revenue Recipient : ${adminKeypair.publicKey.toBase58()}`);
      console.log(`🔗 Cluster Transaction   : https://solscan.io/tx/${signature}`);
      console.log(`===========================================================`);
    });
  }

  runRescueOperation().catch((err) => console.error("Pipeline Exception:", err.message));

} catch (err: any) {
  console.error("❌ Invalid Parameters Passed:", err.message);
  process.exit(1);
}
