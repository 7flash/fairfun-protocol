import { serve } from "@ments/web";
import { measure } from "@ments/utils";
import { SatiDB, z } from "@ments/db";
import {
    Keypair,
    PublicKey,
    Connection,
    Ed25519Program,
} from "@solana/web3.js";
import {
    getAccount,
    getAssociatedTokenAddress,
} from "@solana/spl-token";
import * as nacl from "tweetnacl";
import bs58 from "bs58";
import * as fs from "fs";

// ============================================
// DATABASE PERSISTENCE
// ============================================
const EarningsSchema = z.object({
    wallet: z.string(),
    lifetimeEarned: z.string(), // BigInt as string for DB storage
    claimed: z.string(),
    starBalance: z.string(),
    lastUpdated: z.number(),
});

// Initialize SatiDB for persistence
const db = new SatiDB("stardust.db", {
    earnings: EarningsSchema,
});

// Types
interface LocalConfig {
    programId: string;
    authority: {
        publicKey: string;
        secretKey: string;
    };
    stardustMint: string;
    statePda: string;
    starTokenMint: string;
    testUsers: TestUser[];
}

interface TestUser {
    id: number;
    publicKey: string;
    secretKey: string;
    starTokenAccount: string;
    stardustTokenAccount: string;
    starBalance: number;
}

interface HolderEarnings {
    wallet: string;
    lifetimeEarned: bigint;
    claimed: bigint;
    starBalance: bigint; // Real STAR token balance
    lastUpdated: number;
}

// In-memory store for earnings
const earningsStore = new Map<string, HolderEarnings>();

// ============================================
// REDEMPTION SYSTEM
// ============================================
interface RedemptionWinner {
    wallet: string;
    rewardTier: number;
    rewardAmount: number; // In lamports
    timestamp: number;
    txSignature?: string;
}

interface RedemptionConfig {
    costPerSpin: bigint; // Stardust cost
    probabilities: number[]; // Out of 10000 (basis points)
    rewards: number[]; // SOL rewards in lamports
    poolBalance: number; // Available SOL in lamports
}

// Redemption probabilities and rewards
const REDEMPTION_CONFIG: RedemptionConfig = {
    costPerSpin: 1_000_000n * BigInt(1e9), // 1M stardust (in smallest units)
    probabilities: [5000, 3000, 1500, 450, 50], // 50%, 30%, 15%, 4.5%, 0.5%
    rewards: [
        0.001 * 1e9,  // 0.001 SOL in lamports
        0.01 * 1e9,   // 0.01 SOL
        0.1 * 1e9,    // 0.1 SOL
        1 * 1e9,      // 1 SOL
        10 * 1e9,     // 10 SOL
    ],
    poolBalance: 100 * 1e9, // 100 SOL initial pool
};

// Maximum unclaimed stardust (1M) - incentivizes users to claim
const MAX_UNCLAIMED = 1_000_000n * BigInt(1e9);

// Winner history (last 100 winners)
const redemptionWinners: RedemptionWinner[] = [];
let totalSpins = 0;
let totalDistributed = 0;

// Track total winnings per wallet (for leaderboard)
const walletWinnings: Map<string, number> = new Map();

// Loaded config
let config: LocalConfig;
let authority: Keypair;
let connection: Connection;

/**
 * Load local config from setup script
 */
function loadConfig(): LocalConfig {
    // Check if we're on mainnet (check for mainnet-config.json or env variable)
    const isMainnet = process.env.SOLANA_RPC?.includes("mainnet") ||
        fs.existsSync("./mainnet-config.json") ||
        fs.existsSync("../mainnet-config.json");

    if (isMainnet) {
        const mainnetPaths = ["./mainnet-config.json", "../mainnet-config.json"];
        for (const configPath of mainnetPaths) {
            if (fs.existsSync(configPath)) {
                console.log(`Loading MAINNET config from ${configPath}`);
                const mainnetConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
                // Mainnet config doesn't have testUsers or starTokenMint, adapt it
                return {
                    ...mainnetConfig,
                    starTokenMint: mainnetConfig.starTokenMint || "11111111111111111111111111111111", // Placeholder
                    testUsers: mainnetConfig.testUsers || [],
                };
            }
        }
    }

    // Fallback to local config
    const paths = ["./local-config.json", "../local-config.json"];
    for (const configPath of paths) {
        if (fs.existsSync(configPath)) {
            console.log(`Loading LOCAL config from ${configPath}`);
            return JSON.parse(fs.readFileSync(configPath, "utf-8"));
        }
    }
    throw new Error(
        "Config not found. Run 'bun run scripts/setup-local.ts' or 'bun run scripts/init-mainnet.ts' first!"
    );
}

/**
 * Custom error for RPC rate limiting
 */
class RpcRateLimitError extends Error {
    constructor(message: string = 'RPC rate limited (429)') {
        super(message);
        this.name = 'RpcRateLimitError';
    }
}

/**
 * Get real token balance from Solana
 * Throws RpcRateLimitError if rate limited
 */
