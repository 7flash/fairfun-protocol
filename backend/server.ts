import { serve } from "@ments/web";
import { measure } from "@ments/utils";
import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import * as nacl from "tweetnacl";
import bs58 from "bs58";

// Types
interface HolderEarnings {
    wallet: string;
    lifetimeEarned: bigint;
    lastUpdated: number;
}

// In-memory store for earnings
const earningsStore = new Map<string, HolderEarnings>();

// Authority keypair for signing
let authority: Keypair;

// Solana connection
let connection: Connection;

// Config
const config = {
    solanaRpc: process.env.SOLANA_RPC || "https://api.devnet.solana.com",
    mainTokenMint: process.env.MAIN_TOKEN_MINT || "So11111111111111111111111111111111111111112",
    authoritySecretKey: process.env.AUTHORITY_SECRET_KEY || "",
};

/**
 * Initialize the authority keypair
 */
function initAuthority(): Keypair {
    if (config.authoritySecretKey) {
        const secretKey = bs58.decode(config.authoritySecretKey);
        return Keypair.fromSecretKey(secretKey);
    }
    const kp = Keypair.generate();
    console.log("Generated new authority keypair:", kp.publicKey.toBase58());
    console.log("Secret key:", bs58.encode(kp.secretKey));
    return kp;
}

/**
 * Fetch current USD price for the main token
 */
async function fetchTokenPrice(): Promise<number> {
    try {
        const resp = await fetch(
            "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
        );
        const data = await resp.json();
        return data.solana?.usd || 0;
    } catch (e) {
        console.error("Failed to fetch price:", e);
        return 0;
    }
}

/**
 * Fetch token holders and their balances
 */
async function fetchTokenHolders(): Promise<Map<string, number>> {
    const holders = new Map<string, number>();

    try {
        const mintPubkey = new PublicKey(config.mainTokenMint);
        const accounts = await connection.getTokenLargestAccounts(mintPubkey);

        for (const acc of accounts.value) {
            const accountInfo = await connection.getParsedAccountInfo(acc.address);
            if (accountInfo.value?.data && "parsed" in accountInfo.value.data) {
                const owner = accountInfo.value.data.parsed.info.owner;
                const amount = Number(acc.uiAmount || 0);
                holders.set(owner, (holders.get(owner) || 0) + amount);
            }
        }
    } catch (e) {
        console.error("Failed to fetch holders:", e);
    }

    return holders;
}

/**
 * Calculate and update earnings for all holders (called every minute)
 */
async function updateEarnings() {
    return measure(async (m) => {
        const price = await m(() => fetchTokenPrice(), "fetch_price");
        const holders = await m(() => fetchTokenHolders(), "fetch_holders");

        const now = Date.now();

        for (const [wallet, balance] of holders) {
            const usdValue = balance * price;
            const stardustThisMinute = BigInt(Math.floor(usdValue * 1e9));

            const existing = earningsStore.get(wallet);
            const newLifetime = (existing?.lifetimeEarned || 0n) + stardustThisMinute;

            earningsStore.set(wallet, {
                wallet,
                lifetimeEarned: newLifetime,
                lastUpdated: now,
            });
        }

        console.log(`Updated earnings for ${holders.size} holders at price $${price}`);
    }, "update_earnings");
}

/**
 * Create Ed25519 instruction data for user claim
 */
function createSignatureData(
    userPubkey: PublicKey,
    lifetimeEarned: bigint
): { signature: string; message: string; publicKey: string; lifetimeEarned: string } {
    const message = Buffer.alloc(40);
    message.set(userPubkey.toBuffer(), 0);
    message.writeBigUInt64LE(lifetimeEarned, 32);

    const signature = nacl.sign.detached(message, authority.secretKey);

    return {
        signature: bs58.encode(signature),
        message: bs58.encode(message),
        publicKey: authority.publicKey.toBase58(),
        lifetimeEarned: lifetimeEarned.toString(),
    };
}

// Initialize
authority = initAuthority();
connection = new Connection(config.solanaRpc, "confirmed");

// Start earnings update interval (every minute)
setInterval(updateEarnings, 60 * 1000);
updateEarnings();

// JSON response helper
const json = (data: any, status = 200) =>
    new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
    });

// Request handler
async function handler(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // GET /api/authority - get backend authority pubkey
    if (method === "GET" && path === "/api/authority") {
        return json({ authority: authority.publicKey.toBase58() });
    }

    // GET /api/health - health check
    if (method === "GET" && path === "/api/health") {
        return json({
            status: "ok",
            authority: authority.publicKey.toBase58(),
            holders: earningsStore.size,
        });
    }

    // GET /api/earnings/:wallet - get earnings for wallet
    if (method === "GET" && path.startsWith("/api/earnings/")) {
        const wallet = path.replace("/api/earnings/", "");
        const earnings = earningsStore.get(wallet);

        return json({
            wallet,
            lifetimeEarned: earnings?.lifetimeEarned.toString() || "0",
            lastUpdated: earnings?.lastUpdated || null,
        });
    }

    // POST /api/signature - request claim signature
    if (method === "POST" && path === "/api/signature") {
        try {
            const body = await req.json();
            const wallet = body.wallet as string;

            if (!wallet) {
                return json({ error: "wallet required" }, 400);
            }

            const earnings = earningsStore.get(wallet);
            if (!earnings || earnings.lifetimeEarned === 0n) {
                return json({ error: "no earnings found" }, 404);
            }

            const userPubkey = new PublicKey(wallet);
            const data = createSignatureData(userPubkey, earnings.lifetimeEarned);

            return json({ ...data, wallet });
        } catch (e) {
            return json({ error: "invalid request" }, 400);
        }
    }

    // GET /api/debug/earnings - list all earnings (debug)
    if (method === "GET" && path === "/api/debug/earnings") {
        const all: any[] = [];
        for (const [wallet, data] of earningsStore) {
            all.push({
                wallet,
                lifetimeEarned: data.lifetimeEarned.toString(),
                lastUpdated: data.lastUpdated,
            });
        }
        return json({ earnings: all });
    }

    // POST /api/debug/update - trigger earnings update
    if (method === "POST" && path === "/api/debug/update") {
        await updateEarnings();
        return json({ status: "updated", holders: earningsStore.size });
    }

    return null; // Let serve handle 404
}

// Start server
serve(handler);

console.log(`Stardust Backend running on port ${process.env.BUN_PORT}`);
console.log(`Authority: ${authority.publicKey.toBase58()}`);
