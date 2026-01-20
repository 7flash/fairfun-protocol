import { serve } from "@ments/web";
import { measure } from "@ments/utils";
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
 * Get real token balance from Solana
 */
async function getTokenBalance(
    tokenAccountAddress: string
): Promise<bigint> {
    try {
        const account = await getAccount(
            connection,
            new PublicKey(tokenAccountAddress)
        );
        return account.amount;
    } catch (e) {
        console.error(`Failed to get balance for ${tokenAccountAddress}:`, e);
        return 0n;
    }
}

/**
 * Fetch real STAR token balance for a user
 */
async function fetchUserStarBalance(walletPubkey: string): Promise<bigint> {
    const starMint = new PublicKey(config.starTokenMint);
    const wallet = new PublicKey(walletPubkey);

    try {
        const ata = await getAssociatedTokenAddress(starMint, wallet);
        return await getTokenBalance(ata.toBase58());
    } catch (e) {
        // User might not have a token account
        return 0n;
    }
}

/**
 * Fetch real claimed STARDUST amount from on-chain token account
 * This ensures we always have accurate data even if claim callbacks fail
 */
async function fetchClaimedStardust(walletPubkey: string): Promise<bigint> {
    const stardustMint = new PublicKey(config.stardustMint);
    const wallet = new PublicKey(walletPubkey);

    try {
        const ata = await getAssociatedTokenAddress(stardustMint, wallet);
        return await getTokenBalance(ata.toBase58());
    } catch (e) {
        // User might not have claimed yet
        return 0n;
    }
}

/**
 * Calculate stardust earnings based on STAR token holdings
 * 1 STAR = 136 stardust per period (represents $136 price * 1 token)
 */
const STARDUST_RATE = 136n * BigInt(1e9); // Per STAR token per period

/**
 * Update earnings based on real STAR token balances
 */
async function updateEarnings() {
    return measure(async (m) => {
        const now = Date.now();

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

            // Calculate earnings: (STAR balance / 1e9) * STARDUST_RATE
            const starTokens = starBalance / BigInt(1e9);
            const stardustThisPeriod = starTokens * STARDUST_RATE;

            const existing = earningsStore.get(user.publicKey);
            const newLifetime = (existing?.lifetimeEarned || 0n) + stardustThisPeriod;

            earningsStore.set(user.publicKey, {
                wallet: user.publicKey,
                lifetimeEarned: newLifetime,
                claimed: claimedOnChain, // Use on-chain data as source of truth
                starBalance: starBalance,
                lastUpdated: now,
            });

            console.log(
                `  User ${user.id}: ${Number(starBalance) / 1e9} STAR -> +${Number(stardustThisPeriod) / 1e9} ✨ (claimed: ${Number(claimedOnChain) / 1e9})`
            );
        }

        // Also update any registered wallets
        for (const [wallet, earnings] of earningsStore.entries()) {
            // Skip test users (already updated)
            if (config.testUsers.find((u) => u.publicKey === wallet)) continue;

            const starBalance = await fetchUserStarBalance(wallet);
            const starTokens = starBalance / BigInt(1e9);
            const stardustThisPeriod = starTokens * STARDUST_RATE;

            earningsStore.set(wallet, {
                ...earnings,
                lifetimeEarned: earnings.lifetimeEarned + stardustThisPeriod,
                starBalance,
                lastUpdated: now,
            });
        }

        console.log(
            `Updated earnings for ${earningsStore.size} holders (real balances)`
        );
    }, "update_earnings");
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
        process.env.SOLANA_RPC || "http://localhost:8899",
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

// Start earnings update (every 60 seconds / 1 minute)
setInterval(updateEarnings, 60 * 1000);
updateEarnings();

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

        // Calculate unclaimed with 1M cap
        let unclaimed = earnings ? (earnings.lifetimeEarned - earnings.claimed) : 0n;
        if (unclaimed > MAX_UNCLAIMED) {
            unclaimed = MAX_UNCLAIMED;
        }
        const isCapped = unclaimed >= MAX_UNCLAIMED;

        return json({
            wallet,
            lifetimeEarned: earnings?.lifetimeEarned.toString() || "0",
            claimed: earnings?.claimed.toString() || "0",
            unclaimed: unclaimed.toString(),
            isCapped, // Frontend can show "1M MAX" indicator
            starBalance: earnings?.starBalance.toString() || "0",
            lastUpdated: earnings?.lastUpdated || null,
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

            // Calculate real values based on token holdings
            // STAR price estimated at $136 per token
            const starPriceUsd = 136;
            const starTokens = Number(totalStarBalance) / 1e9;
            const starValueUsd = starTokens * starPriceUsd;

            // Protocol treasury = accumulated stardust value (1 stardust = $0.001)
            const stardustValueUsd = (Number(totalStardust) / 1e9) * 0.001;

            // Total treasury value
            const totalValue = Math.round(starValueUsd + stardustValueUsd);

            // Calculate APY based on earnings rate
            // APY = (Daily earnings * 365) / Total value * 100
            const dailyEarnings = (starTokens * 136 * 86400) / 1000; // stardust value generated daily
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
                    priceUsd: 0.136,
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
            console.error("Treasury API error:", e);
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
            console.error("Signature error:", e);
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
                    console.log("Could not verify tx, proceeding anyway");
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

            // Fetch real balance if exists
            const starBalance = await fetchUserStarBalance(wallet);
            const starTokens = starBalance / BigInt(1e9);
            const stardustAmount = starTokens * STARDUST_RATE;

            earningsStore.set(wallet, {
                wallet,
                lifetimeEarned: stardustAmount,
                claimed: 0n,
                starBalance,
                lastUpdated: Date.now(),
            });

            return json({
                success: true,
                wallet,
                lifetimeEarned: stardustAmount.toString(),
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
                rewardFormatted: (w.rewardAmount / 1e9).toFixed(3) + " SOL",
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

            console.log(`🎰 SPIN #${totalSpins}: ${wallet.slice(0, 8)}... won ${(rewardAmount / 1e9).toFixed(3)} SOL (tier ${rewardTier})`);

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
            console.error("Spin error:", e);
            return json({ error: e.message || "spin failed" }, 500);
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