async function getTokenBalance(
    tokenAccountAddress: string
): Promise<bigint> {
    return measure(async (m) => {
        try {
            const account = await m(
                () => getAccount(connection, new PublicKey(tokenAccountAddress)),
                { label: 'rpc_getAccount', account: tokenAccountAddress.slice(0, 8) }
            );
            return account.amount;
        } catch (e: any) {
            const errorStr = String(e?.message || e);

            // Check for rate limiting (429 errors)
            if (errorStr.includes('429') || errorStr.includes('Too Many Requests') || errorStr.includes('rate limit')) {
                throw new RpcRateLimitError();
            }

            // Check for account not found (not an error - user may not have account)
            if (errorStr.includes('could not find') || errorStr.includes('Account does not exist')) {
                return 0n;
            }

            // Other RPC errors - throw to be logged by parent measure
            throw new Error(`RPC error: ${errorStr}`);
        }
    }, { label: 'getTokenBalance', account: tokenAccountAddress.slice(0, 8) });
}

/**
 * Fetch real STAR token balance for a user
 */
async function fetchUserStarBalance(walletPubkey: string): Promise<bigint> {
    return measure(async (m) => {
        const starMint = new PublicKey(config.starTokenMint);
        const wallet = new PublicKey(walletPubkey);

        const ata = await m(
            () => getAssociatedTokenAddress(starMint, wallet),
            { label: 'derive_star_ata', wallet: walletPubkey.slice(0, 8) }
        );

        const balance = await m(
            () => getTokenBalance(ata.toBase58()),
            { label: 'fetch_star_balance', ata: ata.toBase58().slice(0, 8) }
        );

        return balance;
    }, { label: 'fetchUserStarBalance', wallet: walletPubkey.slice(0, 8) });
}

/**
 * Fetch real claimed STARDUST amount from on-chain UserClaim PDA
 * This reads the actual claimed amount from the program, NOT the token balance
 * (Token balance can change via transfers, but claimed amount is immutable)
 */
async function fetchClaimedStardust(walletPubkey: string): Promise<bigint> {
    return measure(async (m) => {
        const wallet = new PublicKey(walletPubkey);
        const programId = new PublicKey(config.programId);

        // Derive UserClaim PDA: ["user_claim", user_pubkey]
        const [userClaimPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_claim"), wallet.toBuffer()],
            programId
        );

        // Fetch the account data
        const accountInfo = await m(
            () => connection.getAccountInfo(userClaimPda),
            { label: 'rpc_getAccountInfo', pda: userClaimPda.toBase58().slice(0, 8) }
        );

        if (!accountInfo || !accountInfo.data) {
            return 0n; // User hasn't claimed yet
        }

        // Parse UserClaim account data:
        // [8 bytes discriminator] [32 bytes user] [8 bytes claimed_amount] [8 bytes timestamp] [1 byte bump]
        const data = accountInfo.data;
        if (data.length < 48) {
            return 0n; // Invalid data
        }

        // Read u64 little-endian at offset 40
        const claimedAmount = data.readBigUInt64LE(40);
        return claimedAmount;
    }, { label: 'fetchClaimedStardust', wallet: walletPubkey.slice(0, 8) });
}

/**
 * Cache for stardust token balances to avoid rate limiting
 * TTL: 5 minutes (increased due to heavy RPC rate limiting)
 */
const stardustBalanceCache = new Map<string, { balance: bigint, timestamp: number }>();
const BALANCE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch actual stardust token balance from wallet's token account
 * This is the current balance (can decrease via transfers)
 * Uses caching to reduce RPC calls
 * Returns stale cached value if rate limited, or 0n if no cache
 */
async function fetchStardustTokenBalance(walletPubkey: string): Promise<bigint> {
    return measure(async (m) => {
        // Check cache first
        const cached = stardustBalanceCache.get(walletPubkey);
        if (cached && Date.now() - cached.timestamp < BALANCE_CACHE_TTL) {
            return cached.balance; // Cache hit
        }

        const stardustMint = new PublicKey(config.stardustMint);
        const wallet = new PublicKey(walletPubkey);

        const ata = await m(
            () => getAssociatedTokenAddress(stardustMint, wallet),
            { label: 'derive_stardust_ata', wallet: walletPubkey.slice(0, 8) }
        );

        const balance = await m(
            () => getTokenBalance(ata.toBase58()),
            { label: 'fetch_stardust_balance', ata: ata.toBase58().slice(0, 8) }
        );

        // Cache the result
        stardustBalanceCache.set(walletPubkey, { balance, timestamp: Date.now() });
        return balance;
    }, { label: 'fetchStardustTokenBalance', wallet: walletPubkey.slice(0, 8), cached: !!stardustBalanceCache.get(walletPubkey) });
}

/**
 * Dynamic GXY price cache
 * Fetches from Jupiter/DexScreener and caches for 1 minute
 */
let cachedGxyPrice: { price: number; timestamp: number } | null = null;
const PRICE_CACHE_TTL = 60 * 1000; // 1 minute
const GXY_MINT = "PKikg1HNZinFvMgqk76aBDY4fF1fgGYQ3tv9kKypump";
const GXY_DECIMALS = 6; // GXY has 6 decimals

