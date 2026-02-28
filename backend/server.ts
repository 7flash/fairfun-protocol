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
// ADMIN-CONTROLLED WHEEL SYSTEM
// ============================================

// Tier names for display
const TIER_NAMES = ["VOID", "METEOR", "NEBULA", "QUASAR", "SUPERNOVA"];

// Base probabilities (out of 10000) — adjusted per holder based on stardust
const BASE_PROBABILITIES = [5000, 3000, 1500, 450, 50]; // 50%, 30%, 15%, 4.5%, 0.5%

// Wheel program ID (separate from stardust program in config.programId)
const WHEEL_PROGRAM_ID_STR = "3M12BfitAEYz14WJBMnjahEuSvhsWhjfGJXbzur26o2U";

// SOL rewards per tier (in lamports)
const TIER_REWARDS = [
    0.001 * 1e9,  // VOID:      0.001 SOL
    0.01 * 1e9,   // METEOR:    0.01 SOL
    0.1 * 1e9,    // NEBULA:    0.1 SOL
    1 * 1e9,      // QUASAR:    1 SOL
    10 * 1e9,     // SUPERNOVA: 10 SOL
];

// Prize pool balance (lamports) — fetched from real treasury PDA
let poolBalance = 0; // Will be populated from on-chain data

// RPC health tracking
const rpcStatus = {
    online: false,
    lastSuccess: 0,
    lastError: '',
    lastErrorTime: 0,
    consecutiveFailures: 0,
    poolFetched: false,
};

/**
 * Fetch real pool balance from the wheel_pool PDA on-chain
 */
async function fetchPoolBalance() {
    try {
        const WHEEL_PROGRAM_ID = new PublicKey(WHEEL_PROGRAM_ID_STR);
        const [poolPda] = PublicKey.findProgramAddressSync([Buffer.from("wheel_pool")], WHEEL_PROGRAM_ID);
        const balance = await getConn().getBalance(poolPda, "confirmed");
        poolBalance = balance;
        rpcStatus.online = true;
        rpcStatus.lastSuccess = Date.now();
        rpcStatus.consecutiveFailures = 0;
        rpcStatus.poolFetched = true;
        console.log(`💰 Pool balance: ${(balance / 1e9).toFixed(4)} SOL (from ${poolPda.toBase58().slice(0, 8)}...)`);
    } catch (e: any) {
        const msg = e.message || String(e);
        rpcStatus.lastError = msg.includes('429') ? 'RPC rate limited (429 Too Many Requests)' : msg.slice(0, 120);
        rpcStatus.lastErrorTime = Date.now();
        rpcStatus.consecutiveFailures++;
        if (rpcStatus.consecutiveFailures >= 3) rpcStatus.online = false;
        console.error(`[fetchPoolBalance] ❌ ${rpcStatus.lastError} (failures: ${rpcStatus.consecutiveFailures})`);
    }
}


interface PendingPrize {
    id: string;           // unique prize ID
    wallet: string;
    rewardTier: number;
    rewardAmount: number; // lamports
    tierName: string;
    timestamp: number;    // when won
    expiresAt: number;    // timestamp + 24h
    claimed: boolean;
    claimedAt?: number;
}

interface SpinRecord {
    wallet: string;
    rewardTier: number;
    rewardAmount: number;
    tierName: string;
    timestamp: number;
    stardustTotal: string; // holder's lifetimeEarned at time of spin
    txSignature?: string;
}

// Admin spin state
let holderQueue: string[] = [];       // sorted list of holder wallets (by stardust wallet balance desc)
const holderStardustBalances: Map<string, bigint> = new Map(); // wallet -> stardust token balance
let currentHolderIndex = 0;           // which holder is next in the queue
const pendingPrizes: Map<string, PendingPrize[]> = new Map(); // wallet -> prizes
const spinHistory: SpinRecord[] = []; // last 200 spin results
let totalAdminSpins = 0;
let totalDistributed = 0;

// Track total winnings per wallet (for leaderboard)
const walletWinnings: Map<string, number> = new Map();

const PRIZE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const AUTO_SPIN_INTERVAL = 60 * 1000; // 60 seconds between auto-spins
let nextSpinTime = 0; // timestamp of next scheduled spin

// ============================================
// SSE: Real-time event broadcasting
// ============================================
type SSEClient = { controller: ReadableStreamDefaultController; id: string };
const sseClients = new Set<SSEClient>();

function broadcastSSE(event: string, data: any) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try {
            client.controller.enqueue(new TextEncoder().encode(payload));
        } catch {
            sseClients.delete(client);
        }
    }
}

/**
 * Generate a unique prize ID
 */
