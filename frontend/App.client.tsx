import React, { useState, useEffect, useCallback } from "react";
import { PublicKey, Connection, Transaction, TransactionInstruction, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";

// ============================================
// TYPES
// ============================================
interface Config {
    programId: string;
    statePda: string;
    stardustMint: string;
    starTokenMint: string;
    authority: string;
    rpcUrl: string;
}

interface EarningsData {
    wallet: string;
    lifetimeEarned: string;
    claimed: string;
    unclaimed: string;
    isCapped?: boolean;
    starBalance: string;
    stardustTokenBalance?: string; // Actual current stardust token balance
}

interface LeaderboardEntry {
    wallet: string;
    lifetimeEarned: string;
    claimed: string;
    starBalance: string;
    rank: number;
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
const TOKEN_PRICE_USD = 0.136;
const SPIN_COST = 1_000; // 1K stardust (temporarily reduced for testing)
const ADMIN_AUTHORITY = "77cQ99WQ2FWQT19kgpN2a9CfgYSfDqpomNVGtyYUrpAY";
const WHEEL_PROGRAM_ID = "3M12BfitAEYz14WJBMnjahEuSvhsWhjfGJXbzur26o2U";

// ============================================
// TOAST NOTIFICATIONS
// ============================================
interface Toast {
    id: string;
    type: 'success' | 'error' | 'pending';
    message: string;
    txSignature?: string;
}

const ToastContainer: React.FC<{
    toasts: Toast[];
    onDismiss: (id: string) => void;
}> = ({ toasts, onDismiss }) => (
    <div className="toast-container">
        {toasts.map(toast => (
            <div key={toast.id} className={`toast toast-${toast.type}`}>
                <div className="toast-icon">
                    {toast.type === 'success' && '✅'}
                    {toast.type === 'error' && '❌'}
                    {toast.type === 'pending' && '⏳'}
                </div>
                <div className="toast-content">
                    <div className="toast-message">{toast.message}</div>
                    {toast.txSignature && (
                        <a
                            href={`https://solscan.io/tx/${toast.txSignature}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="toast-link"
                        >
                            View on Solscan →
                        </a>
                    )}
                </div>
                <button className="toast-close" onClick={() => onDismiss(toast.id)}>×</button>
            </div>
        ))}
    </div>
);

// ============================================
// COMPONENTS
// ============================================

// Header Component
const Header: React.FC<{
    connected: boolean;
    publicKey: string | null;
    onConnect: () => void;
    onDisconnect: () => void;
}> = ({ connected, publicKey, onConnect, onDisconnect }) => (
    <header className="header">
        <div className="logo">
            <div className="logo-icon">✦</div>
            <div>
                <div className="logo-text">GX402</div>
                <div className="logo-domain">gx402.xyz</div>
            </div>
        </div>
        <nav className="header-nav">
            <a href="#wallet" className="nav-link" onClick={(e) => { e.preventDefault(); document.getElementById('wallet')?.scrollIntoView({ behavior: 'smooth' }); }}>
                Wallet
            </a>
            <a href="#wheel" className="nav-link" onClick={(e) => { e.preventDefault(); document.getElementById('wheel')?.scrollIntoView({ behavior: 'smooth' }); }}>
                Wheel
            </a>
            <a href="#leaders" className="nav-link" onClick={(e) => { e.preventDefault(); document.getElementById('leaders')?.scrollIntoView({ behavior: 'smooth' }); }}>
                Leaders
            </a>
            <a href="#history" className="nav-link" onClick={(e) => { e.preventDefault(); document.getElementById('history')?.scrollIntoView({ behavior: 'smooth' }); }}>
                History
            </a>
        </nav>
        <div className="header-right">
            <div className="network-badge mainnet">
                <span className="network-dot" />
                MAINNET
            </div>
            {connected ? (
                <button className="btn-wallet connected" onClick={onDisconnect}>
                    <span className="wallet-address">
                        {publicKey?.slice(0, 4)}...{publicKey?.slice(-4)}
                    </span>
                    Disconnect
                </button>
            ) : (
                <button className="btn-wallet" onClick={onConnect}>
                    Connect Wallet
                </button>
            )}
        </div>
    </header>
);

// Rules Banner
const RulesBanner: React.FC = () => (
    <div className="rules-banner">
        <div className="rules-content">
            <span className="rules-icon">✨</span>
            <span className="rules-text">
                <strong>Galaxy Wheel:</strong> Spend {SPIN_COST.toLocaleString()} stardust to spin and win SOL rewards!
                Stardust accumulates based on your {TOKEN_NAME} holdings.
            </span>
        </div>
    </div>
);

// Section with vertical label
const Section: React.FC<{
    label: string;
    children: React.ReactNode;
    className?: string;
    id?: string;
}> = ({ label, children, className = "", id }) => (
    <div id={id} className={`section-row ${className}`}>
        <div className="section-label">
            <span>{label}</span>
        </div>
        <div className="section-content">
            {children}
        </div>
    </div>
);

// My Wallet Section
const MyWalletSection: React.FC<{
    earnings: EarningsData | null;
    claiming: boolean;
    onClaim: () => void;
}> = ({ earnings, claiming, onClaim }) => {
    const balance = earnings ? Number(BigInt(earnings.starBalance || "0")) / 1e9 : 0;
    const balanceUsd = balance * TOKEN_PRICE_USD;
    // Use stardustTokenBalance (actual current balance) instead of claimed (total ever claimed)
    const stardustBalance = earnings ? Number(BigInt(earnings.stardustTokenBalance || earnings.claimed || "0")) / 1e9 : 0;
    const unclaimed = earnings ? Number(BigInt(earnings.unclaimed || "0")) / 1e9 : 0;

    return (
        <Section label="MY WALLET" className="wallet-section" id="wallet">
            <div className="wallet-grid">
                <div className="wallet-card">
                    <div className="wallet-card-label">{TOKEN_NAME} Balance</div>
                    <div className="wallet-card-value">{balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                    <div className="wallet-card-usd">≈ ${balanceUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })} USD</div>
                </div>
                <div className="wallet-card stardust">
                    <div className="stardust-row">
                        <div>
                            <div className="wallet-card-label">Stardust Balance</div>
                            <div className="wallet-card-value">{stardustBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })} ✨</div>
                        </div>
                        <div className="stardust-divider" />
                        <div>
                            <div className="wallet-card-label">Available to Claim</div>
                            <div className="wallet-card-value text-gold">{unclaimed.toLocaleString(undefined, { maximumFractionDigits: 0 })} ✨</div>
                        </div>
                        <button
                            className="btn btn-primary claim-btn"
                            onClick={onClaim}
                            disabled={claiming || unclaimed <= 0}
                        >
                            {claiming ? "Claiming..." : "CLAIM"}
                        </button>
                    </div>
                </div>
            </div>
        </Section>
    );
};

// Galaxy Wheel Section
const GalaxyWheelSection: React.FC<{
    available: number;
    spinning: boolean;
    onSpin: () => void;
    isAdmin?: boolean;
    treasuryBalance?: number;
    onFundTreasury?: (amount: number) => void;
}> = ({ available, spinning, onSpin, isAdmin, treasuryBalance, onFundTreasury }) => {
    const canSpin = available >= SPIN_COST;
    const [fundAmount, setFundAmount] = React.useState("0.1");

    // Wheel segments - now showing actual treasury percentages
    const segments = [
        { label: "Nothing", color: "#94a3b8", percent: 10, reward: 0 },
        { label: "1%", color: "#22c55e", percent: 75, reward: 1 },
        { label: "10%", color: "#3b82f6", percent: 14, reward: 10 },
        { label: "50%", color: "#fbbf24", percent: 1, reward: 50 },
    ];

    return (
        <Section label="GALAXY WHEEL" className="wheel-section" id="wheel">
            {/* Treasury Info - always visible */}
            {treasuryBalance !== undefined && (
                <div className="treasury-info" style={{ textAlign: "center", marginBottom: 16, padding: 12, background: "rgba(251, 191, 36, 0.1)", borderRadius: 8, border: "1px solid var(--gold-primary)" }}>
                    <div style={{ fontSize: 14, color: "var(--text-muted)" }}>Treasury Pool</div>
                    <div style={{ fontSize: 24, fontWeight: "bold", color: "var(--gold-primary)" }}>{treasuryBalance.toFixed(4)} SOL</div>
                    <div style={{ fontSize: 12, marginTop: 8, display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap" }}>
                        {segments.slice(1).map((seg, i) => (
                            <span key={i} style={{ color: seg.color }}>
                                {seg.percent}% chance → {((treasuryBalance * seg.reward) / 100).toFixed(4)} SOL
                            </span>
                        ))}
                    </div>
                </div>
            )}

            <div className="wheel-container" style={{ display: "flex", alignItems: "center", gap: 32, flexWrap: "wrap", justifyContent: "center" }}>
                <div className="wheel-wrapper">
                    <div className="wheel-pointer">▼</div>
                    <svg viewBox="0 0 200 200" className={`wheel-svg ${spinning ? 'spinning' : ''}`}>
                        {(() => {
                            // Calculate proportional angles
                            let startAngle = -90; // Start from top
                            return segments.map((seg, i) => {
                                const sweepAngle = (seg.percent / 100) * 360;
                                const endAngle = startAngle + sweepAngle;
                                const startRad = (startAngle * Math.PI) / 180;
                                const endRad = (endAngle * Math.PI) / 180;
                                const x1 = 100 + 85 * Math.cos(startRad);
                                const y1 = 100 + 85 * Math.sin(startRad);
                                const x2 = 100 + 85 * Math.cos(endRad);
                                const y2 = 100 + 85 * Math.sin(endRad);
                                const largeArc = sweepAngle > 180 ? 1 : 0;
                                const path = `M100,100 L${x1},${y1} A85,85 0 ${largeArc},1 ${x2},${y2} Z`;

                                // Text position in middle of arc
                                const midAngle = startAngle + sweepAngle / 2;
                                const midRad = (midAngle * Math.PI) / 180;
                                const textX = 100 + 55 * Math.cos(midRad);
                                const textY = 100 + 55 * Math.sin(midRad);

                                // Calculate reward amount
                                const rewardAmount = treasuryBalance ? ((treasuryBalance * seg.reward) / 100).toFixed(3) : "0";
                                const displayText = seg.reward === 0 ? "0" : rewardAmount;

                                const result = (
                                    <g key={i}>
                                        <path d={path} fill={seg.color} stroke="#0a0d0f" strokeWidth="2" />
                                        {sweepAngle > 15 && (
                                            <text x={textX} y={textY} fill="#fff" fontSize="10" fontWeight="bold" textAnchor="middle" dominantBaseline="middle">
                                                {displayText}
                                            </text>
                                        )}
                                    </g>
                                );
                                startAngle = endAngle;
                                return result;
                            });
                        })()}
                        <circle cx="100" cy="100" r="25" fill="#0a0d0f" stroke="#fbbf24" strokeWidth="3" />
                        <text x="100" y="100" fill="#fbbf24" fontSize="14" textAnchor="middle" dominantBaseline="middle">SOL</text>
                    </svg>
                </div>

                {/* Legend */}
                <div className="wheel-legend" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {segments.map((seg, i) => {
                        const rewardAmount = treasuryBalance ? ((treasuryBalance * seg.reward) / 100).toFixed(4) : "0.0000";
                        return (
                            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <div style={{ width: 16, height: 16, borderRadius: 4, background: seg.color }} />
                                <div style={{ fontSize: 13 }}>
                                    <span style={{ fontWeight: "bold" }}>{seg.percent}%</span>
                                    <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>
                                        {seg.reward === 0 ? "Nothing" : `${rewardAmount} SOL`}
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>

                <div className="wheel-info">
                    <div className="wheel-cost">Cost: {SPIN_COST.toLocaleString()} ✨</div>
                    <button
                        className={`btn btn-gold spin-btn ${spinning ? 'spinning' : ''}`}
                        onClick={onSpin}
                        disabled={!canSpin || spinning}
                    >
                        {spinning ? '🎲 SPINNING...' : '🎲 SPIN NOW'}
                    </button>
                    {!canSpin && <div className="wheel-need">Need {(SPIN_COST - available).toLocaleString()} more ✨</div>}
                </div>
            </div>

            {/* Admin Controls - only visible to deployer */}
            {isAdmin && onFundTreasury && (
                <div className="admin-panel" style={{ marginTop: 20, padding: 16, background: "rgba(34, 197, 94, 0.1)", borderRadius: 8, border: "1px solid var(--success)" }}>
                    <div style={{ fontSize: 14, fontWeight: "bold", color: "var(--success)", marginBottom: 12 }}>🔐 Admin Controls</div>
                    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                        <label style={{ fontSize: 14 }}>Fund Treasury:</label>
                        <input
                            type="number"
                            value={fundAmount}
                            onChange={(e) => setFundAmount(e.target.value)}
                            step="0.1"
                            min="0.01"
                            style={{ background: "var(--bg-tertiary)", border: "1px solid var(--border-light)", borderRadius: 6, padding: "6px 10px", color: "var(--text-primary)", width: 100 }}
                        />
                        <span>SOL</span>
                        <button
                            className="btn btn-gold"
                            onClick={() => onFundTreasury(parseFloat(fundAmount))}
                            style={{ padding: "6px 16px" }}
                        >
                            💰 Fund
                        </button>
                    </div>
                </div>
            )}
        </Section>
    );
};

// Leaders Section
const LeadersSection: React.FC<{
    leaderboard: LeaderboardEntry[];
    currentWallet: string | null;
}> = ({ leaderboard, currentWallet }) => (
    <Section label="LEADERS" className="leaders-section" id="leaders">
        <table className="leaders-table">
            <thead>
                <tr>
                    <th>#</th>
                    <th>Wallet</th>
                    <th>Claimed Stardust</th>
                </tr>
            </thead>
            <tbody>
                {leaderboard.length === 0 ? (
                    <tr><td colSpan={3} className="empty">No data yet</td></tr>
                ) : leaderboard.slice(0, 10).map((entry, i) => {
                    const claimed = Number(BigInt(entry.claimed || "0")) / 1e9;
                    const isMe = entry.wallet === currentWallet;
                    return (
                        <tr key={entry.wallet} className={isMe ? 'current-user' : ''}>
                            <td className={`rank ${i < 3 ? ['gold', 'silver', 'bronze'][i] : ''}`}>{i + 1}</td>
                            <td className="wallet">{entry.wallet.slice(0, 4)}...{entry.wallet.slice(-4)}</td>
                            <td>{claimed.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    </Section>
);

// History Section
const HistorySection: React.FC<{ winners: WinnerEntry[] }> = ({ winners }) => (
    <Section label="HISTORY" className="history-section" id="history">
        <div className="history-header">
            <span>Recent Wins</span>
            <span className="live-badge"><span className="live-dot" />LIVE</span>
        </div>
        <div className="history-feed">
            {winners.length === 0 ? (
                <div className="empty">No spins yet. Be the first!</div>
            ) : winners.map((w, i) => (
                <div key={i} className={`history-item ${i === 0 ? 'new' : ''}`}>
                    <span className="history-wallet">{w.wallet.slice(0, 4)}...{w.wallet.slice(-4)}</span>
                    <span className="history-won">won</span>
                    <span className="history-amount">{w.amount.toFixed(3)} SOL</span>
                    <span className="history-time">{formatTimeAgo(w.timestamp)}</span>
                </div>
            ))}
        </div>
    </Section>
);

// Helper
function formatTimeAgo(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}

// ============================================
// MAIN APP
// ============================================
function App() {
    // State
    const [connected, setConnected] = useState(false);
    const [publicKey, setPublicKey] = useState<string | null>(null);
    const [config, setConfig] = useState<Config | null>(null);
    const [earnings, setEarnings] = useState<EarningsData | null>(null);
    const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
    const [winners, setWinners] = useState<WinnerEntry[]>([]);
    const [claiming, setClaiming] = useState(false);
    const [spinning, setSpinning] = useState(false);
    const [showLogin, setShowLogin] = useState(false);
    const [phantomWallet, setPhantomWallet] = useState<any>(null);
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [treasuryBalance, setTreasuryBalance] = useState<number>(0);

    // Check if current user is admin
    const isAdmin = publicKey === ADMIN_AUTHORITY;

    // Toast helpers
    const addToast = useCallback((type: Toast['type'], message: string, txSignature?: string) => {
        const id = Date.now().toString();
        setToasts(prev => [...prev, { id, type, message, txSignature }]);
        // Auto dismiss after 8 seconds for success/error
        if (type !== 'pending') {
            setTimeout(() => dismissToast(id), 8000);
        }
        return id;
    }, []);

    const dismissToast = useCallback((id: string) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    }, []);

    const updateToast = useCallback((id: string, type: Toast['type'], message: string, txSignature?: string) => {
        setToasts(prev => prev.map(t => t.id === id ? { ...t, type, message, txSignature } : t));
        // Auto dismiss after 8 seconds
        setTimeout(() => dismissToast(id), 8000);
    }, []);

    // Restore wallet from localStorage
    useEffect(() => {
        const saved = localStorage.getItem('stardust-wallet');
        if (saved) {
            setPublicKey(saved);
            setConnected(true);
            fetch('/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ wallet: saved }),
            }).catch(console.error);
        }
    }, []);

    // Check Phantom
    useEffect(() => {
        const check = () => {
            if ((window as any).solana?.isPhantom) {
                setPhantomWallet((window as any).solana);
            }
        };
        check();
        window.addEventListener('load', check);
        return () => window.removeEventListener('load', check);
    }, []);

    // Connect Phantom
    const handleConnect = async () => {
        if (!phantomWallet) {
            window.open('https://phantom.app/', '_blank');
            return;
        }
        try {
            // Check if already connected
            if (phantomWallet.isConnected && phantomWallet.publicKey) {
                const pk = phantomWallet.publicKey.toString();
                setPublicKey(pk);
                setConnected(true);
                localStorage.setItem('stardust-wallet', pk);
                await fetch('/api/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ wallet: pk }),
                });
                return;
            }

            const resp = await phantomWallet.connect();
            const pk = resp.publicKey.toString();
            setPublicKey(pk);
            setConnected(true);
            localStorage.setItem('stardust-wallet', pk);
            await fetch('/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ wallet: pk }),
            });
        } catch (e: any) {
            console.error('Connect failed:', e);

            // Handle known Phantom errors with helpful messages
            const errorMsg = e?.message || String(e);
            if (errorMsg.includes('Unexpected error') || errorMsg.includes('Me:')) {
                // This is a known Phantom internal error
                addToast('error', '⚠️ Phantom connection issue. Try: 1) Unlock your wallet 2) Refresh the page 3) Clear browser cache for this site');
            } else if (errorMsg.includes('User rejected') || errorMsg.includes('cancel')) {
                addToast('error', 'Connection cancelled');
            } else {
                addToast('error', `Connection failed: ${errorMsg}`);
            }
        }
    };

    const handleDisconnect = () => {
        setConnected(false);
        setPublicKey(null);
        setEarnings(null);
        localStorage.removeItem('stardust-wallet');
    };

    // Fetch config and treasury on mount
    useEffect(() => {
        fetch('/api/config')
            .then(r => {
                if (!r.ok) throw new Error(`Config fetch failed: ${r.status}`);
                return r.json();
            })
            .then(setConfig)
            .catch(err => {
                console.error('Config fetch failed:', err);
                addToast('error', '⚠️ Failed to load app config. Please refresh.');
            });
        fetch('/api/wheel/treasury')
            .then(r => {
                if (!r.ok) throw new Error(`Treasury fetch failed: ${r.status}`);
                return r.json();
            })
            .then((d: any) => setTreasuryBalance(d.balance || 0))
            .catch(err => {
                console.error('Treasury fetch failed:', err);
            });
    }, [addToast]);

    // Fetch earnings
    const fetchEarnings = useCallback(async () => {
        if (!publicKey) return;
        try {
            const res = await fetch(`/api/earnings/${publicKey}`);
            if (!res.ok) {
                const errorData = await res.json().catch(() => ({}));
                // Check for rate limiting
                if (res.status === 429 || errorData.error?.includes('429')) {
                    console.warn('Rate limited when fetching earnings');
                    addToast('error', '⚠️ RPC rate limited. Balances may be delayed. Please wait...');
                    return;
                }
                throw new Error(errorData.error || `HTTP ${res.status}`);
            }
            const data = await res.json();

            // Check if there's an error in the response
            if (data.error) {
                if (data.error.includes('429') || data.error.includes('rate')) {
                    addToast('error', '⚠️ RPC rate limited. Balances may be stale.');
                } else {
                    addToast('error', `⚠️ ${data.error}`);
                }
                return;
            }

            // Check for RPC warning (non-blocking but informative)
            if (data.rpcWarning) {
                // Only show warning toast occasionally to avoid spamming (every 30 seconds max)
                const lastWarningKey = 'last-rpc-warning-toast';
                const lastWarning = parseInt(localStorage.getItem(lastWarningKey) || '0');
                if (Date.now() - lastWarning > 30000) {
                    addToast('error', `⚠️ ${data.rpcWarning}`);
                    localStorage.setItem(lastWarningKey, Date.now().toString());
                }
            }

            setEarnings(data);
        } catch (e: any) {
            console.error('Fetch earnings failed:', e);
            // Only show toast for non-network errors (avoid spamming on connectivity issues)
            if (!e.message?.includes('fetch')) {
                addToast('error', `Failed to fetch balances: ${e.message}`);
            }
        }
    }, [publicKey, addToast]);

    useEffect(() => {
        fetchEarnings();
        const interval = setInterval(fetchEarnings, 30000); // 30 seconds to avoid rate limiting
        return () => clearInterval(interval);
    }, [fetchEarnings]);

    // Fetch leaderboard
    useEffect(() => {
        const fetchLb = async () => {
            try {
                const res = await fetch('/api/leaderboard?limit=20');
                const data = await res.json();
                setLeaderboard(data.leaderboard || []);
            } catch (e) {
                console.error('Fetch leaderboard failed:', e);
            }
        };
        fetchLb();
        const interval = setInterval(fetchLb, 30000);
        return () => clearInterval(interval);
    }, []);

    // Fetch winners
    const fetchWinners = useCallback(async () => {
        try {
            const res = await fetch('/api/redemption/winners?limit=20');
            const data = await res.json();
            setWinners(data.winners?.map((w: any) => ({
                wallet: w.wallet,
                amount: w.rewardAmount / 1e9,
                timestamp: w.timestamp,
            })) || []);
        } catch (e) {
            console.error('Fetch winners failed:', e);
        }
    }, []);

    useEffect(() => {
        fetchWinners();
        const interval = setInterval(fetchWinners, 5000);
        return () => clearInterval(interval);
    }, [fetchWinners]);

    // Claim handler - builds and sends transaction via Phantom
    const handleClaim = async () => {
        if (!publicKey || !earnings || !phantomWallet || !config) return;

        const unclaimed = Number(BigInt(earnings.unclaimed || "0"));
        if (unclaimed <= 0) {
            alert('Nothing to claim!');
            return;
        }

        setClaiming(true);
        try {
            // 1. Get backend-signed payload
            const sigRes = await fetch('/api/signature', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ wallet: publicKey }),
            });

            if (!sigRes.ok) {
                const err = await sigRes.json();
                alert(`Failed to get signature: ${err.error}`);
                return;
            }

            const sigData = await sigRes.json();
            console.log('Backend signature data:', sigData);

            // 2. Build the transaction
            // Use RPC URL from config (loaded from backend's environment)
            const rpcUrl = config.rpcUrl || 'https://mainnet.helius-rpc.com/?api-key=093c9b83-eb11-418c-8aeb-b96bf06c848e';
            const connection = new Connection(rpcUrl, {
                commitment: 'confirmed',
                wsEndpoint: undefined, // Disable WebSocket, use HTTP polling
            });
            const userPubkey = new PublicKey(publicKey);
            const programId = new PublicKey(config.programId);
            const statePda = new PublicKey(config.statePda);
            const stardustMint = new PublicKey(config.stardustMint);

            // Get user's stardust token account (ATA)
            const { getAssociatedTokenAddress } = await import('@solana/spl-token');
            const userStardustAta = await getAssociatedTokenAddress(stardustMint, userPubkey);

            // Derive user_claim PDA: seeds = ["user_claim", user.key()]
            const [userClaimPda] = PublicKey.findProgramAddressSync(
                [Buffer.from("user_claim"), userPubkey.toBuffer()],
                programId
            );

            // Create Ed25519 instruction from backend data
            const ed25519ProgramId = new PublicKey(sigData.ed25519Instruction.programId);
            const ed25519Data = Buffer.from(sigData.ed25519Instruction.data, 'base64');
            const ed25519Ix = new TransactionInstruction({
                programId: ed25519ProgramId,
                keys: [], // Ed25519 program doesn't need any accounts
                data: ed25519Data,
            });

            // Create claim instruction
            // Anchor discriminator for "claim_stardust" = first 8 bytes of sha256("global:claim_stardust")
            // Correct: [112, 160, 71, 163, 106, 253, 51, 179] = 0x70a047a36afd33b3
            const lifetimeEarned = BigInt(sigData.lifetimeEarned);
            const claimData = Buffer.alloc(16); // 8 bytes discriminator + 8 bytes u64
            // Anchor discriminator for claim_stardust
            const discriminator = [112, 160, 71, 163, 106, 253, 51, 179];
            for (let i = 0; i < 8; i++) {
                claimData.writeUInt8(discriminator[i], i);
            }
            claimData.writeBigUInt64LE(lifetimeEarned, 8);

            // Accounts in order matching ClaimStardust struct in lib.rs:
            // 1. user (signer, mut)
            // 2. user_claim (PDA, init_if_needed, mut)
            // 3. state (PDA)
            // 4. stardust_mint (mut)
            // 5. user_token_account (ATA, mut)
            // 6. instructions (sysvar)
            // 7. system_program
            // 8. token_program
            const claimIx = new TransactionInstruction({
                programId,
                keys: [
                    { pubkey: userPubkey, isSigner: true, isWritable: true },
                    { pubkey: userClaimPda, isSigner: false, isWritable: true },
                    { pubkey: statePda, isSigner: false, isWritable: false },
                    { pubkey: stardustMint, isSigner: false, isWritable: true },
                    { pubkey: userStardustAta, isSigner: false, isWritable: true },
                    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                    { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false },
                ],
                data: claimData,
            });

            // Build transaction
            const transaction = new Transaction();

            // First, create ATA if it doesn't exist (idempotent - won't fail if exists)
            const { createAssociatedTokenAccountIdempotentInstruction, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
            const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
                userPubkey, // payer
                userStardustAta, // ata
                userPubkey, // owner
                stardustMint, // mint
            );
            transaction.add(createAtaIx);

            // Add Ed25519 and claim instructions
            transaction.add(ed25519Ix);
            transaction.add(claimIx);

            // Get recent blockhash
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = userPubkey;

            // 3. Send to Phantom for signing
            console.log('Requesting Phantom signature...');
            const { signature } = await phantomWallet.signAndSendTransaction(transaction);
            console.log('Transaction sent:', signature);

            // 4. Wait for confirmation
            const confirmation = await connection.confirmTransaction({
                signature,
                blockhash,
                lastValidBlockHeight,
            }, 'confirmed');

            if (confirmation.value.err) {
                throw new Error('Transaction failed on-chain');
            }

            // 5. Notify backend
            await fetch('/api/claim-confirmed', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ wallet: publicKey, signature }),
            });

            addToast('success', '✅ Claimed successfully!', signature);
            fetchEarnings();

        } catch (e: any) {
            console.error('Claim error:', e);
            if (e.message?.includes('User rejected')) {
                addToast('error', 'Transaction cancelled by user');
            } else {
                addToast('error', `Claim failed: ${e.message}`);
            }
        } finally {
            setClaiming(false);
        }
    };

    // Spin handler - On-chain transaction
    const handleSpin = async () => {
        if (!publicKey || !phantomWallet) {
            setShowLogin(true);
            return;
        }

        // Don't start spinning animation yet - wait for successful simulation and signing
        const toastId = addToast('pending', '⏳ Preparing spin transaction...');

        try {
            // Use RPC URL from config
            const rpcUrl = config?.rpcUrl || 'https://mainnet.helius-rpc.com/?api-key=093c9b83-eb11-418c-8aeb-b96bf06c848e';
            console.log("Using RPC URL:", rpcUrl);
            const connection = new Connection(rpcUrl, "confirmed");
            const userPubkey = new PublicKey(publicKey);
            const wheelProgramId = new PublicKey(WHEEL_PROGRAM_ID);

            // PDAs
            const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("wheel_state")], wheelProgramId);
            const [poolPda] = PublicKey.findProgramAddressSync([Buffer.from("wheel_pool")], wheelProgramId);
            const [userHistoryPda] = PublicKey.findProgramAddressSync(
                [Buffer.from("user_history"), userPubkey.toBytes()],
                wheelProgramId
            );

            // Stardust mint - now correctly set on-chain after fix
            const stardustMint = new PublicKey(config?.stardustMint || "XG3VfC9e8hzjaeQutPHrCs1YE6jwbdCqhfRpY8miWo5");

            // Get user's stardust token account
            const userStardustAta = await getAssociatedTokenAddress(stardustMint, userPubkey);

            // Check if user has the stardust token account and sufficient balance BEFORE simulating
            try {
                const tokenBalance = await connection.getTokenAccountBalance(userStardustAta);
                const balance = tokenBalance.value.uiAmount || 0;
                console.log("User stardust balance:", balance);
                if (balance < SPIN_COST) {
                    dismissToast(toastId);
                    addToast('error', `Insufficient stardust! You have ${balance.toLocaleString()} but need ${SPIN_COST.toLocaleString()} ✨ to spin.`);
                    return;
                }
            } catch (e: any) {
                console.error("Token account check failed:", e);
                console.error("Error details:", e.message || e);
                dismissToast(toastId);
                // More specific error message
                if (e.message?.includes('could not find account') || e.message?.includes('Token account does not exist')) {
                    addToast('error', 'No stardust token account found. Please claim stardust first by holding $GXY tokens.');
                } else {
                    addToast('error', `Failed to check stardust balance: ${e.message || 'Unknown error'}`);
                }
                return;
            }

            // Spin discriminator: sha256("global:spin")[:8]
            const spinDiscriminator = Buffer.from([0x57, 0x40, 0x78, 0x0a, 0x19, 0xe0, 0x7a, 0x5d]);

            // Account order MUST match Spin context in lib.rs:
            // 1. state, 2. pool, 3. stardust_mint, 4. user_stardust, 5. user_history, 6. user, 7. token_program, 8. system_program
            const spinIx = new TransactionInstruction({
                programId: wheelProgramId,
                keys: [
                    { pubkey: statePda, isSigner: false, isWritable: true },          // state
                    { pubkey: poolPda, isSigner: false, isWritable: true },           // pool
                    { pubkey: stardustMint, isSigner: false, isWritable: true },      // stardust_mint
                    { pubkey: userStardustAta, isSigner: false, isWritable: true },   // user_stardust
                    { pubkey: userHistoryPda, isSigner: false, isWritable: true },    // user_history
                    { pubkey: userPubkey, isSigner: true, isWritable: true },         // user
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
                ],
                data: spinDiscriminator,
            });

            const transaction = new Transaction().add(spinIx);
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = userPubkey;

            // Simulate transaction first to catch errors before signing
            console.log("Simulating spin transaction...");
            console.log("Accounts:", {
                state: statePda.toBase58(),
                pool: poolPda.toBase58(),
                stardustMint: stardustMint.toBase58(),
                userStardust: userStardustAta.toBase58(),
                userHistory: userHistoryPda.toBase58(),
                user: userPubkey.toBase58(),
            });

            try {
                const simResult = await connection.simulateTransaction(transaction);
                if (simResult.value.err) {
                    console.error("Simulation failed:", simResult.value.err);
                    console.error("Logs:", simResult.value.logs);
                    throw new Error(`Simulation failed: ${JSON.stringify(simResult.value.err)}. Check console for logs.`);
                }
                console.log("Simulation succeeded! Logs:", simResult.value.logs);
            } catch (simErr: any) {
                console.error("Simulation error:", simErr);
                dismissToast(toastId);
                addToast('error', `Simulation failed: ${simErr.message}`);
                return;
            }

            // Simulation passed! Prompt for signing (don't start wheel yet)
            updateToast(toastId, 'pending', '✍️ Please sign the transaction in your wallet...');

            // Sign and send via Phantom
            let signature: string;
            try {
                const result = await phantomWallet.signAndSendTransaction(transaction);
                signature = result.signature;
            } catch (signErr: any) {
                dismissToast(toastId);
                if (signErr.message?.includes('User rejected')) {
                    addToast('error', 'Transaction cancelled by user');
                } else {
                    addToast('error', `Sign failed: ${signErr.message}`);
                }
                return;
            }

            // NOW start the wheel animation (after user signed)
            setSpinning(true);
            updateToast(toastId, 'pending', '🎰 Wheel is spinning... Confirming transaction...');

            // Try to confirm with timeout handling
            let confirmed = false;
            let txError: any = null;

            try {
                const confirmation = await connection.confirmTransaction({
                    signature,
                    blockhash,
                    lastValidBlockHeight,
                }, 'confirmed');

                if (confirmation.value.err) {
                    txError = new Error('Transaction failed on-chain');
                } else {
                    confirmed = true;
                }
            } catch (confirmErr: any) {
                console.warn('Confirmation error:', confirmErr);

                // If block height exceeded, the tx might still have succeeded
                // Check the transaction status directly
                if (confirmErr.message?.includes('expired') || confirmErr.message?.includes('block height')) {
                    updateToast(toastId, 'pending', '⏳ Checking transaction status...');

                    // Wait a moment and check if transaction exists
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    try {
                        const txStatus = await connection.getSignatureStatus(signature);
                        if (txStatus.value?.confirmationStatus === 'confirmed' ||
                            txStatus.value?.confirmationStatus === 'finalized') {
                            confirmed = true;
                        } else if (txStatus.value?.err) {
                            txError = new Error('Transaction failed on-chain');
                        } else {
                            // Still pending or unknown - treat as potential success
                            console.log('Transaction status unclear:', txStatus);
                            confirmed = true; // Optimistically assume success
                        }
                    } catch (statusErr) {
                        console.warn('Status check failed:', statusErr);
                        // Can't determine status - check transaction directly
                        confirmed = true; // Optimistically assume success
                    }
                } else {
                    txError = confirmErr;
                }
            }

            if (txError) {
                throw txError;
            }

            // Get transaction logs to parse result
            const txDetails = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
            const logs = txDetails?.meta?.logMessages || [];

            // Parse spin result from logs: "Spin #X: Tier Y - Won Z lamports"
            let tier = 0;
            let reward = 0;
            for (const log of logs) {
                const match = log.match(/Spin #\d+: Tier (\d+) - Won (\d+) lamports/);
                if (match) {
                    tier = parseInt(match[1]);
                    reward = parseInt(match[2]);
                    break;
                }
            }

            const tierNames = ["Nothing 😢", "Small Win ✨", "Medium Win 🎉", "JACKPOT 🏆"];
            const rewardSol = reward / 1e9;

            dismissToast(toastId);
            if (reward > 0) {
                addToast('success', `🎉 ${tierNames[tier]}! You won ${rewardSol.toFixed(4)} SOL!`, signature);
            } else {
                addToast('info', `${tierNames[tier]} Better luck next time!`);
            }

            // Refresh balances
            fetchEarnings();
            fetch('/api/wheel/treasury').then(r => r.json()).then((d: any) => setTreasuryBalance(d.balance || 0));

        } catch (e: any) {
            console.error('Spin error:', e);
            dismissToast(toastId);
            if (e.message?.includes('User rejected')) {
                addToast('error', 'Transaction cancelled');
            } else if (e.message?.includes('insufficient')) {
                addToast('error', 'Insufficient stardust balance');
            } else {
                addToast('error', `Spin failed: ${e.message}`);
            }
        } finally {
            setSpinning(false);
        }
    };

    // Use stardustTokenBalance (actual tokens in wallet) for wheel, not unclaimed (claimable from protocol)
    const available = earnings ? Number(BigInt(earnings.stardustTokenBalance || earnings.claimed || "0")) / 1e9 : 0;

    return (
        <>
            <div className="app-background" />
            <ToastContainer toasts={toasts} onDismiss={dismissToast} />
            <div className="app-container">
                <Header
                    connected={connected}
                    publicKey={publicKey}
                    onConnect={handleConnect}
                    onDisconnect={handleDisconnect}
                />
                <RulesBanner />

                {connected ? (
                    <>
                        <MyWalletSection
                            earnings={earnings}
                            claiming={claiming}
                            onClaim={handleClaim}
                        />
                        <GalaxyWheelSection
                            available={available}
                            spinning={spinning}
                            onSpin={handleSpin}
                            isAdmin={isAdmin}
                            treasuryBalance={treasuryBalance}
                            onFundTreasury={async (amount) => {
                                if (!phantomWallet || !publicKey) return;
                                addToast('pending', 'Funding treasury...');
                                try {
                                    const res = await fetch('/api/wheel/fund', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ wallet: publicKey, amount }),
                                    });
                                    if (!res.ok) {
                                        const err = await res.json();
                                        throw new Error(err.error || 'Fund failed');
                                    }
                                    addToast('success', `Funded ${amount} SOL to treasury!`);
                                    // Refresh treasury balance
                                    fetch('/api/wheel/treasury').then(r => r.json()).then(d => setTreasuryBalance(d.balance || 0));
                                } catch (e: any) {
                                    addToast('error', `Fund failed: ${e.message}`);
                                }
                            }}
                        />
                    </>
                ) : (
                    <div className="connect-prompt">
                        <h2>Connect Your Wallet</h2>
                        <p>Connect your Phantom wallet to view your {TOKEN_NAME} balance and earn stardust!</p>
                        <button className="btn btn-primary" onClick={handleConnect}>
                            👻 Connect Phantom
                        </button>
                    </div>
                )}

                <LeadersSection leaderboard={leaderboard} currentWallet={publicKey} />
                <HistorySection winners={winners} />
            </div>

            {/* Login Modal */}
            <div className={`modal-overlay ${showLogin ? 'open' : ''}`} onClick={() => setShowLogin(false)}>
                <div className="modal" onClick={e => e.stopPropagation()}>
                    <div className="modal-header">
                        <h2 className="modal-title">Connect Wallet</h2>
                        <button className="modal-close" onClick={() => setShowLogin(false)}>✕</button>
                    </div>
                    <div className="modal-body">
                        <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => { handleConnect(); setShowLogin(false); }}>
                            👻 Connect Phantom
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}

// Mount
import { createRoot } from "react-dom/client";
const container = document.getElementById("root");
if (container) {
    const root = createRoot(container);
    root.render(<App />);
}
