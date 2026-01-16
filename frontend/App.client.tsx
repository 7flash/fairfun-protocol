import React, { useState, useEffect, useCallback } from "react";
import { Keypair, PublicKey, Connection, Transaction, TransactionInstruction, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";

// ============================================
// TYPES
// ============================================
interface Config {
    programId: string;
    statePda: string;
    stardustMint: string;
    starTokenMint: string;
    authority: string;
}

interface TestUser {
    id: number;
    publicKey: string;
    secretKey: string;
    starTokenAccount: string;
    starBalance: number;
}

interface Stats {
    totalHolders: number;
    totalEarned: string;
    totalClaimed: string;
    totalUnclaimed: string;
    totalStarBalance: string;
    timestamp: number;
}

interface EarningsData {
    wallet: string;
    lifetimeEarned: string;
    claimed: string;
    unclaimed: string;
    starBalance: string;
}

interface LeaderboardEntry {
    wallet: string;
    lifetimeEarned: string;
    claimed: string;
    starBalance: string;
    rank: number;
}

interface TreasuryData {
    totalValue: number;
    tokens: { symbol: string; amount: number; value: number; priceUsd?: number }[];
    targetApy: number;
    currentApy: number;
    apyHistory?: { timestamp: number; apy: number }[];
    revenue?: {
        monthly: number;
        weekly: number;
        totalDistributed: number;
    };
    redemptionPool?: number;
    history?: { timestamp: number; value: number }[];
}

interface WinnerEntry {
    wallet: string;
    amount: number;
    timestamp: number;
}

// ============================================
// CONSTANTS
// ============================================
const TOKEN_NAME = "$GXY";
const TOKEN_SYMBOL = "GXY";
const TOTAL_SUPPLY = 1_000_000_000; // 1 billion
const SITE_NAME = "gx402.xyz";
const TOKEN_PRICE_USD = 0.136; // Example price

// ============================================
// COMPONENTS
// ============================================

// Tooltip Component
const Tooltip: React.FC<{ text: string; children: React.ReactNode }> = ({ text, children }) => (
    <span className="tooltip-trigger">
        {children}
        <span className="tooltip-icon">?</span>
        <span className="tooltip-content">{text}</span>
    </span>
);

// Network Badge
const NetworkBadge: React.FC<{ network: "localnet" | "devnet" | "mainnet" }> = ({ network }) => (
    <div className={`network-badge ${network === "mainnet" ? "mainnet" : ""}`}>
        <span className="network-dot" />
        {network.toUpperCase()}
    </div>
);

// Token Info Bar
const TokenInfoBar: React.FC<{ config: Config | null; stats: Stats | null }> = ({ config, stats }) => {
    const marketCap = (stats ? Number(BigInt(stats.totalStarBalance || "0")) / 1e9 : 0) * TOKEN_PRICE_USD;

    return (
        <div className="token-info">
            <div className="token-info-item">
                <span className="token-info-label">Token</span>
                <span className="token-info-value">{TOKEN_NAME}</span>
            </div>
            <div className="token-info-item">
                <span className="token-info-label">Total Supply</span>
                <span className="token-info-value">{TOTAL_SUPPLY.toLocaleString()}</span>
            </div>
            <div className="token-info-item">
                <span className="token-info-label">Market Cap</span>
                <span className="token-info-value">${marketCap.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </div>
            <div className="token-info-item">
                <span className="token-info-label">Token Mint</span>
                <span className="token-info-value mono">{config?.starTokenMint?.slice(0, 8)}...{config?.starTokenMint?.slice(-4)}</span>
            </div>
        </div>
    );
};

// Stardust Info Bar
const StardustInfoBar: React.FC<{ config: Config | null; stats: Stats | null; onShowLeaderboard: () => void }> = ({
    config, stats, onShowLeaderboard
}) => {
    const totalEarned = stats ? Number(BigInt(stats.totalEarned || "0")) / 1e9 : 0;
    const totalClaimed = stats ? Number(BigInt(stats.totalClaimed || "0")) / 1e9 : 0;

    return (
        <div className="card stardust-card">
            <div className="card-header">
                <span className="card-title">✨ Stardust Protocol</span>
                <span className="card-badge">
                    <span className="network-dot" style={{ background: "#22c55e" }} />
                    LIVE
                </span>
            </div>
            <div className="stardust-stats">
                <div className="stardust-stat">
                    <div className="stardust-value">{totalEarned.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                    <div className="stardust-label">Total Earned</div>
                </div>
                <div className="stardust-stat">
                    <div className="stardust-value">{totalClaimed.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                    <div className="stardust-label">Total Claimed</div>
                </div>
                <div className="stardust-stat">
                    <div className="stardust-value">{stats?.totalHolders || 0}</div>
                    <div className="stardust-label">Holders</div>
                </div>
            </div>
            <div className="stardust-actions">
                <button className="btn btn-secondary" onClick={onShowLeaderboard}>
                    🏆 View Leaderboard
                </button>
                <span className="token-info-value mono" style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                    Mint: {config?.stardustMint?.slice(0, 8)}...{config?.stardustMint?.slice(-4)}
                </span>
            </div>
        </div>
    );
};

// User Balance Card
const UserBalanceCard: React.FC<{ earnings: EarningsData | null; claiming: boolean; onClaim: () => void }> = ({
    earnings, claiming, onClaim
}) => {
    const balance = earnings ? Number(BigInt(earnings.starBalance || "0")) / 1e9 : 0;
    const balanceUsd = balance * TOKEN_PRICE_USD;
    const earned = earnings ? Number(BigInt(earnings.lifetimeEarned || "0")) / 1e9 : 0;
    const claimed = earnings ? Number(BigInt(earnings.claimed || "0")) / 1e9 : 0;
    const unclaimed = earnings ? Number(BigInt(earnings.unclaimed || "0")) / 1e9 : 0;

    return (
        <div className="dashboard-grid">
            {/* GXY Balance */}
            <div className="card balance-card">
                <div className="card-header">
                    <Tooltip text={`Your ${TOKEN_NAME} token balance. This determines your stardust earning rate.`}>
                        <span className="card-title">Your {TOKEN_NAME} Balance</span>
                    </Tooltip>
                </div>
                <div className="balance-amount">{balance.toLocaleString()}</div>
                <div className="balance-label">
                    <span className="token-icon">⭐</span>
                    {TOKEN_NAME} Tokens
                </div>
                <div className="balance-usd">≈ ${balanceUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
            </div>

            {/* Stardust Earnings */}
            <div className="card stardust-card" style={{ gridColumn: "span 2" }}>
                <div className="card-header">
                    <Tooltip text="Stardust is earned based on the USD value of your token holdings. 1 USD worth = 1 stardust per second.">
                        <span className="card-title">Your Stardust</span>
                    </Tooltip>
                </div>
                <div className="stardust-stats">
                    <div className="stardust-stat">
                        <div className="stardust-value text-gradient">{earned.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                        <div className="stardust-label">Total Earned</div>
                    </div>
                    <div className="stardust-stat">
                        <div className="stardust-value" style={{ color: "var(--success)" }}>{claimed.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                        <div className="stardust-label">Claimed</div>
                    </div>
                    <div className="stardust-stat">
                        <div className="stardust-value text-gold">{unclaimed.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                        <div className="stardust-label">Available</div>
                    </div>
                </div>
                <div className="stardust-actions">
                    <button
                        className="btn btn-primary"
                        onClick={onClaim}
                        disabled={claiming || unclaimed <= 0}
                    >
                        {claiming ? "Processing..." : `Claim ${unclaimed.toLocaleString(undefined, { maximumFractionDigits: 0 })} ✨`}
                    </button>
                </div>
            </div>
        </div>
    );
};

// Leaderboard Modal
const LeaderboardModal: React.FC<{
    open: boolean;
    onClose: () => void;
    leaderboard: LeaderboardEntry[];
    currentWallet: string | null;
}> = ({ open, onClose, leaderboard, currentWallet }) => {
    const userRank = leaderboard.findIndex(e => e.wallet === currentWallet) + 1;

    return (
        <div className={`modal-overlay ${open ? "open" : ""}`} onClick={onClose}>
            <div className="modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 className="modal-title">🏆 Stardust Leaderboard</h2>
                    <button className="modal-close" onClick={onClose}>✕</button>
                </div>
                <div className="modal-body">
                    {currentWallet && userRank > 0 && (
                        <div className="card mb-16" style={{ background: "var(--accent-glow)" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                <div className="leaderboard-rank" style={{ background: "var(--accent-gradient)", color: "#fff" }}>
                                    #{userRank}
                                </div>
                                <span>Your Position</span>
                            </div>
                        </div>
                    )}
                    <div className="leaderboard">
                        {leaderboard.map((entry, i) => {
                            const earned = Number(BigInt(entry.lifetimeEarned || "0")) / 1e9;
                            const balance = Number(BigInt(entry.starBalance || "0")) / 1e9;
                            const isCurrentUser = entry.wallet === currentWallet;

                            return (
                                <div key={entry.wallet} className={`leaderboard-item ${isCurrentUser ? "current-user" : ""}`}>
                                    <div className={`leaderboard-rank ${i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : ""}`}>
                                        {i + 1}
                                    </div>
                                    <div className="leaderboard-wallet">
                                        {entry.wallet.slice(0, 4)}...{entry.wallet.slice(-4)}
                                    </div>
                                    <div style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
                                        {balance.toLocaleString()} {TOKEN_NAME}
                                    </div>
                                    <div className="leaderboard-earned">
                                        <div className="leaderboard-earned-value">{earned.toLocaleString(undefined, { maximumFractionDigits: 0 })} ✨</div>
                                        <div className="leaderboard-earned-label">earned</div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
};

// Treasury Section
const TreasurySection: React.FC<{ treasury: TreasuryData | null }> = ({ treasury }) => {
    return (
        <>
            <div className="card mt-32">
                <div className="card-header">
                    <span className="card-title">💰 Protocol Treasury</span>
                </div>
                <div className="treasury-grid">
                    <div className="treasury-card">
                        <div className="treasury-value">${treasury?.totalValue.toLocaleString() || 0}</div>
                        <div className="treasury-label">Total Value</div>
                    </div>
                    <div className="apy-display">
                        <div className="apy-label">Current APY</div>
                        <div className="apy-value">{(treasury?.currentApy || 0).toFixed(1)}%</div>
                        <div className="apy-target">Target: {(treasury?.targetApy || 20)}%</div>
                    </div>
                    <div className="treasury-card">
                        <div className="treasury-value positive">+${(treasury?.revenue?.monthly || 0).toLocaleString()}</div>
                        <div className="treasury-label">Monthly Revenue</div>
                    </div>
                </div>
            </div>

            {/* Token Holdings */}
            <div className="card mt-24">
                <div className="card-header">
                    <span className="card-title">📊 Token Holdings</span>
                </div>
                <div className="token-info">
                    {treasury?.tokens?.map(t => (
                        <div key={t.symbol} className="token-info-item">
                            <span className="token-info-label">{t.symbol}</span>
                            <span className="token-info-value">
                                {t.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </span>
                            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                                ${t.value.toLocaleString()} @ ${t.priceUsd || 0}
                            </span>
                        </div>
                    ))}
                </div>
            </div>

            {/* Revenue Breakdown */}
            <div className="card mt-24">
                <div className="card-header">
                    <span className="card-title">📈 Revenue & Distribution</span>
                </div>
                <div className="treasury-grid">
                    <div className="treasury-card">
                        <div className="treasury-value">${(treasury?.revenue?.weekly || 0).toLocaleString()}</div>
                        <div className="treasury-label">Weekly Revenue</div>
                    </div>
                    <div className="treasury-card">
                        <div className="treasury-value">${(treasury?.revenue?.monthly || 0).toLocaleString()}</div>
                        <div className="treasury-label">Monthly Revenue</div>
                    </div>
                    <div className="treasury-card">
                        <div className="treasury-value">${(treasury?.revenue?.totalDistributed || 0).toLocaleString()}</div>
                        <div className="treasury-label">Total Distributed</div>
                    </div>
                </div>
            </div>

            {/* Redemption Pool */}
            <div className="card mt-24" style={{ background: "linear-gradient(135deg, rgba(251, 191, 36, 0.1), rgba(245, 158, 11, 0.05))" }}>
                <div className="card-header">
                    <span className="card-title">🎰 Redemption Pool</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
                    <div>
                        <div className="treasury-value text-gold">${(treasury?.redemptionPool || 0).toLocaleString()}</div>
                        <div className="treasury-label">Available for Rewards</div>
                    </div>
                    <div style={{ flex: 1, color: "var(--text-muted)", fontSize: "0.875rem" }}>
                        10% of treasury value is allocated to the stardust redemption pool,
                        which backs the random SOL rewards when users spin.
                    </div>
                </div>
            </div>
        </>
    );
};

// Redemption Section
const RedemptionSection: React.FC<{
    unclaimedStardust: number;
    onRedeem: () => void;
    winners: WinnerEntry[];
    spinning?: boolean;
}> = ({ unclaimedStardust, onRedeem, winners, spinning = false }) => {
    const probabilities = [
        { amount: "0.001 SOL", chance: "50%", tier: "common" },
        { amount: "0.01 SOL", chance: "30%", tier: "uncommon" },
        { amount: "0.1 SOL", chance: "15%", tier: "rare" },
        { amount: "1 SOL", chance: "4.5%", tier: "epic" },
        { amount: "10 SOL", chance: "0.5%", tier: "legendary" },
    ];

    // Get tier from amount
    const getTier = (amount: number): string => {
        if (amount >= 10) return "legendary";
        if (amount >= 1) return "epic";
        if (amount >= 0.1) return "rare";
        if (amount >= 0.01) return "uncommon";
        return "common";
    };

    const getTierEmoji = (amount: number): string => {
        if (amount >= 10) return "🌟";
        if (amount >= 1) return "💎";
        if (amount >= 0.1) return "🔷";
        if (amount >= 0.01) return "🟢";
        return "⚪";
    };

    return (
        <div className="redemption-section">
            <div className="redemption-title">🎰 Stardust Redemption</div>
            <div className="redemption-desc">
                Exchange your stardust for a chance to win SOL rewards! 1000 stardust per spin.
            </div>

            <div className="probability-table">
                {probabilities.map(p => (
                    <div key={p.amount} className="probability-item">
                        <div className="probability-amount">{p.amount}</div>
                        <div className="probability-chance">{p.chance}</div>
                        <div className={`tier-badge ${p.tier}`} style={{ marginTop: 6 }}>{p.tier}</div>
                    </div>
                ))}
            </div>

            <button
                className={`btn btn-gold ${spinning ? 'spinning' : ''}`}
                onClick={onRedeem}
                disabled={unclaimedStardust < 1000 || spinning}
                style={{ width: "100%", marginBottom: 24 }}
            >
                {spinning ? '🎲 Spinning...' : '🎲 Spin (1000 ✨)'}
            </button>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div className="card-title">Recent Winners</div>
                <div className="live-indicator">
                    <div className="live-dot" />
                    LIVE
                </div>
            </div>
            <div className="winner-feed">
                {winners.length === 0 ? (
                    <div style={{ color: "var(--text-muted)", textAlign: "center", padding: 20 }}>
                        No winners yet. Be the first!
                    </div>
                ) : winners.map((w, i) => (
                    <div key={i} className={`winner-item ${i === 0 ? 'new-winner' : ''}`}>
                        <div className="winner-avatar">{getTierEmoji(w.amount)}</div>
                        <div className="winner-info">
                            <div className="winner-wallet">{w.wallet.slice(0, 4)}...{w.wallet.slice(-4)}</div>
                            <div className="winner-time">{new Date(w.timestamp).toLocaleTimeString()}</div>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                            <div className="winner-amount">+{w.amount.toFixed(3)} SOL</div>
                            <div className={`tier-badge ${getTier(w.amount)}`}>{getTier(w.amount)}</div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

// Login/Connect Modal
const LoginModal: React.FC<{
    open: boolean;
    onClose: () => void;
    testUsers: TestUser[];
    onSelectTestUser: (user: TestUser) => void;
    onImportKey: (key: string) => void;
}> = ({ open, onClose, testUsers, onSelectTestUser, onImportKey }) => {
    const [privateKey, setPrivateKey] = useState("");

    const handleImport = () => {
        if (privateKey.trim()) {
            onImportKey(privateKey.trim());
            setPrivateKey("");
        }
    };

    return (
        <div className={`modal-overlay ${open ? "open" : ""}`} onClick={onClose}>
            <div className="modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 className="modal-title">Connect Wallet</h2>
                    <button className="modal-close" onClick={onClose}>✕</button>
                </div>
                <div className="modal-body">
                    <div className="login-options">
                        <button className="btn btn-primary" style={{ width: "100%" }} disabled>
                            👻 Connect Phantom (Coming Soon)
                        </button>
                    </div>

                    <div className="login-divider">or import private key</div>

                    <input
                        type="password"
                        className="input-field"
                        placeholder="Base64 encoded private key..."
                        value={privateKey}
                        onChange={e => setPrivateKey(e.target.value)}
                    />
                    <button
                        className="btn btn-secondary mt-16"
                        style={{ width: "100%" }}
                        onClick={handleImport}
                        disabled={!privateKey.trim()}
                    >
                        Import Key
                    </button>

                    {testUsers.length > 0 && (
                        <>
                            <div className="login-divider">test users (localnet only)</div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                {testUsers.map(user => (
                                    <button
                                        key={user.id}
                                        className="btn btn-secondary"
                                        onClick={() => { onSelectTestUser(user); onClose(); }}
                                    >
                                        User {user.id} ({Math.round(user.starBalance / 1e9)} {TOKEN_NAME})
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

// Landing Page
const LandingPage: React.FC<{ onLaunchApp: () => void }> = ({ onLaunchApp }) => (
    <div className="app-container">
        <div className="landing-hero">
            <h1 className="landing-title">
                Earn Stardust by<br />
                <span className="text-gradient">Holding {TOKEN_NAME}</span>
            </h1>
            <p className="landing-subtitle">
                The Stardust Protocol rewards token holders with continuous airdrops based on their holdings' USD value.
                Simply hold {TOKEN_NAME} and watch your stardust accumulate.
            </p>
            <div className="landing-cta">
                <button className="btn btn-primary" onClick={onLaunchApp}>
                    Launch App →
                </button>
                <a href="#how-it-works" className="btn btn-secondary">
                    Learn More
                </a>
            </div>
        </div>

        <div className="features-grid" id="how-it-works">
            <div className="feature-card">
                <div className="feature-icon">⭐</div>
                <h3 className="feature-title">{TOKEN_NAME} Token</h3>
                <p className="feature-desc">
                    The core utility token of the ecosystem. Your holdings determine your earning power in the Stardust Protocol.
                </p>
            </div>
            <div className="feature-card">
                <div className="feature-icon">✨</div>
                <h3 className="feature-title">Stardust Rewards</h3>
                <p className="feature-desc">
                    Earn stardust proportional to your {TOKEN_NAME} value. 1 USD worth = ~136 stardust per earning period.
                </p>
            </div>
            <div className="feature-card">
                <div className="feature-icon">🎰</div>
                <h3 className="feature-title">SOL Redemption</h3>
                <p className="feature-desc">
                    Exchange your stardust for chances to win SOL rewards. Transparent probabilities, instant payouts.
                </p>
            </div>
        </div>

        <div className="card mt-32">
            <div className="card-header">
                <span className="card-title">Where Does the Value Come From?</span>
            </div>
            <p style={{ color: "var(--text-secondary)", lineHeight: 1.8 }}>
                The Stardust Protocol is funded by protocol revenue streams including trading fees,
                yield farming returns, and strategic partnerships. A portion of all revenue is
                allocated to the stardust treasury, which backs the redemption system.
                This creates a sustainable reward mechanism that benefits long-term holders.
            </p>
        </div>
    </div>
);

// ============================================
// MAIN APP
// ============================================
export function App() {
    // State
    const [page, setPage] = useState<"landing" | "app">("landing");
    const [activeTab, setActiveTab] = useState<"dashboard" | "treasury">("dashboard");
    const [connected, setConnected] = useState(false);
    const [publicKey, setPublicKey] = useState<string | null>(null);
    const [userKeypair, setUserKeypair] = useState<Keypair | null>(null);

    const [config, setConfig] = useState<Config | null>(null);
    const [testUsers, setTestUsers] = useState<TestUser[]>([]);
    const [stats, setStats] = useState<Stats | null>(null);
    const [earnings, setEarnings] = useState<EarningsData | null>(null);
    const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
    const [treasury, setTreasury] = useState<TreasuryData | null>(null);
    const [winners, setWinners] = useState<WinnerEntry[]>([]);

    const [claiming, setClaiming] = useState(false);
    const [showLeaderboard, setShowLeaderboard] = useState(false);
    const [showLogin, setShowLogin] = useState(false);

    // Fetch initial data
    useEffect(() => {
        fetch("/api/test-users")
            .then(r => r.json())
            .then((data: any) => {
                setTestUsers(data.users || []);
                setConfig(data.config || null);
            })
            .catch(console.error);
    }, []);

    // Fetch global data
    const fetchData = useCallback(async () => {
        try {
            const [statsRes, lbRes, treasuryRes] = await Promise.all([
                fetch("/api/stats"),
                fetch("/api/leaderboard?limit=20"),
                fetch("/api/treasury"),
            ]);
            setStats(await statsRes.json() as Stats);
            const lbData = await lbRes.json() as { leaderboard: LeaderboardEntry[] };
            setLeaderboard(lbData.leaderboard || []);
            const tData = await treasuryRes.json();
            setTreasury({
                ...tData,
                apyTarget: 20,
                currentApy: 18.5, // Calculate from real data
            });
        } catch (e) {
            console.error("Failed to fetch data:", e);
        }
    }, []);

    // Fetch user earnings
    const fetchEarnings = useCallback(async () => {
        if (!publicKey) return;
        try {
            const res = await fetch(`/api/earnings/${publicKey}`);
            const data = await res.json();
            setEarnings(data);
        } catch (e) {
            console.error("Failed to fetch earnings:", e);
        }
    }, [publicKey]);

    // Polling
    useEffect(() => {
        if (page === "app") {
            fetchData();
            const interval = setInterval(fetchData, 5000);
            return () => clearInterval(interval);
        }
    }, [page, fetchData]);

    useEffect(() => {
        if (connected && publicKey) {
            fetchEarnings();
            const interval = setInterval(fetchEarnings, 3000);
            return () => clearInterval(interval);
        }
    }, [connected, publicKey, fetchEarnings]);

    // Connect with test user
    const handleSelectTestUser = (user: TestUser) => {
        try {
            const secretKeyBinary = atob(user.secretKey);
            const secretKey = new Uint8Array(secretKeyBinary.length);
            for (let i = 0; i < secretKeyBinary.length; i++) {
                secretKey[i] = secretKeyBinary.charCodeAt(i);
            }
            const kp = Keypair.fromSecretKey(secretKey);
            setUserKeypair(kp);
            setPublicKey(user.publicKey);
            setConnected(true);
        } catch (e) {
            console.error("Failed to import key:", e);
            alert("Failed to import key");
        }
    };

    // Import private key
    const handleImportKey = (key: string) => {
        try {
            const secretKeyBinary = atob(key);
            const secretKey = new Uint8Array(secretKeyBinary.length);
            for (let i = 0; i < secretKeyBinary.length; i++) {
                secretKey[i] = secretKeyBinary.charCodeAt(i);
            }
            const kp = Keypair.fromSecretKey(secretKey);
            setUserKeypair(kp);
            setPublicKey(kp.publicKey.toBase58());
            setConnected(true);
            setShowLogin(false);
        } catch (e) {
            console.error("Failed to import key:", e);
            alert("Invalid private key format");
        }
    };

    // Disconnect
    const handleDisconnect = () => {
        setUserKeypair(null);
        setPublicKey(null);
        setConnected(false);
        setEarnings(null);
    };

    // Claim handler
    const handleClaim = async () => {
        if (!userKeypair || !publicKey || !config) return;

        setClaiming(true);
        try {
            // Get signature from backend
            const sigRes = await fetch("/api/signature", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ wallet: publicKey }),
            });

            if (!sigRes.ok) {
                throw new Error("Failed to get signature");
            }

            const sigData = await sigRes.json() as {
                signature: string;
                message: string;
                publicKey: string;
                lifetimeEarned: string;
                unclaimed: string;
            };

            if (BigInt(sigData.unclaimed) <= 0n) {
                alert("Nothing to claim");
                return;
            }

            // Build transaction
            const connection = new Connection("http://localhost:8899", "confirmed");
            const programId = new PublicKey(config.programId);
            const userPubkey = new PublicKey(publicKey);
            const statePda = new PublicKey(config.statePda);
            const stardustMint = new PublicKey(config.stardustMint);

            // Build Ed25519 instruction
            const signatureBytes = Uint8Array.from(atob(sigData.signature), c => c.charCodeAt(0));
            const messageBytes = Uint8Array.from(atob(sigData.message), c => c.charCodeAt(0));
            const authorityPubkeyBytes = Uint8Array.from(atob(sigData.publicKey), c => c.charCodeAt(0));

            const ed25519Data = new Uint8Array(2 + 14 + 32 + 64 + messageBytes.length);
            ed25519Data[0] = 1; // num_signatures
            ed25519Data[1] = 0; // padding
            const dataView = new DataView(ed25519Data.buffer);
            dataView.setUint16(2, 48, true);  // signature offset
            dataView.setUint16(4, 0xFFFF, true);
            dataView.setUint16(6, 16, true);  // public key offset
            dataView.setUint16(8, 0xFFFF, true);
            dataView.setUint16(10, 112, true); // message offset
            dataView.setUint16(12, messageBytes.length, true);
            dataView.setUint16(14, 0xFFFF, true);
            ed25519Data.set(authorityPubkeyBytes, 16);
            ed25519Data.set(signatureBytes, 48);
            ed25519Data.set(messageBytes, 112);

            const ED25519_PROGRAM_ID = new PublicKey("Ed25519SigVerify111111111111111111111111111");
            const ed25519Ix = new TransactionInstruction({
                programId: ED25519_PROGRAM_ID,
                keys: [],
                data: Buffer.from(ed25519Data),
            });

            // Derive PDAs
            const [userClaimPda] = PublicKey.findProgramAddressSync(
                [Buffer.from("user_claim"), userPubkey.toBuffer()],
                programId
            );

            const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
            const userTokenAccount = await getAssociatedTokenAddress(stardustMint, userPubkey);

            // Build claim instruction
            const discriminator = Buffer.from([0x70, 0xa0, 0x47, 0xa3, 0x6a, 0xfd, 0x33, 0xb3]);
            const lifetimeEarned = BigInt(sigData.lifetimeEarned);
            const lifetimeEarnedBuffer = Buffer.alloc(8);
            lifetimeEarnedBuffer.writeBigUInt64LE(lifetimeEarned, 0);
            const claimIxData = Buffer.concat([discriminator, lifetimeEarnedBuffer]);

            const claimIx = new TransactionInstruction({
                programId,
                keys: [
                    { pubkey: userPubkey, isSigner: true, isWritable: true },
                    { pubkey: userClaimPda, isSigner: false, isWritable: true },
                    { pubkey: statePda, isSigner: false, isWritable: false },
                    { pubkey: stardustMint, isSigner: false, isWritable: true },
                    { pubkey: userTokenAccount, isSigner: false, isWritable: true },
                    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                ],
                data: claimIxData,
            });

            // Build and send
            const tx = new Transaction();
            tx.add(ed25519Ix);
            tx.add(claimIx);

            const { blockhash } = await connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.feePayer = userPubkey;
            tx.sign(userKeypair);

            const txSignature = await connection.sendRawTransaction(tx.serialize(), {
                skipPreflight: false,
                preflightCommitment: "confirmed",
            });

            console.log("Transaction sent:", txSignature);

            // Wait for confirmation
            const latestBlockHash = await connection.getLatestBlockhash();
            const result = await connection.confirmTransaction({
                blockhash: latestBlockHash.blockhash,
                lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
                signature: txSignature,
            }, "confirmed");

            if (result.value.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
            }

            await fetch("/api/claim-confirmed", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ wallet: publicKey, signature: txSignature }),
            });

            alert(`🎉 Successfully claimed ${Number(sigData.unclaimed) / 1e9} stardust!`);
            fetchEarnings();
            fetchData();

        } catch (error: any) {
            console.error("Claim failed:", error);
            alert(`Claim failed: ${error.message}`);
        } finally {
            setClaiming(false);
        }
    };

    // Spin/Redeem handler
    const [spinning, setSpinning] = useState(false);
    const [lastSpinResult, setLastSpinResult] = useState<{
        success: boolean;
        rewardFormatted: string;
        tierName: string;
    } | null>(null);

    const handleRedeem = async () => {
        if (!publicKey) {
            setShowLogin(true);
            return;
        }

        setSpinning(true);
        setLastSpinResult(null);

        try {
            const res = await fetch("/api/redemption/spin", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ wallet: publicKey }),
            });

            const result = await res.json();

            if (!res.ok) {
                alert(`Spin failed: ${result.error}`);
                return;
            }

            setLastSpinResult({
                success: true,
                rewardFormatted: result.rewardFormatted,
                tierName: result.tierName,
            });

            // Refresh data
            fetchEarnings();
            fetchWinners();

            // Show result
            setTimeout(() => {
                alert(`🎉 ${result.tierName}! You won ${result.rewardFormatted}!`);
            }, 500);

        } catch (error: any) {
            console.error("Spin failed:", error);
            alert(`Spin failed: ${error.message}`);
        } finally {
            setSpinning(false);
        }
    };

    // Fetch recent winners
    const fetchWinners = useCallback(async () => {
        try {
            const res = await fetch("/api/redemption/winners?limit=10");
            const data = await res.json();
            setWinners(data.winners?.map((w: any) => ({
                wallet: w.wallet,
                amount: w.rewardAmount / 1e9,
                timestamp: w.timestamp,
            })) || []);
        } catch (e) {
            console.error("Failed to fetch winners:", e);
        }
    }, []);

    // Fetch winners on app load
    useEffect(() => {
        if (page === "app") {
            fetchWinners();
            const interval = setInterval(fetchWinners, 10000); // Every 10s
            return () => clearInterval(interval);
        }
    }, [page, fetchWinners]);

    // Render
    if (page === "landing") {
        return (
            <>
                <div className="app-background" />
                <div className="app-container">
                    <header className="header">
                        <div className="logo">
                            <div className="logo-icon">✦</div>
                            <div>
                                <div className="logo-text">GX402</div>
                                <div className="logo-domain">{SITE_NAME}</div>
                            </div>
                        </div>
                        <button className="btn btn-primary" onClick={() => setPage("app")}>
                            Launch App
                        </button>
                    </header>
                </div>
                <LandingPage onLaunchApp={() => setPage("app")} />
            </>
        );
    }

    const unclaimedStardust = earnings ? Number(BigInt(earnings.unclaimed || "0")) / 1e9 : 0;

    return (
        <>
            <div className="app-background" />
            <div className="app-container">
                {/* Header */}
                <header className="header">
                    <div className="logo">
                        <div className="logo-icon">✦</div>
                        <div>
                            <div className="logo-text">GX402</div>
                            <div className="logo-domain">{SITE_NAME}</div>
                        </div>
                    </div>

                    <nav className="nav-tabs">
                        <button
                            className={`nav-tab ${activeTab === "dashboard" ? "active" : ""}`}
                            onClick={() => setActiveTab("dashboard")}
                        >
                            Dashboard
                        </button>
                        <button
                            className={`nav-tab ${activeTab === "treasury" ? "active" : ""}`}
                            onClick={() => setActiveTab("treasury")}
                        >
                            Treasury
                        </button>
                    </nav>

                    <div className="wallet-section">
                        <NetworkBadge network="localnet" />
                        {connected ? (
                            <button className="btn-wallet connected" onClick={handleDisconnect}>
                                <span className="wallet-address">
                                    {publicKey?.slice(0, 4)}...{publicKey?.slice(-4)}
                                </span>
                                Disconnect
                            </button>
                        ) : (
                            <button className="btn-wallet" onClick={() => setShowLogin(true)}>
                                Connect Wallet
                            </button>
                        )}
                    </div>
                </header>

                {/* Token Info */}
                <TokenInfoBar config={config} stats={stats} />

                {/* Main Content */}
                {activeTab === "dashboard" && (
                    <>
                        {connected ? (
                            <UserBalanceCard
                                earnings={earnings}
                                claiming={claiming}
                                onClaim={handleClaim}
                            />
                        ) : (
                            <div className="card" style={{ textAlign: "center", padding: 60 }}>
                                <h2 style={{ marginBottom: 16 }}>Connect to View Your Dashboard</h2>
                                <p style={{ color: "var(--text-muted)", marginBottom: 24 }}>
                                    Connect your wallet to see your {TOKEN_NAME} balance and stardust earnings
                                </p>
                                <button className="btn btn-primary" onClick={() => setShowLogin(true)}>
                                    Connect Wallet
                                </button>
                            </div>
                        )}

                        <StardustInfoBar
                            config={config}
                            stats={stats}
                            onShowLeaderboard={() => setShowLeaderboard(true)}
                        />

                        {connected && (
                            <RedemptionSection
                                unclaimedStardust={unclaimedStardust}
                                onRedeem={handleRedeem}
                                winners={winners}
                                spinning={spinning}
                            />
                        )}
                    </>
                )}

                {activeTab === "treasury" && (
                    <TreasurySection treasury={treasury} />
                )}

                {/* Footer */}
                <footer style={{
                    textAlign: "center",
                    padding: "40px 0",
                    color: "var(--text-muted)",
                    borderTop: "1px solid var(--border-subtle)",
                    marginTop: 60,
                    fontSize: "0.8rem"
                }}>
                    <div style={{ marginBottom: 8 }}>
                        Program: {config?.programId?.slice(0, 8)}...{config?.programId?.slice(-4)}
                    </div>
                    <div>
                        © 2026 {SITE_NAME} — Stardust Protocol
                    </div>
                </footer>
            </div>

            {/* Modals */}
            <LeaderboardModal
                open={showLeaderboard}
                onClose={() => setShowLeaderboard(false)}
                leaderboard={leaderboard}
                currentWallet={publicKey}
            />

            <LoginModal
                open={showLogin}
                onClose={() => setShowLogin(false)}
                testUsers={testUsers}
                onSelectTestUser={handleSelectTestUser}
                onImportKey={handleImportKey}
            />
        </>
    );
}

// ============================================
// MOUNT THE APP
// ============================================
import { createRoot } from "react-dom/client";

const container = document.getElementById("root");
if (container) {
    const root = createRoot(container);
    root.render(<App />);
}