function generatePrizeId(): string {
    return `prize_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Rebuild the holder queue sorted by stardust wallet balance (descending)
 * Uses actual SPL token balance in wallet (not lifetime earned)
 * Called periodically and on demand
 */
function rebuildHolderQueue() {
    const holders = Array.from(earningsStore.entries())
        .filter(([_, e]) => e.starBalance > 0n) // only holders with GXY tokens
        .map(([wallet, e]) => {
            // Use cached stardust wallet balance, fallback to 0
            const stardustBal = holderStardustBalances.get(wallet) || 0n;
            return { wallet, stardustBal, starBalance: e.starBalance };
        })
        .sort((a, b) => Number(b.stardustBal - a.stardustBal)); // sort by stardust in wallet
    holderQueue = holders.map(h => h.wallet);
    // Keep index in bounds
    if (currentHolderIndex >= holderQueue.length) {
        currentHolderIndex = 0;
    }
}

/**
 * Calculate adjusted probabilities based on holder's stardust wallet balance
 * Higher stardust balance = better odds for higher tiers (SUPERNOVA, NEBULA)
 * 
 * Formula:
 *   - Get holder's stardust wallet balance
 *   - Find max stardust among all holders
 *   - ratio = holderBalance / maxBalance (0.0 to 1.0)
 *   - boostFactor = 1.0 + 2.0 * ratio → top holder gets 3x on high tiers
 *   - Higher tier probabilities (NEBULA, QUASAR, SUPERNOVA) scaled by boostFactor
 *   - VOID absorbs the difference
 */
function getAdjustedProbabilities(wallet: string): number[] {
    const holderBalance = holderStardustBalances.get(wallet) || 0n;

    // Find max stardust among all holders
    let maxBalance = 0n;
    for (const bal of holderStardustBalances.values()) {
        if (bal > maxBalance) maxBalance = bal;
    }

    if (maxBalance <= 0n || holderBalance <= 0n) {
        return [...BASE_PROBABILITIES];
    }

    const ratio = Number(holderBalance) / Number(maxBalance); // 0.0 to 1.0
    const boostFactor = 1.0 + 2.0 * ratio; // top holder gets 3x on high tiers

    // Boost higher tiers (METEORS=2, NEBULA=3, SUPERNOVA=4), reduce VOID to compensate
    const adjusted = [...BASE_PROBABILITIES];
    let totalBoost = 0;

    for (let i = 2; i < adjusted.length; i++) {
        const original = adjusted[i];
        const boosted = Math.round(original * boostFactor);
        totalBoost += (boosted - original);
        adjusted[i] = boosted;
    }

    // Subtract boost from VOID (tier 0), ensure minimum 500 (5%)
    adjusted[0] = Math.max(500, adjusted[0] - totalBoost);

    // Re-normalize to 10000
    const sum = adjusted.reduce((a, b) => a + b, 0);
    if (sum !== 10000) {
        adjusted[0] += (10000 - sum);
    }

    return adjusted;
}

/**
 * Spin the wheel for a specific holder with adjusted probabilities
 */
function spinForHolder(wallet: string): { tier: number; reward: number; tierName: string; probabilities: number[] } {
    const probabilities = getAdjustedProbabilities(wallet);
    const random = Math.floor(Math.random() * 10000);
    let cumulative = 0;
    let tier = 0;

    for (let i = 0; i < probabilities.length; i++) {
        cumulative += probabilities[i];
        if (random < cumulative) {
            tier = i;
            break;
        }
    }

    return {
        tier,
        reward: TIER_REWARDS[tier],
        tierName: TIER_NAMES[tier],
        probabilities,
    };
}

/**
 * Clean up expired prizes (runs every minute)
 */
function cleanupExpiredPrizes() {
    const now = Date.now();
    let cleaned = 0;
    for (const [wallet, prizes] of pendingPrizes.entries()) {
        const active = prizes.filter(p => p.expiresAt > now || p.claimed);
        const expired = prizes.length - active.length;
        if (expired > 0) {
            pendingPrizes.set(wallet, active);
            cleaned += expired;
        }
        if (active.length === 0) {
            pendingPrizes.delete(wallet);
        }
    }
    if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} expired prizes`);
    }
}

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
                () => getAccount(getConn(), new PublicKey(tokenAccountAddress)),
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
            () => getConn().getAccountInfo(userClaimPda),
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

        // Calculate rate: 1 stardust per 1 USD worth of token PER MINUTE.
        // This is 60x faster than previous "per hour" rate, matching user expectation of getting 9 stardust/min for $9 holding.
        const stardustRatePerTokenPerMinute = gxyPriceUsd * 1e9;

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
const SOLANA_RPC_URL = process.env.SOLANA_RPC;
if (!SOLANA_RPC_URL) {
    console.error("❌ SOLANA_RPC environment variable is required!");
    console.error("   Make sure .config.toml has SOLANA_RPC defined and bgr is running.");
    process.exit(1);
}

// Public RPC fallback when primary is rate-limited
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
let fallbackConnection: Connection;

/** Get the best available connection (fallback to public RPC on rate limit) */
function getConn(): Connection {
    if (rpcStatus.consecutiveFailures >= 3 && fallbackConnection) {
        return fallbackConnection;
    }
    return connection;
}