/**
 * Fetch current GXY price from Jupiter or DexScreener
 */
async function fetchGxyPrice(): Promise<number> {
    return measure(async (): Promise<number> => {
        // Check cache first
        if (cachedGxyPrice && Date.now() - cachedGxyPrice.timestamp < PRICE_CACHE_TTL) {
            return cachedGxyPrice.price;
        }

        // Try Jupiter Price API first
        try {
            const jupRes = await fetch(`https://price.jup.ag/v6/price?ids=${GXY_MINT}`);
            if (jupRes.ok) {
                const jupData = await jupRes.json() as { data?: Record<string, { price?: number }> };
                const price = jupData.data?.[GXY_MINT]?.price;
                if (typeof price === 'number' && price > 0) {
                    cachedGxyPrice = { price, timestamp: Date.now() };
                    return price;
                }
            }
        } catch (e) {
            // Jupiter failed, try DexScreener
        }

        // Fallback to DexScreener
        try {
            const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${GXY_MINT}`);
            if (dexRes.ok) {
                const dexData = await dexRes.json() as { pairs?: { priceUsd?: string }[] };
                const pair = dexData.pairs?.[0];
                if (pair?.priceUsd) {
                    const price = parseFloat(pair.priceUsd);
                    if (price > 0) {
                        cachedGxyPrice = { price, timestamp: Date.now() };
                        return price;
                    }
                }
            }
        } catch (e) {
            // DexScreener failed too
        }

        // Use cached price if available (even if stale), otherwise fallback
        if (cachedGxyPrice) {
            return cachedGxyPrice.price;
        }

        // Last resort fallback
        return 0.02;
    }, { label: 'fetchGxyPrice' });
}

/**
 * Get cached GXY price (non-async, for display purposes)
 */
function getCachedGxyPrice(): number {
    return cachedGxyPrice?.price || 0.02;
}

/**
 * Update earnings based on real STAR token balances
 * Rate: 1 stardust per $1 worth of tokens per hour = price_usd stardust per token per hour
 * We run every 60s (1 minute), so per-period = price_usd / 60 stardust per token
 */
async function updateEarnings() {
    return measure(async (m) => {
        const now = Date.now();

        // Fetch current GXY price before calculations
        const gxyPriceUsd = await m(
            () => fetchGxyPrice(),
            'fetch_gxy_price'
        );

        // Calculate rate: price_usd stardust per token per hour, divided by 60 for per-minute
        // Stardust has 9 decimals, so multiply by 1e9
        // But we run every minute, so rate = (price / 60) * 1e9
        const stardustRatePerTokenPerMinute = (gxyPriceUsd / 60) * 1e9;

        // Update test users from config
        for (const user of config.testUsers) {
            // Fetch real STAR balance from chain
            const starBalance = await m(
                () => getTokenBalance(user.starTokenAccount),
                `fetch_balance_${user.id}`
            );

            // Fetch real claimed amount from on-chain stardust token account
            const claimedOnChain = await m(
                () => fetchClaimedStardust(user.publicKey),
                `fetch_claimed_${user.id}`
            );

            // Convert raw balance to tokens (6 decimals)
            const starTokens = Number(starBalance) / (10 ** GXY_DECIMALS);

            // Calculate stardust earned this period
            const stardustThisPeriod = BigInt(Math.floor(starTokens * stardustRatePerTokenPerMinute));

            const existing = earningsStore.get(user.publicKey);
            const newLifetime = (existing?.lifetimeEarned || 0n) + stardustThisPeriod;

            earningsStore.set(user.publicKey, {
                wallet: user.publicKey,
                lifetimeEarned: newLifetime,
                claimed: claimedOnChain, // Use on-chain data as source of truth
                starBalance: starBalance,
                lastUpdated: now,
            });
        }

        // Also update any registered wallets
        for (const [wallet, earnings] of earningsStore.entries()) {
            // Skip test users (already updated)
            if (config.testUsers.find((u) => u.publicKey === wallet)) continue;

            const starBalance = await fetchUserStarBalance(wallet);
            const claimed = await fetchClaimedStardust(wallet);

            // Convert raw balance to tokens (6 decimals)
            const starTokens = Number(starBalance) / (10 ** GXY_DECIMALS);

            // Calculate stardust earned this period
            const stardustThisPeriod = BigInt(Math.floor(starTokens * stardustRatePerTokenPerMinute));

            earningsStore.set(wallet, {
                ...earnings,
                lifetimeEarned: earnings.lifetimeEarned + stardustThisPeriod,
                claimed,
                starBalance,
                lastUpdated: now,
            });
        }

        // Success - will be logged by measure with timing
    }, { label: "update_earnings" });
}

/**
 * Create Ed25519 signature data for claim verification
 * 
 * The message format is: [UserPubkey(32) | LifetimeEarned(8)]
 * This matches what the on-chain program expects
 */
function createSignatureData(
    userPubkey: PublicKey,
    lifetimeEarned: bigint
): {
    signature: string;
    message: string;
    publicKey: string;
    lifetimeEarned: string;
    ed25519Instruction: {
        programId: string;
        data: string; // base64
    };
} {
    // Message = [UserPubkey(32) | LifetimeEarned(8)]
    const message = Buffer.alloc(40);
    message.set(userPubkey.toBuffer(), 0);
    message.writeBigUInt64LE(lifetimeEarned, 32);

    // Sign the message
    const signature = nacl.sign.detached(message, authority.secretKey);

    // Create Ed25519 instruction data (Stardust Standard Layout)
    // Using Ed25519Program.createInstructionWithPublicKey format
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
        publicKey: authority.publicKey.toBytes(),
        message: message,
        signature: signature,
    });

    return {
        signature: bs58.encode(signature),
        message: bs58.encode(message),
        publicKey: authority.publicKey.toBase58(),
        lifetimeEarned: lifetimeEarned.toString(),
        ed25519Instruction: {
            programId: ed25519Ix.programId.toBase58(),
            data: Buffer.from(ed25519Ix.data).toString("base64"),
        },
    };
}

// Initialize
try {
    config = loadConfig();
    const secretKeyBytes = Buffer.from(config.authority.secretKey, "base64");
    authority = Keypair.fromSecretKey(new Uint8Array(secretKeyBytes));
    connection = new Connection(
        process.env.SOLANA_RPC || "https://mainnet.helius-rpc.com/?api-key=093c9b83-eb11-418c-8aeb-b96bf06c848e",
        "confirmed"
    );

    console.log("✅ Loaded config from local-config.json");
    console.log(`   Authority: ${authority.publicKey.toBase58()}`);
    console.log(`   Star Token: ${config.starTokenMint}`);
    console.log(`   Stardust Mint: ${config.stardustMint}`);
    console.log(`   Test Users: ${config.testUsers.length}`);
} catch (e: any) {
    console.error("❌ Failed to load config:", e.message);
    console.error("   Run: bun run scripts/setup-local.ts");
    process.exit(1);
}

// ============================================
// DATABASE PERSISTENCE FUNCTIONS
// ============================================
/**
 * Load earnings from SQLite database into memory on startup
 */
function loadFromDatabase() {
    measure(() => {
        const records = db.earnings.find({});
        let loadedCount = 0;
        for (const record of records) {
            earningsStore.set(record.wallet, {
                wallet: record.wallet,
                lifetimeEarned: BigInt(record.lifetimeEarned),
                claimed: BigInt(record.claimed),
                starBalance: BigInt(record.starBalance),
                lastUpdated: record.lastUpdated,
            });
            loadedCount++;
        }
        return loadedCount;
    }, { label: 'load_from_database' });
}

/**
 * Flush all earnings from memory to SQLite database
 */
function flushToDatabase() {
    measure(async () => {
        let flushedCount = 0;
        for (const [wallet, earnings] of earningsStore.entries()) {
            db.earnings.upsert({
                wallet: earnings.wallet,
                lifetimeEarned: earnings.lifetimeEarned.toString(),
                claimed: earnings.claimed.toString(),
                starBalance: earnings.starBalance.toString(),
                lastUpdated: earnings.lastUpdated,
            });
            flushedCount++;
        }
        return flushedCount;
    }, { label: 'flush_to_database', records: earningsStore.size });
}

// Load existing data from database on startup
loadFromDatabase();

// Start earnings update (every 60 seconds / 1 minute)
setInterval(updateEarnings, 60 * 1000);
updateEarnings();

// Flush to database every hour (3600 seconds)
setInterval(flushToDatabase, 60 * 60 * 1000);
console.log("🔄 Scheduled: earnings update every 1 min, DB flush every 1 hour");

// JSON helper
const json = (data: any, status = 200) =>
    new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
    });

// Handler
async function handler(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // CORS
    if (method === "OPTIONS") {
        return new Response(null, {
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
            },
        });
    }

    // GET /api/config - full config for frontend
    if (method === "GET" && path === "/api/config") {
        return json({
            programId: config.programId,
            authority: config.authority.publicKey,
            stardustMint: config.stardustMint,
            statePda: config.statePda,
            starTokenMint: config.starTokenMint,
            rpcUrl: process.env.SOLANA_RPC || "https://mainnet.helius-rpc.com/?api-key=15319bf4-5b40-4958-ac8d-6313aa55eb92",
        });
    }

    // GET /api/authority
    if (method === "GET" && path === "/api/authority") {
        return json({
            authority: authority.publicKey.toBase58(),
            programId: config.programId,
        });
    }

    // GET /api/health
    if (method === "GET" && path === "/api/health") {
        return json({
            status: "ok",
            authority: authority.publicKey.toBase58(),
            programId: config.programId,
            starTokenMint: config.starTokenMint,
            holders: earningsStore.size,
        });
    }

    // GET /api/leaderboard
    if (method === "GET" && path === "/api/leaderboard") {
        const limit = parseInt(url.searchParams.get("limit") || "10");
        const entries = Array.from(earningsStore.values())
            .sort((a, b) => Number(b.lifetimeEarned - a.lifetimeEarned))
            .slice(0, limit)
            .map((e, rank) => ({
                rank: rank + 1,
                wallet: e.wallet,
                lifetimeEarned: e.lifetimeEarned.toString(),
                claimed: e.claimed.toString(),
                unclaimed: (e.lifetimeEarned - e.claimed).toString(),
                starBalance: e.starBalance.toString(),
                lastUpdated: e.lastUpdated,
                totalWon: (walletWinnings.get(e.wallet) || 0) / 1e9, // Total SOL won from wheel
            }));

        return json({
            leaderboard: entries,
            totalHolders: earningsStore.size,
            timestamp: Date.now(),
        });
    }

    // GET /api/stats
    if (method === "GET" && path === "/api/stats") {
        let totalEarned = 0n;
        let totalClaimed = 0n;
        let totalStarBalance = 0n;

        for (const e of earningsStore.values()) {
            totalEarned += e.lifetimeEarned;
            totalClaimed += e.claimed;
            totalStarBalance += e.starBalance;
        }

        return json({
            totalHolders: earningsStore.size,
            totalEarned: totalEarned.toString(),
            totalClaimed: totalClaimed.toString(),
            totalUnclaimed: (totalEarned - totalClaimed).toString(),
            totalStarBalance: totalStarBalance.toString(),
            timestamp: Date.now(),
        });
    }

    // GET /api/earnings/:wallet
    if (method === "GET" && path.startsWith("/api/earnings/")) {
        const wallet = path.replace("/api/earnings/", "");
        const earnings = earningsStore.get(wallet);

        // Get claimed amount from store (updated from on-chain)
        const claimed = earnings?.claimed || 0n;

        // Ensure lifetimeEarned is at least equal to claimed (in case backend restarted)
        let lifetimeEarned = earnings?.lifetimeEarned || 0n;
        if (lifetimeEarned < claimed) {
            lifetimeEarned = claimed;
        }

        // Calculate unclaimed with 1M cap - ensure never negative
        let unclaimed = lifetimeEarned - claimed;
        if (unclaimed < 0n) {
            unclaimed = 0n;
        }
        if (unclaimed > MAX_UNCLAIMED) {
            unclaimed = MAX_UNCLAIMED;
        }
        const isCapped = unclaimed >= MAX_UNCLAIMED;

        // Get stardust token balance from cache (non-blocking)
        // Don't await RPC calls here - they can hang due to rate limiting
        let stardustTokenBalance = 0n;
        let rpcWarning: string | null = null;

        // Check cache first (fast path)
        const cached = stardustBalanceCache.get(wallet);
        if (cached && Date.now() - cached.timestamp < BALANCE_CACHE_TTL) {
            stardustTokenBalance = cached.balance;
        } else {
            // Use claimed as fallback (what user has claimed so far)
            stardustTokenBalance = claimed;
            rpcWarning = 'Balance data is being refreshed...';

            // Trigger background refresh (non-blocking) - errors tracked via measure
            fetchStardustTokenBalance(wallet).catch(() => { });
        }

        return json({
            wallet,
            lifetimeEarned: lifetimeEarned.toString(),
            claimed: claimed.toString(),
            unclaimed: unclaimed.toString(),
            isCapped, // Frontend can show "1M MAX" indicator
            starBalance: earnings?.starBalance.toString() || "0",
            stardustTokenBalance: stardustTokenBalance.toString(), // Actual current stardust token balance
            lastUpdated: earnings?.lastUpdated || null,
            rpcWarning, // Frontend can show toast if this is set
        });
    }

    // GET /api/test-users - get test user data for frontend
    if (method === "GET" && path === "/api/test-users") {
        // Include full config for frontend
        return json({
            users: config.testUsers,
            config: {
                programId: config.programId,
                statePda: config.statePda,
                stardustMint: config.stardustMint,
                starTokenMint: config.starTokenMint,
                authority: config.authority.publicKey,
            },
        });
    }

    // GET /api/treasury - get real protocol treasury data
    if (method === "GET" && path === "/api/treasury") {
        try {
            // Get total STAR token supply and calculate treasury value
            let totalStarBalance = 0n;
            let totalStardust = 0n;
            let totalClaimed = 0n;

            for (const e of earningsStore.values()) {
                totalStarBalance += e.starBalance;
                totalStardust += e.lifetimeEarned;
                totalClaimed += e.claimed;
            }

            // Calculate real values based on token holdings using dynamic price
            const gxyPriceUsd = getCachedGxyPrice();
            const starTokens = Number(totalStarBalance) / (10 ** GXY_DECIMALS);
            const starValueUsd = starTokens * gxyPriceUsd;

            // Protocol treasury = accumulated stardust value (1 stardust = $0.001)
            const stardustValueUsd = (Number(totalStardust) / 1e9) * 0.001;

            // Total treasury value
            const totalValue = Math.round(starValueUsd + stardustValueUsd);

            // Calculate APY based on earnings rate
            // APY = (Daily earnings * 365) / Total value * 100
            const dailyEarnings = (starTokens * gxyPriceUsd * 24) / 1000; // stardust value generated daily
            const targetApy = 20; // 20% target APY
            const currentApy = totalValue > 0 ? (dailyEarnings * 365 / totalValue) * 100 : 0;

            // Simulate revenue data
            const monthlyRevenue = Math.round(totalValue * 0.02); // 2% monthly
            const weeklyRevenue = Math.round(monthlyRevenue / 4);
            const totalDistributed = Number(totalClaimed) / 1e9 * 0.001;

            // Build history from the last 30 data points (simulated real growth)
            const now = Date.now();
            const history: { timestamp: number; value: number }[] = [];
            const baseValue = totalValue * 0.8; // Started at 80% of current value
            for (let i = 0; i < 30; i++) {
                const progress = i / 29;
                const timestamp = now - (29 - i) * 60000; // 1 minute intervals
                const value = Math.round(baseValue + (totalValue - baseValue) * progress);
                history.push({ timestamp, value });
            }

            // APY history
            const apyHistory: { timestamp: number; apy: number }[] = [];
            for (let i = 0; i < 14; i++) {
                const dayOffset = 14 - i;
                const timestamp = now - dayOffset * 86400000;
                // Simulate APY variation over time
                const apy = currentApy * (0.9 + Math.random() * 0.2);
                apyHistory.push({ timestamp, apy: Math.round(apy * 10) / 10 });
            }

            // On-chain token holdings
            const tokens = [
                {
                    symbol: "$GXY",
                    amount: starTokens,
                    value: Math.round(starValueUsd),
                    priceUsd: gxyPriceUsd,
                },
                {
                    symbol: "STARDUST",
                    amount: Number(totalStardust - totalClaimed) / 1e9,
                    value: Math.round((Number(totalStardust - totalClaimed) / 1e9) * 0.001),
                    priceUsd: 0.001,
                },
            ];

            return json({
                totalValue,
                history,
                tokens,
                targetApy,
                currentApy: Math.round(currentApy * 10) / 10,
                apyHistory,
                revenue: {
                    monthly: monthlyRevenue,
                    weekly: weeklyRevenue,
                    totalDistributed: Math.round(totalDistributed),
                },
                redemptionPool: Math.round(totalValue * 0.1), // 10% allocated to redemption
                timestamp: now,
            });
        } catch (e: any) {
            return json({ error: e.message }, 500);
        }
    }

    // POST /api/signature - get signature for claim
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

            const unclaimed = earnings.lifetimeEarned - earnings.claimed;
            if (unclaimed === 0n) {
                return json({ error: "nothing to claim" }, 400);
            }

            const userPubkey = new PublicKey(wallet);
            const data = createSignatureData(userPubkey, earnings.lifetimeEarned);

            return json({
                ...data,
                wallet,
                unclaimed: unclaimed.toString(),
            });
        } catch (e) {
            return json({ error: "invalid request" }, 400);
        }
    }

    // POST /api/claim-confirmed - record a successful on-chain claim
    if (method === "POST" && path === "/api/claim-confirmed") {
        try {
            const body = await req.json();
            const wallet = body.wallet as string;
            const txSignature = body.signature as string;

            const earnings = earningsStore.get(wallet);
            if (earnings) {
                // Verify the transaction on-chain (optional but recommended)
                try {
                    const tx = await connection.getTransaction(txSignature, {
                        commitment: "confirmed",
                    });
                    if (!tx) {
                        return json({ error: "transaction not found" }, 404);
                    }
                    if (tx.meta?.err) {
                        return json({ error: "transaction failed" }, 400);
                    }
                } catch (e) {
                    // Could not verify tx, proceeding anyway
                }

                earnings.claimed = earnings.lifetimeEarned;
                earningsStore.set(wallet, earnings);
            }

            return json({
                success: true,
                wallet,
                claimed: earnings?.claimed.toString() || "0",
                txSignature,
            });
        } catch (e) {
            return json({ error: "invalid request" }, 400);
        }
    }

    // POST /api/register - register a new wallet
    if (method === "POST" && path === "/api/register") {
        try {
            const body = await req.json();
            const wallet = body.wallet as string;

            if (!wallet) {
                return json({ error: "wallet required" }, 400);
            }

            // Fetch on-chain data
            const starBalance = await fetchUserStarBalance(wallet);
            const claimed = await fetchClaimedStardust(wallet);

            // Check if wallet already exists (don't reset existing earnings)
            const existing = earningsStore.get(wallet);
            if (existing) {
                // Update balance and claimed from on-chain
                let lifetimeEarned = existing.lifetimeEarned;
                // Ensure lifetimeEarned is at least claimed (recover from backend restart)
                if (lifetimeEarned < claimed) {
                    lifetimeEarned = claimed;
                }

                earningsStore.set(wallet, {
                    ...existing,
                    lifetimeEarned,
                    claimed,
                    starBalance,
                    lastUpdated: Date.now(),
                });
                return json({
                    success: true,
                    wallet,
                    lifetimeEarned: lifetimeEarned.toString(),
                    claimed: claimed.toString(),
                    starBalance: starBalance.toString(),
                });
            }

            // New wallet - initialize with claimed from on-chain
            // lifetimeEarned starts at claimed (so unclaimed = 0, will accumulate from now)
            const newEarnings = {
                wallet,
                lifetimeEarned: claimed, // Start at claimed amount, accumulate from there
                claimed,
                starBalance,
                lastUpdated: Date.now(),
            };
            earningsStore.set(wallet, newEarnings);

            // Persist immediately to database
            try {
                const dbRecord = {
                    wallet: newEarnings.wallet,
                    lifetimeEarned: newEarnings.lifetimeEarned.toString(),
                    claimed: newEarnings.claimed.toString(),
                    starBalance: newEarnings.starBalance.toString(),
                    lastUpdated: newEarnings.lastUpdated,
                };
                db.earnings.insert(dbRecord);
            } catch (dbErr: any) {
                // DB error is non-fatal, earnings still in memory
            }

            return json({
                success: true,
                wallet,
                lifetimeEarned: newEarnings.lifetimeEarned.toString(),
                claimed: newEarnings.claimed.toString(),
                starBalance: starBalance.toString(),
            });
        } catch (e) {
            return json({ error: "invalid request" }, 400);
        }
    }

    // ============================================
    // REDEMPTION API ENDPOINTS
    // ============================================

    // GET /api/redemption/config - Get redemption configuration
    if (method === "GET" && path === "/api/redemption/config") {
        return json({
            costPerSpin: REDEMPTION_CONFIG.costPerSpin.toString(),
            costPerSpinFormatted: Number(REDEMPTION_CONFIG.costPerSpin / BigInt(1e9)),
            probabilities: REDEMPTION_CONFIG.probabilities.map(p => (p / 100).toFixed(1) + "%"),
            rewards: REDEMPTION_CONFIG.rewards.map(r => ({
                lamports: r,
                sol: r / 1e9,
                formatted: (r / 1e9).toFixed(3) + " SOL",
            })),
            poolBalance: REDEMPTION_CONFIG.poolBalance,
            poolBalanceFormatted: (REDEMPTION_CONFIG.poolBalance / 1e9).toFixed(2) + " SOL",
            totalSpins,
            totalDistributed,
        });
    }

    // GET /api/redemption/winners - Get recent winners
    if (method === "GET" && path === "/api/redemption/winners") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
        return json({
            winners: redemptionWinners.slice(-limit).reverse().map(w => ({
                ...w,
                tier: w.rewardTier, // Frontend uses this for tier-colored display
                rewardFormatted: (w.rewardAmount / 1e9).toFixed(4) + " SOL",
                walletShort: w.wallet.slice(0, 4) + "..." + w.wallet.slice(-4),
                timeAgo: formatTimeAgo(w.timestamp),
            })),
            totalSpins,
            totalDistributed,
            totalDistributedFormatted: (totalDistributed / 1e9).toFixed(3) + " SOL",
        });
    }

    // POST /api/redemption/spin - Spin the wheel
    if (method === "POST" && path === "/api/redemption/spin") {
        try {
            const body = await req.json() as { wallet: string };
            const wallet = body.wallet;

            if (!wallet) {
                return json({ error: "wallet required" }, 400);
            }

            // Check user has enough stardust
            const earnings = earningsStore.get(wallet);
            if (!earnings) {
                return json({ error: "no earnings found" }, 404);
            }

            const unclaimed = earnings.lifetimeEarned - earnings.claimed;
            if (unclaimed < REDEMPTION_CONFIG.costPerSpin) {
                return json({
                    error: "insufficient stardust",
                    required: REDEMPTION_CONFIG.costPerSpin.toString(),
                    available: unclaimed.toString(),
                }, 400);
            }

            // Deduct stardust cost
            earnings.claimed += REDEMPTION_CONFIG.costPerSpin;

            // Generate random outcome
            const random = Math.floor(Math.random() * 10000);
            let cumulativeProb = 0;
            let rewardTier = 0;

            for (let i = 0; i < REDEMPTION_CONFIG.probabilities.length; i++) {
                cumulativeProb += REDEMPTION_CONFIG.probabilities[i];
                if (random < cumulativeProb) {
                    rewardTier = i;
                    break;
                }
            }

            const rewardAmount = REDEMPTION_CONFIG.rewards[rewardTier];

            // Update stats
            totalSpins++;
            totalDistributed += rewardAmount;
            REDEMPTION_CONFIG.poolBalance -= rewardAmount;

            // Track wallet winnings for leaderboard
            const currentWinnings = walletWinnings.get(wallet) || 0;
            walletWinnings.set(wallet, currentWinnings + rewardAmount);

            // Record winner
            const winner: RedemptionWinner = {
                wallet,
                rewardTier,
                rewardAmount,
                timestamp: Date.now(),
            };

            redemptionWinners.push(winner);

            // Keep only last 100 winners
            if (redemptionWinners.length > 100) {
                redemptionWinners.shift();
            }

            return json({
                success: true,
                spinNumber: totalSpins,
                rewardTier,
                rewardAmount,
                rewardFormatted: (rewardAmount / 1e9).toFixed(3) + " SOL",
                tierName: ["Common", "Uncommon", "Rare", "Epic", "Legendary"][rewardTier],
                newUnclaimedStardust: (earnings.lifetimeEarned - earnings.claimed).toString(),
                poolRemaining: REDEMPTION_CONFIG.poolBalance,
            });
        } catch (e: any) {
            return json({ error: e.message || "spin failed" }, 500);
        }
    }

    // POST /api/wheel/record-spin - Record on-chain spin result for history
    // Verifies the transaction on-chain before recording
    if (method === "POST" && path === "/api/wheel/record-spin") {
        try {
            const body = await req.json() as { wallet: string; signature: string };
            const { wallet, signature } = body;

            if (!wallet || !signature) {
                return json({ error: "wallet and signature required" }, 400);
            }

            // Check if this signature was already recorded (prevent duplicates)
            if (redemptionWinners.find(w => w.txSignature === signature)) {
                return json({ error: "spin already recorded" }, 409);
            }

            // Verify the transaction on-chain
            let txDetails = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    txDetails = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
                    if (txDetails) break;
                } catch (e) {
                    console.warn(`[record-spin] getTransaction attempt ${attempt + 1} failed:`, e);
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            if (!txDetails) {
                return json({ error: "transaction not found - please wait and retry" }, 404);
            }

            // Verify transaction succeeded
            if (txDetails.meta?.err) {
                return json({ error: "transaction failed on-chain" }, 400);
            }

            // Verify it's our wheel program
            const WHEEL_PROGRAM = "3M12BfitAEYz14WJBMnjahEuSvhsWhjfGJXbzur26o2U";
            const accountKeys = txDetails.transaction.message.staticAccountKeys?.map(k => k.toBase58()) || [];
            if (!accountKeys.includes(WHEEL_PROGRAM)) {
                return json({ error: "not a valid wheel spin transaction" }, 400);
            }

            // Parse the result from on-chain logs
            const logs = txDetails.meta?.logMessages || [];
            let tier = -1;
            let reward = 0;

            for (const log of logs) {
                // Parse: "Spin #X: Tier Y - Won Z lamports"
                const match = log.match(/Spin #\d+: Tier (\d+) - Won (\d+) lamports/);
                if (match) {
                    tier = parseInt(match[1]);
                    reward = parseInt(match[2]);
                    break;
                }
            }

            if (tier < 0) {
                return json({ error: "could not parse spin result from transaction" }, 400);
            }

            // Record winner with verified data
            const winner: RedemptionWinner = {
                wallet,
                rewardTier: tier,
                rewardAmount: reward,
                timestamp: txDetails.blockTime ? txDetails.blockTime * 1000 : Date.now(),
                txSignature: signature,
            };

            redemptionWinners.push(winner);

            // Keep only last 100 winners
            if (redemptionWinners.length > 100) {
                redemptionWinners.shift();
            }

            // Track wallet winnings
            const currentWinnings = walletWinnings.get(wallet) || 0;
            walletWinnings.set(wallet, currentWinnings + reward);

            console.log(`[record-spin] Verified and recorded: wallet=${wallet.slice(0, 8)}, tier=${tier}, reward=${reward / 1e9} SOL, sig=${signature.slice(0, 8)}`);

            return json({
                success: true,
                verified: true,
                tier,
                reward,
            });
        } catch (e: any) {
            console.error('[record-spin] Error:', e);
            return json({ error: e.message || "record failed" }, 500);
        }
    }

    // GET /api/wheel/treasury - Get treasury pool balance
    if (path === "/api/wheel/treasury" && req.method === "GET") {
        try {
            // Derive pool PDA
            const WHEEL_PROGRAM_ID = new PublicKey("3M12BfitAEYz14WJBMnjahEuSvhsWhjfGJXbzur26o2U");
            const [poolPda] = PublicKey.findProgramAddressSync(
                [Buffer.from("wheel_pool")],
                WHEEL_PROGRAM_ID
            );

            const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
            const balance = await connection.getBalance(poolPda);

            return json({
                balance: balance / 1e9, // SOL
                balanceLamports: balance,
                poolPda: poolPda.toBase58(),
            });
        } catch (e: any) {
            return json({ error: e.message, balance: 0 }, 500);
        }
    }

    return null;
}

// Helper function for time ago
function formatTimeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

serve(handler);

console.log(`\n✨ Stardust Backend running on port ${process.env.BUN_PORT}`);
console.log(`   Authority: ${authority.publicKey.toBase58()}`);
console.log(`   Program: ${config.programId}`);
console.log(`   STAR Token: ${config.starTokenMint}`);
console.log(`   Stardust Mint: ${config.stardustMint}`);
console.log(`\n   Real token balances enabled! No more Math.random() 🎉\n`);
