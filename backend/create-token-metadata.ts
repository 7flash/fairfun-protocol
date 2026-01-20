/**
 * Create Token Metadata for Stardust Token
 * 
 * This script creates Metaplex metadata for the stardust token mint
 * so that it displays properly in Phantom and other wallets.
 * 
 * Run with: bun run scripts/create-token-metadata.ts
 */

import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
    createMetadataAccountV3,
    mplTokenMetadata,
    findMetadataPda
} from "@metaplex-foundation/mpl-token-metadata";
import {
    keypairIdentity,
    publicKey,
    createSignerFromKeypair
} from "@metaplex-foundation/umi";
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
console.log(`   Stardust Mint: ${config.stardustMint}`);
console.log(`   Authority: ${config.authority.publicKey}`);

// Token metadata
const TOKEN_NAME = "Stardust";
const TOKEN_SYMBOL = "STRDST";
const TOKEN_DESCRIPTION = "Stardust tokens from the GX402 Protocol. Earn by holding $STAR tokens.";
// For now, use a placeholder image URI - should be replaced with actual IPFS/Arweave URI
const TOKEN_IMAGE = "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png";

// Create metadata JSON (this would normally be hosted on IPFS/Arweave)
const metadataJson = {
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    description: TOKEN_DESCRIPTION,
    image: TOKEN_IMAGE,
};

console.log("\n📝 Token Metadata:");
console.log(JSON.stringify(metadataJson, null, 2));

async function main() {
    // Create Umi instance
    const umi = createUmi("https://mainnet.helius-rpc.com/?api-key=15319bf4-5b40-4958-ac8d-6313aa55eb92")
        .use(mplTokenMetadata());

    // Load authority keypair
    const secretKeyBytes = Buffer.from(config.authority.secretKey, "base64");
    const keypair = umi.eddsa.createKeypairFromSecretKey(new Uint8Array(secretKeyBytes));
    umi.use(keypairIdentity(keypair));

    console.log(`\n🔐 Using authority: ${keypair.publicKey}`);

    // Token mint
    const mint = publicKey(config.stardustMint);
    console.log(`🪙 Token mint: ${mint}`);

    // Find metadata PDA
    const metadataPda = findMetadataPda(umi, { mint });
    console.log(`📍 Metadata PDA: ${metadataPda[0]}`);

    // Check if metadata already exists
    try {
        const metadataAccount = await umi.rpc.getAccount(metadataPda[0]);
        if (metadataAccount.exists) {
            console.log("\n✅ Metadata already exists!");
            console.log("   To update metadata, use updateMetadataAccountV3 instead");
            process.exit(0);
        }
    } catch (e) {
        // Metadata doesn't exist, continue
    }

    console.log("\n🚀 Creating metadata account...");

    // Create metadata account
    // Note: This requires the mint authority to sign
    // Right now our mint authority is the STATE PDA, not the authority keypair
    // So this script won't work directly - we need to call this from the on-chain program

    console.log("\n⚠️  Note: The mint authority for stardust is the STATE PDA");
    console.log("   This means metadata must be created through the on-chain program,");
    console.log("   not from a regular wallet transaction.");
    console.log("\n   For this to work, we would need to:");
    console.log("   1. Add a `create_metadata` instruction to the Anchor program");
    console.log("   2. Have the program sign as the mint authority");
    console.log("   3. Call Metaplex CPI from within the program");
    console.log("\n   Alternative: Use a centralized metadata service or");
    console.log("   update the mint authority before creating metadata");

    // For demonstration, show what the instruction would look like:
    console.log("\n📋 Example instruction (would fail without mint authority):");

    try {
        const tx = createMetadataAccountV3(umi, {
            metadata: metadataPda,
            mint,
            mintAuthority: umi.identity,
            payer: umi.identity,
            updateAuthority: keypair.publicKey,
            data: {
                name: TOKEN_NAME,
                symbol: TOKEN_SYMBOL,
                uri: "", // Would be IPFS/Arweave URI to metadata JSON
                sellerFeeBasisPoints: 0,
                creators: null,
                collection: null,
                uses: null,
            },
            isMutable: true,
            collectionDetails: null,
        });

        console.log("   Transaction built successfully (but will fail without mint authority)");
        console.log("\n   To proceed, you have two options:");
        console.log("   A) Add CPI call to Anchor program (recommended)");
        console.log("   B) Transfer mint authority to a regular keypair temporarily");

    } catch (e: any) {
        console.log(`   Build error: ${e.message}`);
    }
}

main().catch(console.error);