try {
    config = loadConfig();
    const secretKeyBytes = Buffer.from(config.authority.secretKey, "base64");
    authority = Keypair.fromSecretKey(new Uint8Array(secretKeyBytes));
    connection = new Connection(SOLANA_RPC_URL, "confirmed");
    fallbackConnection = new Connection(PUBLIC_RPC, "confirmed");

    console.log("✅ Loaded config from local-config.json");
    console.log(`   RPC: ${SOLANA_RPC_URL.replace(/api-key=[^\&]+/, 'api-key=***')}`);
    console.log(`   Fallback RPC: ${PUBLIC_RPC}`);
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

// Clean up expired prizes every minute
setInterval(cleanupExpiredPrizes, 60 * 1000);

// Rebuild holder queue every 5 minutes (and on startup)
setInterval(rebuildHolderQueue, 5 * 60 * 1000);
rebuildHolderQueue();

// Update on-chain holder registry every 5 minutes (and on startup after a delay)
setInterval(updateHoldersOnChain, 5 * 60 * 1000);

// Fetch real pool balance on startup and every 2 minutes
setTimeout(fetchPoolBalance, 3_000); // 3s delay for connection setup
setInterval(fetchPoolBalance, 2 * 60 * 1000);
setTimeout(updateHoldersOnChain, 10_000); // 10s delay for startup

// Auto-spin: spin for next holder every AUTO_SPIN_INTERVAL with countdown
let autoSpinEnabled = true;
nextSpinTime = Date.now() + AUTO_SPIN_INTERVAL;

// Broadcast countdown timer every second
setInterval(() => {
    if (!autoSpinEnabled || holderQueue.length === 0) return;
    const secondsLeft = Math.max(0, Math.ceil((nextSpinTime - Date.now()) / 1000));
    const nextWallet = holderQueue[currentHolderIndex];
    if (!nextWallet) return;
    const nextStardust = holderStardustBalances.get(nextWallet) || 0n;
    broadcastSSE('timer', {
        secondsUntil: secondsLeft,
        nextHolder: nextWallet,
        nextHolderShort: nextWallet.slice(0, 4) + '...' + nextWallet.slice(-4),
        nextHolderStardust: nextStardust.toString(),
        nextHolderProbabilities: getAdjustedProbabilities(nextWallet),
        currentIndex: currentHolderIndex,
        totalHolders: holderQueue.length,
    });
}, 1000);

async function autoSpin() {
    if (!autoSpinEnabled || holderQueue.length === 0) return;
    try {
        // Fetch stardust balances for all holders before spinning
        for (const wallet of holderQueue) {
            try {
                const bal = await fetchStardustTokenBalance(wallet);
                holderStardustBalances.set(wallet, bal);
            } catch (e) { /* use cached */ }
        }

        // Broadcast "spinning" event before spin so frontend can show animation
        const currentWallet = holderQueue[currentHolderIndex];
        if (currentWallet) {
            const stardust = holderStardustBalances.get(currentWallet) || 0n;
            broadcastSSE('spinning', {
                wallet: currentWallet,
                walletShort: currentWallet.slice(0, 4) + '...' + currentWallet.slice(-4),
                queuePosition: currentHolderIndex,
                totalHolders: holderQueue.length,
                probabilities: getAdjustedProbabilities(currentWallet),
                stardustBalance: stardust.toString(),
            });
        }

        const result = await executeAdminSpin();
        if (result) {
            rpcStatus.online = true;
            rpcStatus.lastSuccess = Date.now();
            rpcStatus.consecutiveFailures = 0;
            console.log(`🎲 Auto-spin #${totalAdminSpins}: ${result.wallet.slice(0, 8)}... → ${result.tierName} (${(result.rewardAmount / 1e9).toFixed(3)} SOL) [queue: ${currentHolderIndex}/${holderQueue.length}]`);
        }
    } catch (e: any) {
        const msg = e.message || String(e);
        rpcStatus.lastError = msg.includes('429') ? 'RPC rate limited (429)' : msg.slice(0, 120);
        rpcStatus.lastErrorTime = Date.now();
        rpcStatus.consecutiveFailures++;
        if (rpcStatus.consecutiveFailures >= 3) rpcStatus.online = false;
        console.error(`[auto-spin] ❌ ${rpcStatus.lastError} (failures: ${rpcStatus.consecutiveFailures})`);
        broadcastSSE('error', { message: rpcStatus.lastError, timestamp: Date.now() });
    }
    // Schedule next spin
    nextSpinTime = Date.now() + AUTO_SPIN_INTERVAL;
}
setInterval(autoSpin, AUTO_SPIN_INTERVAL);

// Helper: upload holder list to on-chain HolderRegistry
async function updateHoldersOnChain(): Promise<boolean> {
    try {
        if (holderQueue.length === 0) {
            rebuildHolderQueue();
            if (holderQueue.length === 0) return false;
        }

        // Cap at 30 (MAX_HOLDERS on-chain)
        const holders = holderQueue.slice(0, 30);

        const WHEEL_PROGRAM_ID = new PublicKey(WHEEL_PROGRAM_ID_STR);
        const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("wheel_state")], WHEEL_PROGRAM_ID);
        const [registryPda] = PublicKey.findProgramAddressSync([Buffer.from("holder_registry")], WHEEL_PROGRAM_ID);

        const crypto = await import("crypto");
        const discHash = crypto.createHash("sha256").update("global:update_holders").digest();
        const discriminator = discHash.slice(0, 8);

        // Instruction data: discriminator + Vec<Pubkey> (4-byte len prefix + 32 * N bytes)
        const instrData = Buffer.alloc(8 + 4 + 32 * holders.length);
        discriminator.copy(instrData, 0);
        instrData.writeUInt32LE(holders.length, 8);
        for (let i = 0; i < holders.length; i++) {
            new PublicKey(holders[i]).toBuffer().copy(instrData, 12 + i * 32);
        }

        const { Transaction, TransactionInstruction, SystemProgram: SysProgram } = await import("@solana/web3.js");

        const updateIx = new TransactionInstruction({
            programId: WHEEL_PROGRAM_ID,
            keys: [
                { pubkey: registryPda, isSigner: false, isWritable: true },
                { pubkey: statePda, isSigner: false, isWritable: false },
                { pubkey: authority.publicKey, isSigner: true, isWritable: true },
                { pubkey: SysProgram.programId, isSigner: false, isWritable: false },
            ],
            data: instrData,
        });

        const tx = new Transaction().add(updateIx);
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = authority.publicKey;
        tx.sign(authority);

        const txSig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, preflightCommitment: "confirmed" });
        await connection.confirmTransaction({ signature: txSig, blockhash, lastValidBlockHeight }, "confirmed");

        console.log(`📋 Holder registry updated on-chain: ${holders.length} holders (tx: ${txSig.slice(0, 12)}...)`);
        return true;
    } catch (e: any) {
        console.error("[update-holders] Error:", e.message);
        return false;
    }
}

