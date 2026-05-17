#!/usr/bin/env bun
import { writeFileSync } from "fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const [, , b58Input] = Bun.argv;

if (!b58Input || b58Input === "--help" || b58Input === "-h") {
  console.log(`
🔧 Solana Public Key-Derived Keypair Generator CLI
Usage:
  bun run b58-to-json.ts <BASE58_PRIVATE_KEY>

Example:
  bun run b58-to-json.ts 4gmV7DvAeUkSWwKnHxHVbYJEMEcDLWXCPotCQYxsxw1a5ov1...
  `);
  process.exit(0);
}

try {
  // Decode Base58 string into byte buffer
  const decodedBytes = bs58.decode(b58Input.trim());
  
  // Instantly derive key pair identities
  const keypair = Keypair.fromSecretKey(new Uint8Array(decodedBytes));
  const publicKeyStr = keypair.publicKey.toBase58();
  const outputFilename = `${publicKeyStr}.json`;

  // Commit bytes to storage named after the derived public key
  writeFileSync(outputFilename, JSON.stringify(Array.from(decodedBytes)), "utf8");

  console.log(`\n===========================================================`);
  console.log(`✅ SUCCESS: Cryptographic derivation complete!`);
  console.log(`🔑 Derived Public Key : ${publicKeyStr}`);
  console.log(`📂 Saved Keypair File   : ./${outputFilename}`);
  console.log(`===========================================================`);
} catch (error: any) {
  console.error(`\n❌ CONVERSION ERROR: ${error.message}`);
  process.exit(1);
}