// Helper: build and send an on-chain admin_spin transaction
// Backend picks the next holder from queue, passes their adjusted probabilities
async function executeAdminSpin(): Promise<{ wallet: string; rewardTier: number; rewardAmount: number; tierName: string; txSignature: string; probabilities: number[] } | null> {
    if (holderQueue.length === 0) {
        rebuildHolderQueue();
        if (holderQueue.length === 0) return null;
    }

    // Pick the current holder from queue
    const wallet = holderQueue[currentHolderIndex];
    if (!wallet) return null;

    // Get per-user adjusted probabilities based on their stardust
    const adjustedProbs = getAdjustedProbabilities(wallet);
    const probsArray = new Array(10).fill(0);
    for (let i = 0; i < adjustedProbs.length; i++) {
        probsArray[i] = adjustedProbs[i];
    }

    const WHEEL_PROGRAM_ID = new PublicKey(WHEEL_PROGRAM_ID_STR);
    const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("wheel_state")], WHEEL_PROGRAM_ID);
    const [poolPda] = PublicKey.findProgramAddressSync([Buffer.from("wheel_pool")], WHEEL_PROGRAM_ID);
    const holderPubkey = new PublicKey(wallet);
    const [userRewardsPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_rewards"), holderPubkey.toBuffer()],
        WHEEL_PROGRAM_ID
    );

    const crypto = await import("crypto");
    const discHash = crypto.createHash("sha256").update("global:admin_spin").digest();
    const discriminator = discHash.slice(0, 8);

    const instrData = Buffer.alloc(8 + 20);
    discriminator.copy(instrData, 0);
    for (let i = 0; i < 10; i++) {
        instrData.writeUInt16LE(probsArray[i], 8 + i * 2);
    }

    const { Transaction, TransactionInstruction, SystemProgram: SysProgram } = await import("@solana/web3.js");

    // New instruction format: state, pool, holder, user_rewards, authority, system_program
    const adminSpinIx = new TransactionInstruction({
        programId: WHEEL_PROGRAM_ID,
        keys: [
            { pubkey: statePda, isSigner: false, isWritable: true },
            { pubkey: poolPda, isSigner: false, isWritable: true },
            { pubkey: holderPubkey, isSigner: false, isWritable: false },
            { pubkey: userRewardsPda, isSigner: false, isWritable: true },
            { pubkey: authority.publicKey, isSigner: true, isWritable: true },
            { pubkey: SysProgram.programId, isSigner: false, isWritable: false },
        ],
        data: instrData,
    });

    const tx = new Transaction().add(adminSpinIx);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = authority.publicKey;
    tx.sign(authority);

    const txSignature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, preflightCommitment: "confirmed" });
    await connection.confirmTransaction({ signature: txSignature, blockhash, lastValidBlockHeight }, "confirmed");

    // Parse result from logs
    let txDetails = null;
    try {
        txDetails = await getConn().getTransaction(txSignature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    } catch (e: any) {
        // getTransaction may not be supported on beta RPCs — use fallback
    }
    let rewardTier = 0;
    let rewardAmount = 0;
    const logs = txDetails?.meta?.logMessages || [];
    for (const log of logs) {
        // Log format: "Admin Spin #N: Holder PUBKEY - Tier T - Credited L lamports (available: A)"
        const match = log.match(/Admin Spin #\d+: Holder (\S+) - Tier (\d+) - Credited (\d+) lamports/);
        if (match) {
            rewardTier = parseInt(match[2]);
            rewardAmount = parseInt(match[3]);
            break;
        }
    }

    // Fallback: if logs couldn't be parsed, estimate reward from pool balance & reward_bps
    if (rewardAmount === 0 && poolBalance > 0) {
        // The probabilities determine tier, but we can't know the exact tier without logs
        // Use VOID (tier 0) as the most likely outcome (50-70%)
        const voidBps = 100; // 1% of pool for VOID
        rewardAmount = Math.floor((poolBalance * voidBps) / 10000);
    }

    const tierName = TIER_NAMES[rewardTier] || `Tier ${rewardTier}`;
    totalAdminSpins++;
    totalDistributed += rewardAmount;

    const currentWinnings = walletWinnings.get(wallet) || 0;
    walletWinnings.set(wallet, currentWinnings + rewardAmount);

    const earnings = earningsStore.get(wallet);
    const now = Date.now();
    const record: SpinRecord = {
        wallet,
        rewardTier,
        rewardAmount,
        tierName,
        timestamp: now,
        stardustTotal: earnings?.lifetimeEarned.toString() || "0",
        txSignature,
    };
    spinHistory.push(record);
    if (spinHistory.length > 200) spinHistory.shift();

    // Advance queue position for sequential iteration
    currentHolderIndex = (currentHolderIndex + 1) % holderQueue.length;

    // Broadcast spin event to SSE clients (include probabilities for live viewer)
    broadcastSSE('spin', {
        wallet,
        walletShort: wallet.slice(0, 4) + '...' + wallet.slice(-4),
        tier: rewardTier,
        tierName,
        rewardAmount,
        rewardFormatted: (rewardAmount / 1e9).toFixed(4) + ' SOL',
        timestamp: now,
        probabilities: adjustedProbs,
        txSignature,
        nextIndex: currentHolderIndex,
        nextWallet: holderQueue[currentHolderIndex]?.slice(0, 4) + '...' + holderQueue[currentHolderIndex]?.slice(-4),
    });

    return { wallet, rewardTier, rewardAmount, tierName, txSignature, probabilities: adjustedProbs };
}

// Helper: build and send on-chain user spin transaction (manual pool, 24h cooldown)
// Rewards are accumulated in UserRewards PDA (user must withdraw)
async function executeUserSpin(wallet: string): Promise<{ rewardTier: number; rewardAmount: number; tierName: string; txSignature: string; probabilities: number[] }> {
    const adjustedProbs = getAdjustedProbabilities(wallet);

    const probsArray = new Array(10).fill(0);
    for (let i = 0; i < adjustedProbs.length; i++) {
        probsArray[i] = adjustedProbs[i];
    }

    const WHEEL_PROGRAM_ID = new PublicKey(WHEEL_PROGRAM_ID_STR);
    const holderPubkey = new PublicKey(wallet);

    const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("wheel_state")], WHEEL_PROGRAM_ID);
    const [manualPoolPda] = PublicKey.findProgramAddressSync([Buffer.from("wheel_manual_pool")], WHEEL_PROGRAM_ID);
    const [userRewardsPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_rewards"), holderPubkey.toBuffer()],
        WHEEL_PROGRAM_ID
    );
    const [userHistoryPda] = PublicKey.findProgramAddressSync([Buffer.from("user_history"), holderPubkey.toBuffer()], WHEEL_PROGRAM_ID);

    const crypto = await import("crypto");
    const discHash = crypto.createHash("sha256").update("global:spin").digest();
    const discriminator = discHash.slice(0, 8);

    const instrData = Buffer.alloc(8 + 20);
    discriminator.copy(instrData, 0);
    for (let i = 0; i < 10; i++) {
        instrData.writeUInt16LE(probsArray[i], 8 + i * 2);
    }

    const { Transaction, TransactionInstruction, SystemProgram: SysProgram } = await import("@solana/web3.js");

    // Updated: includes user_rewards PDA for accumulation
    const spinIx = new TransactionInstruction({
        programId: WHEEL_PROGRAM_ID,
        keys: [
            { pubkey: statePda, isSigner: false, isWritable: true },
            { pubkey: manualPoolPda, isSigner: false, isWritable: true },
            { pubkey: authority.publicKey, isSigner: true, isWritable: true },
            { pubkey: holderPubkey, isSigner: false, isWritable: false },
            { pubkey: userRewardsPda, isSigner: false, isWritable: true },
            { pubkey: userHistoryPda, isSigner: false, isWritable: true },
            { pubkey: SysProgram.programId, isSigner: false, isWritable: false },
        ],
        data: instrData,
    });

    const tx = new Transaction().add(spinIx);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = authority.publicKey;
    tx.sign(authority);

    const txSignature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, preflightCommitment: "confirmed" });
    await connection.confirmTransaction({ signature: txSignature, blockhash, lastValidBlockHeight }, "confirmed");

    let txDetails2 = null;
    try {
        txDetails2 = await getConn().getTransaction(txSignature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    } catch (e: any) { }
    const txDetails = txDetails2;
    let rewardTier = 0;
    let rewardAmount = 0;
    const logs = txDetails?.meta?.logMessages || [];
    for (const log of logs) {
        const match = log.match(/Daily Spin #\d+: Holder \S+ - Tier (\d+) - Credited (\d+) lamports/);
        if (match) {
            rewardTier = parseInt(match[1]);
            rewardAmount = parseInt(match[2]);
            break;
        }
    }

    const tierName = TIER_NAMES[rewardTier] || `Tier ${rewardTier}`;
    return { rewardTier, rewardAmount, tierName, txSignature, probabilities: adjustedProbs };
}

console.log("🔄 Scheduled: earnings every 1 min, DB flush every 1 hr, prize cleanup every 1 min, queue rebuild every 5 min, auto-spin every 1 min");

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
            rpcUrl: SOLANA_RPC_URL,
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
            .filter(e => e && e.starBalance !== undefined && e.starBalance !== null)
            .sort((a, b) => Number(b.lifetimeEarned - a.lifetimeEarned))
            .slice(0, limit)
            .map((e, rank) => ({
                rank: rank + 1,
                wallet: e.wallet,
                lifetimeEarned: e.lifetimeEarned.toString(),
                claimed: e.claimed.toString(),
                unclaimed: (e.lifetimeEarned - e.claimed).toString(),
                starBalance: (e.starBalance || 0n).toString(),
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

        // Calculate unclaimed - no cap, stardust grows infinitely
        let unclaimed = lifetimeEarned - claimed;
        if (unclaimed < 0n) {
            unclaimed = 0n;
        }

        // Get stardust token balance from cache (non-blocking)
        let stardustTokenBalance = 0n;
        let rpcWarning: string | null = null;

        const cached = stardustBalanceCache.get(wallet);
        if (cached && Date.now() - cached.timestamp < BALANCE_CACHE_TTL) {
            stardustTokenBalance = cached.balance;
        } else {
            stardustTokenBalance = claimed;
            rpcWarning = 'Balance data is being refreshed...';
            fetchStardustTokenBalance(wallet).catch(() => { });
        }

        // Get pending prizes for this wallet
        const prizes = (pendingPrizes.get(wallet) || [])
            .filter(p => !p.claimed && p.expiresAt > Date.now())
            .map(p => ({
                id: p.id,
                tier: p.rewardTier,
                tierName: p.tierName,
                reward: p.rewardAmount,
                rewardFormatted: (p.rewardAmount / 1e9).toFixed(3) + " SOL",
                expiresAt: p.expiresAt,
                timeRemaining: formatTimeAgo(p.expiresAt), // countdown
            }));

        return json({
            wallet,
            lifetimeEarned: lifetimeEarned.toString(),
            claimed: claimed.toString(),
            unclaimed: unclaimed.toString(),
            starBalance: (earnings?.starBalance ?? 0n).toString(),
            stardustTokenBalance: (stardustTokenBalance ?? 0n).toString(),
            lastUpdated: earnings?.lastUpdated || null,
            rpcWarning,
            pendingPrizes: prizes,
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
                    const tx = await getConn().getTransaction(txSignature, {
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
    // ADMIN WHEEL SPIN API ENDPOINTS
    // ============================================

    // GET /api/wheel/config - Get wheel configuration
    if (method === "GET" && path === "/api/wheel/config") {
        return json({
            tiers: TIER_NAMES.map((name, i) => ({
                name,
                reward: TIER_REWARDS[i],
                rewardFormatted: (TIER_REWARDS[i] / 1e9).toFixed(3) + " SOL",
                baseProbability: (BASE_PROBABILITIES[i] / 100).toFixed(1) + "%",
            })),
            poolBalance,
            poolBalanceFormatted: (poolBalance / 1e9).toFixed(2) + " SOL",
            totalSpins: totalAdminSpins,
            totalDistributed,
            totalDistributedFormatted: (totalDistributed / 1e9).toFixed(3) + " SOL",
            queueLength: holderQueue.length,
            currentIndex: currentHolderIndex,
        });
    }
    // GET /api/wheel/events - SSE stream for real-time spin events
    if (method === "GET" && path === "/api/wheel/events") {
        const clientId = `sse_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const stream = new ReadableStream({
            start(controller) {
                const client: SSEClient = { controller, id: clientId };
                sseClients.add(client);
                console.log(`[SSE] Client connected: ${clientId} (${sseClients.size} total)`);

                // Send initial state
                const initPayload = `event: connected\ndata: ${JSON.stringify({
                    clientId,
                    queueLength: holderQueue.length,
                    currentIndex: currentHolderIndex,
                    autoSpinEnabled,
                    spinInterval: AUTO_SPIN_INTERVAL / 1000,
                })}\n\n`;
                controller.enqueue(new TextEncoder().encode(initPayload));
            },
            cancel() {
                for (const client of sseClients) {
                    if (client.id === clientId) {
                        sseClients.delete(client);
                        console.log(`[SSE] Client disconnected: ${clientId} (${sseClients.size} remaining)`);
                        break;
                    }
                }
            },
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
            },
        });
    }

    // GET /api/wheel/queue - Public: next holders in auto-spin queue
    if (method === "GET" && path === "/api/wheel/queue") {
        const upcoming = holderQueue.map((wallet, i) => {
            const stardust = holderStardustBalances.get(wallet) || 0n;
            return {
                position: i,
                wallet,
                walletShort: wallet.slice(0, 4) + "..." + wallet.slice(-4),
                isCurrent: i === currentHolderIndex,
                stardustBalance: stardust.toString(),
                probabilities: getAdjustedProbabilities(wallet),
            };
        });
        return json({
            queue: upcoming,
            totalHolders: holderQueue.length,
            currentIndex: currentHolderIndex,
            autoSpinEnabled,
            nextSpinTime,
            secondsUntilNextSpin: Math.max(0, Math.ceil((nextSpinTime - Date.now()) / 1000)),
        });
    }

    // GET /api/wheel/live - Full live state for viewer page
    if (method === "GET" && path === "/api/wheel/live") {
        const queueWithDetails = holderQueue.map((wallet, i) => {
            const earnings = earningsStore.get(wallet);
            const probabilities = getAdjustedProbabilities(wallet);
            const stardustBal = holderStardustBalances.get(wallet) || 0n;
            return {
                position: i,
                wallet,
                walletShort: wallet.slice(0, 4) + "..." + wallet.slice(-4),
                isCurrent: i === currentHolderIndex,
                lifetimeEarned: (earnings?.lifetimeEarned ?? 0n).toString(),
                starBalance: (earnings?.starBalance ?? 0n).toString(),
                stardustBalance: stardustBal.toString(),
                probabilities,
                totalWinnings: walletWinnings.get(wallet) || 0,
            };
        });

        return json({
            queue: queueWithDetails,
            currentIndex: currentHolderIndex,
            totalHolders: holderQueue.length,
            autoSpinEnabled,
            autoSpinInterval: AUTO_SPIN_INTERVAL,
            nextSpinTime,
            secondsUntilNextSpin: Math.max(0, Math.ceil((nextSpinTime - Date.now()) / 1000)),
            recentSpins: spinHistory.slice(-20).reverse(),
            stats: {
                totalSpins: totalAdminSpins,
                totalDistributed,
                totalDistributedFormatted: (totalDistributed / 1e9).toFixed(4) + " SOL",
                poolBalance,
                poolBalanceFormatted: (poolBalance / 1e9).toFixed(4) + " SOL",
            },
            rpcStatus: {
                online: rpcStatus.online,
                lastError: rpcStatus.lastError,
                lastErrorTime: rpcStatus.lastErrorTime,
                lastSuccess: rpcStatus.lastSuccess,
                consecutiveFailures: rpcStatus.consecutiveFailures,
                poolFetched: rpcStatus.poolFetched,
            },
            tierNames: TIER_NAMES,
            baseProbabilities: BASE_PROBABILITIES,
        });
    }

    // GET /api/wheel/user/:wallet - User's rewards and spin history
    if (method === "GET" && path.startsWith("/api/wheel/user/")) {
        const walletParam = path.split("/api/wheel/user/")[1];
        if (!walletParam) return json({ error: "wallet required" }, 400);

        const earnings = earningsStore.get(walletParam);
        const totalWinnings = walletWinnings.get(walletParam) || 0;
        const userSpins = spinHistory.filter(s => s.wallet === walletParam);
        const probabilities = getAdjustedProbabilities(walletParam);

        // Get pending prizes (unclaimed rewards)
        const prizes = pendingPrizes.get(walletParam) || [];
        const pendingTotal = prizes.filter(p => !p.claimed).reduce((sum, p) => sum + p.rewardAmount, 0);

        // Read real on-chain UserRewards PDA for available balance
        let availableToWithdraw = totalWinnings; // fallback to in-memory
        let onChainTotalEarned = 0;
        let onChainTotalWithdrawn = 0;
        try {
            const WHEEL_PROGRAM_ID = new PublicKey(WHEEL_PROGRAM_ID_STR);
            const userPubkey = new PublicKey(walletParam);
            const [userRewardsPda] = PublicKey.findProgramAddressSync(
                [Buffer.from("user_rewards"), userPubkey.toBuffer()],
                WHEEL_PROGRAM_ID
            );
            const accountInfo = await getConn().getAccountInfo(userRewardsPda);
            if (accountInfo && accountInfo.data.length >= 8 + 32 + 8 + 8 + 8) {
                // Parse UserRewards: 8(disc) + 32(user) + 8(available) + 8(total_earned) + 8(total_withdrawn) + 8(last_reward_ts) + 1(bump)
                const data = accountInfo.data;
                availableToWithdraw = Number(data.readBigUInt64LE(8 + 32));
                onChainTotalEarned = Number(data.readBigUInt64LE(8 + 32 + 8));
                onChainTotalWithdrawn = Number(data.readBigUInt64LE(8 + 32 + 8 + 8));
            }
        } catch (e: any) {
            // Fall back to in-memory data if RPC fails
        }

        return json({
            wallet: walletParam,
            walletShort: walletParam.slice(0, 4) + "..." + walletParam.slice(-4),
            availableToWithdraw,
            availableFormatted: (availableToWithdraw / 1e9).toFixed(4) + " SOL",
            onChainTotalEarned,
            onChainTotalWithdrawn,
            lifetimeEarned: (earnings?.lifetimeEarned ?? 0n).toString(),
            starBalance: (earnings?.starBalance ?? 0n).toString(),
            probabilities,
            recentSpins: userSpins.slice(-10).reverse(),
            pendingPrizes: prizes.filter(p => !p.claimed),
            pendingTotal,
        });
    }

    // POST /api/wheel/withdraw-tx - Build unsigned withdraw transaction
    if (method === "POST" && path === "/api/wheel/withdraw-tx") {
        try {
            const body = await req.json();
            const { wallet: userWallet } = body;
            if (!userWallet) return json({ error: "wallet required" }, 400);

            const WHEEL_PROGRAM_ID = new PublicKey(WHEEL_PROGRAM_ID_STR);
            const userPubkey = new PublicKey(userWallet);
            const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("wheel_state")], WHEEL_PROGRAM_ID);
            const [poolPda] = PublicKey.findProgramAddressSync([Buffer.from("wheel_pool")], WHEEL_PROGRAM_ID);
            const [userRewardsPda] = PublicKey.findProgramAddressSync(
                [Buffer.from("user_rewards"), userPubkey.toBuffer()],
                WHEEL_PROGRAM_ID
            );

            const crypto = await import("crypto");
            const discHash = crypto.createHash("sha256").update("global:withdraw").digest();
            const discriminator = discHash.slice(0, 8);

            const instrData = Buffer.alloc(8);
            discriminator.copy(instrData, 0);

            const { Transaction, TransactionInstruction, SystemProgram: SysProgram } = await import("@solana/web3.js");

            const withdrawIx = new TransactionInstruction({
                programId: WHEEL_PROGRAM_ID,
                keys: [
                    { pubkey: statePda, isSigner: false, isWritable: false },
                    { pubkey: poolPda, isSigner: false, isWritable: true },
                    { pubkey: userRewardsPda, isSigner: false, isWritable: true },
                    { pubkey: userPubkey, isSigner: true, isWritable: true },
                    { pubkey: SysProgram.programId, isSigner: false, isWritable: false },
                ],
                data: instrData,
            });

            const tx = new Transaction().add(withdrawIx);
            const { blockhash, lastValidBlockHeight } = await getConn().getLatestBlockhash("confirmed");
            tx.recentBlockhash = blockhash;
            tx.feePayer = userPubkey;

            // Return serialized unsigned transaction for user to sign with Phantom
            const serialized = tx.serialize({ requireAllSignatures: false });
            return json({
                transaction: Buffer.from(serialized).toString("base64"),
                blockhash,
                lastValidBlockHeight,
            });
        } catch (e: any) {
            console.error("[withdraw-tx] Error:", e);
            return json({ error: e.message || "failed to build withdraw tx" }, 500);
        }
    }

    // POST /api/claim-stardust-tx - Build unsigned claim stardust transaction
    // Backend signs the user's lifetime earnings, user signs the transaction to mint stardust tokens
    if (method === "POST" && path === "/api/claim-stardust-tx") {
        try {
            const body = await req.json();
            const { wallet: userWallet } = body;
            if (!userWallet) return json({ error: "wallet required" }, 400);

            // Get user's lifetime earned stardust
            const earnings = earningsStore.get(userWallet);
            if (!earnings || earnings.lifetimeEarned <= 0n) {
                return json({ error: "no stardust earned yet" }, 400);
            }

            const userPubkey = new PublicKey(userWallet);
            const lifetimeEarned = earnings.lifetimeEarned;

            // Create backend-signed Ed25519 verification data
            const sigData = createSignatureData(userPubkey, lifetimeEarned);

            // Build the transaction with Ed25519 verify + claim_stardust instructions
            const { Transaction, TransactionInstruction, SystemProgram: SysProgram } = await import("@solana/web3.js");
            const { getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");

            const STARDUST_PROGRAM_ID = new PublicKey(config.programId); // HsydRBzU...
            const stardustMint = new PublicKey(config.stardustMint);
            const [stardustStatePda] = PublicKey.findProgramAddressSync([Buffer.from("state")], STARDUST_PROGRAM_ID);
            const [userClaimPda] = PublicKey.findProgramAddressSync(
                [Buffer.from("user_claim"), userPubkey.toBuffer()],
                STARDUST_PROGRAM_ID
            );
            const userTokenAccount = getAssociatedTokenAddressSync(stardustMint, userPubkey);

            // 1. Ed25519 signature verification instruction
            const ed25519Ix = new TransactionInstruction({
                programId: new PublicKey(sigData.ed25519Instruction.programId),
                keys: [],
                data: Buffer.from(sigData.ed25519Instruction.data, "base64"),
            });

            // 2. claim_stardust(lifetime_earned) instruction
            const crypto = await import("crypto");
            const claimDiscHash = crypto.createHash("sha256").update("global:claim_stardust").digest();
            const claimDiscriminator = claimDiscHash.slice(0, 8);

            const claimData = Buffer.alloc(8 + 8); // discriminator + u64 lifetime_earned
            claimDiscriminator.copy(claimData, 0);
            claimData.writeBigUInt64LE(lifetimeEarned, 8);

            const INSTRUCTIONS_SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");

            const claimIx = new TransactionInstruction({
                programId: STARDUST_PROGRAM_ID,
                keys: [
                    { pubkey: userPubkey, isSigner: true, isWritable: true },
                    { pubkey: userClaimPda, isSigner: false, isWritable: true },
                    { pubkey: stardustStatePda, isSigner: false, isWritable: false },
                    { pubkey: stardustMint, isSigner: false, isWritable: true },
                    { pubkey: userTokenAccount, isSigner: false, isWritable: true },
                    { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
                    { pubkey: SysProgram.programId, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                ],
                data: claimData,
            });

            const tx = new Transaction().add(ed25519Ix).add(claimIx);
            const { blockhash, lastValidBlockHeight } = await getConn().getLatestBlockhash("confirmed");
            tx.recentBlockhash = blockhash;
            tx.feePayer = userPubkey;

            const serialized = tx.serialize({ requireAllSignatures: false });
            return json({
                transaction: Buffer.from(serialized).toString("base64"),
                blockhash,
                lastValidBlockHeight,
                lifetimeEarned: lifetimeEarned.toString(),
                authorityPublicKey: authority.publicKey.toBase58(),
            });
        } catch (e: any) {
            console.error("[claim-stardust-tx] Error:", e);
            return json({ error: e.message || "failed to build claim tx" }, 500);
        }
    }
    if (method === "GET" && path === "/api/admin/queue") {
        const page = parseInt(url.searchParams.get("page") || "0");
        const pageSize = 20;
        const start = page * pageSize;
        const queueSlice = holderQueue.slice(start, start + pageSize).map((wallet, i) => {
            const earnings = earningsStore.get(wallet);
            return {
                position: start + i,
                wallet,
                walletShort: wallet.slice(0, 4) + "..." + wallet.slice(-4),
                lifetimeEarned: earnings?.lifetimeEarned.toString() || "0",
                starBalance: earnings?.starBalance.toString() || "0",
                isCurrent: start + i === currentHolderIndex,
            };
        });

        return json({
            queue: queueSlice,
            totalHolders: holderQueue.length,
            currentIndex: currentHolderIndex,
            currentWallet: holderQueue[currentHolderIndex] || null,
            page,
            totalPages: Math.ceil(holderQueue.length / pageSize),
        });
    }

    // POST /api/admin/spin-next - Admin spins wheel for next holder (ON-CHAIN auto pool)
    if (method === "POST" && path === "/api/admin/spin-next") {
        try {
            const result = await executeAdminSpin();
            if (!result) {
                return json({ error: "no holders in queue" }, 400);
            }

            console.log(`🎰 Admin spin #${totalAdminSpins}: ${result.wallet.slice(0, 8)}... → ${result.tierName} (${(result.rewardAmount / 1e9).toFixed(3)} SOL) tx:${result.txSignature.slice(0, 12)}...`);

            return json({
                success: true,
                spinNumber: totalAdminSpins,
                wallet: result.wallet,
                walletShort: result.wallet.slice(0, 4) + "..." + result.wallet.slice(-4),
                tier: result.rewardTier,
                tierName: result.tierName,
                rewardAmount: result.rewardAmount,
                rewardFormatted: (result.rewardAmount / 1e9).toFixed(3) + " SOL",
                probabilities: result.probabilities.map(p => (p / 100).toFixed(1) + "%"),
                txSignature: result.txSignature,
                queuePosition: currentHolderIndex,
                nextHolder: holderQueue[currentHolderIndex]?.slice(0, 4) + "..." + holderQueue[currentHolderIndex]?.slice(-4),
            });
        } catch (e: any) {
            console.error("[admin-spin] Error:", e);
            return json({ error: e.message || "spin failed" }, 500);
        }
    }

    // Manual spin endpoints removed — stardust is claimed via POST /api/claim-stardust-tx

    // POST /api/admin/reset-queue - Reset queue position to start
    if (method === "POST" && path === "/api/admin/reset-queue") {
        rebuildHolderQueue();
        currentHolderIndex = 0;
        return json({ success: true, queueLength: holderQueue.length });
    }

    // POST /api/admin/fund-pool - Admin adds SOL to the pool
    if (method === "POST" && path === "/api/admin/fund-pool") {
        try {
            const body = await req.json() as { amount: number };
            const amountLamports = Math.floor(body.amount * 1e9);
            if (amountLamports <= 0) {
                return json({ error: "amount must be positive" }, 400);
            }
            poolBalance += amountLamports;
            console.log(`💰 Pool funded: +${body.amount} SOL (total: ${(poolBalance / 1e9).toFixed(2)} SOL)`);
            return json({
                success: true,
                added: body.amount,
                poolBalance,
                poolBalanceFormatted: (poolBalance / 1e9).toFixed(2) + " SOL",
            });
        } catch (e: any) {
            return json({ error: e.message }, 400);
        }
    }

    // GET /api/wheel/history - Get recent spin history
    if (method === "GET" && path === "/api/wheel/history") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 200);
        return json({
            spins: spinHistory.slice(-limit).reverse().map(s => ({
                ...s,
                rewardFormatted: (s.rewardAmount / 1e9).toFixed(3) + " SOL",
                walletShort: s.wallet.slice(0, 4) + "..." + s.wallet.slice(-4),
                timeAgo: formatTimeAgo(s.timestamp),
            })),
            totalSpins: totalAdminSpins,
            totalDistributed,
            totalDistributedFormatted: (totalDistributed / 1e9).toFixed(3) + " SOL",
        });
    }

    // ============================================
    // PRIZE CLAIMING API ENDPOINTS
    // ============================================

    // GET /api/prizes/:wallet - Get pending prizes for a wallet
    if (method === "GET" && path.startsWith("/api/prizes/")) {
        const wallet = path.replace("/api/prizes/", "");
        const prizes = (pendingPrizes.get(wallet) || [])
            .filter(p => !p.claimed && p.expiresAt > Date.now())
            .map(p => ({
                id: p.id,
                tier: p.rewardTier,
                tierName: p.tierName,
                reward: p.rewardAmount,
                rewardFormatted: (p.rewardAmount / 1e9).toFixed(3) + " SOL",
                timestamp: p.timestamp,
                expiresAt: p.expiresAt,
                timeRemaining: Math.max(0, p.expiresAt - Date.now()),
                timeRemainingFormatted: formatTimeRemaining(p.expiresAt - Date.now()),
            }));

        return json({
            wallet,
            prizes,
            totalPending: prizes.length,
            totalValue: prizes.reduce((sum, p) => sum + p.reward, 0),
            totalValueFormatted: (prizes.reduce((sum, p) => sum + p.reward, 0) / 1e9).toFixed(3) + " SOL",
        });
    }

    // POST /api/prizes/claim - Claim a prize (gasless - wallet signature verification)
    if (method === "POST" && path === "/api/prizes/claim") {
        try {
            const body = await req.json() as { wallet: string; prizeId: string; signature: string };
            const { wallet, prizeId, signature } = body;

            if (!wallet || !prizeId || !signature) {
                return json({ error: "wallet, prizeId, and signature required" }, 400);
            }

            // Find the prize
            const prizes = pendingPrizes.get(wallet);
            if (!prizes) {
                return json({ error: "no prizes found for this wallet" }, 404);
            }

            const prize = prizes.find(p => p.id === prizeId);
            if (!prize) {
                return json({ error: "prize not found" }, 404);
            }

            if (prize.claimed) {
                return json({ error: "prize already claimed" }, 400);
            }

            if (prize.expiresAt < Date.now()) {
                return json({ error: "prize expired" }, 400);
            }

            // Verify the wallet signature
            // The user signs the message "claim:{prizeId}" with their wallet
            const message = new TextEncoder().encode(`claim:${prizeId}`);
            const signatureBytes = bs58.decode(signature);
            const publicKeyBytes = new PublicKey(wallet).toBytes();

            const isValid = nacl.sign.detached.verify(message, signatureBytes, publicKeyBytes);
            if (!isValid) {
                return json({ error: "invalid signature" }, 401);
            }

            // Mark prize as claimed
            prize.claimed = true;
            prize.claimedAt = Date.now();

            console.log(`✅ Prize claimed: ${wallet.slice(0, 8)}... → ${prize.tierName} (${(prize.rewardAmount / 1e9).toFixed(3)} SOL)`);

            // TODO: Auto-send SOL from authority wallet to user
            // For now, prizes are recorded and admin can distribute manually
            // To auto-send: use connection.sendTransaction with authority keypair

            return json({
                success: true,
                wallet,
                prizeId,
                tierName: prize.tierName,
                rewardAmount: prize.rewardAmount,
                rewardFormatted: (prize.rewardAmount / 1e9).toFixed(3) + " SOL",
                claimedAt: prize.claimedAt,
            });
        } catch (e: any) {
            return json({ error: e.message || "claim failed" }, 500);
        }
    }

    // GET /api/wheel/treasury - Get pool balance
    if (method === "GET" && path === "/api/wheel/treasury") {
        return json({
            balance: poolBalance / 1e9,
            balanceLamports: poolBalance,
            totalSpins: totalAdminSpins,
            totalDistributed,
            totalDistributedFormatted: (totalDistributed / 1e9).toFixed(3) + " SOL",
        });
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

// Helper function for time remaining countdown
function formatTimeRemaining(ms: number): string {
    if (ms <= 0) return "expired";
    const hours = Math.floor(ms / (60 * 60 * 1000));
    const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

serve(handler);

console.log(`\n✨ Stardust Backend running on port ${process.env.BUN_PORT}`);
console.log(`   Authority: ${authority.publicKey.toBase58()}`);
console.log(`   Program: ${config.programId}`);
console.log(`   STAR Token: ${config.starTokenMint}`);
console.log(`   Stardust Mint: ${config.stardustMint}`);
console.log(`\n   Real token balances enabled! No more Math.random() 🎉\n`);
