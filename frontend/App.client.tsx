import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { Wheel } from "react-custom-roulette";

// ============================================
// TYPES
// ============================================
interface QueueHolder {
    position: number;
    wallet: string;
    walletShort: string;
    isCurrent: boolean;
    stardustBalance: string;
    probabilities: number[];
}

interface SpinResult {
    wallet: string;
    walletShort?: string;
    rewardTier: number;
    rewardAmount: number;
    tierName: string;
    timestamp: number;
    txSignature?: string;
}

interface LiveData {
    queue: QueueHolder[];
    currentIndex: number;
    totalHolders: number;
    autoSpinEnabled: boolean;
    autoSpinInterval: number;
    nextSpinTime: number;
    secondsUntilNextSpin: number;
    recentSpins: SpinResult[];
    stats: {
        totalSpins: number;
        totalDistributed: number;
        totalDistributedFormatted: string;
        poolBalance: number;
        poolBalanceFormatted: string;
    };
    rpcStatus: { online: boolean };
    tierNames: string[];
    baseProbabilities: number[];
}

interface UserData {
    availableToWithdraw: number;
    availableFormatted: string;
    onChainTotalEarned: number;
    onChainTotalWithdrawn: number;
    recentSpins: SpinResult[];
}

// ============================================
// CONSTANTS
// ============================================
const TIER_NAMES = ["VOID", "COSMOS", "METEORS", "NEBULA", "SUPERNOVA"];
const TIER_COLORS = ["#555", "#22c55e", "#3b82f6", "#a855f7", "#f59e0b"];
const TIER_SEGMENTS = [50, 30, 15, 4, 1]; // number of segments per tier (= probability * 100)
const API = "";

// Build wheel data: 100 segments colored by tier
const buildWheelData = () => {
    const data: { option: string; style: { backgroundColor: string; textColor: string } }[] = [];
    const tierIndices: number[] = [];
    TIER_NAMES.forEach((name, tierIdx) => {
        for (let i = 0; i < TIER_SEGMENTS[tierIdx]; i++) {
            data.push({
                option: '',
                style: { backgroundColor: TIER_COLORS[tierIdx], textColor: 'white' },
            });
            tierIndices.push(tierIdx);
        }
    });
    return { data, tierIndices };
};
const { data: WHEEL_DATA, tierIndices: WHEEL_TIER_INDICES } = buildWheelData();
const TOTAL_SEGMENTS = WHEEL_DATA.length;

// ============================================
// LANDING PAGE
// ============================================
function LandingPage({ onNavigate }: { onNavigate: (path: string) => void }) {
    return (
        <div className="landing">
            <div className="landing-bg" />
            <div className="landing-content">
                <div className="landing-logo">✦</div>
                <h1 className="landing-title">Stardust Protocol</h1>
                <p className="landing-subtitle">
                    Provably fair treasury distributions for token communities
                </p>
                <p className="landing-desc">
                    Hold tokens. Accumulate stardust. Win bigger rewards.
                    <br />
                    Every holder gets their turn at the Galaxy Wheel.
                </p>

                <div className="communities">
                    <h2 className="communities-title">Communities</h2>
                    <button
                        className="community-card"
                        onClick={() => onNavigate("/galaxy")}
                    >
                        <div className="community-icon">🌌</div>
                        <div className="community-info">
                            <h3>Galaxy</h3>
                            <span className="community-token">$GXYSTAR</span>
                        </div>
                        <span className="community-arrow">→</span>
                    </button>
                </div>
            </div>
        </div>
    );
}

// ============================================
// PROBABILITY BAR (5-tier visual)
// ============================================
function ProbabilityBar({ probabilities, small }: { probabilities: number[]; small?: boolean }) {
    const total = probabilities.reduce((a, b) => a + b, 0) || 10000;
    return (
        <div className={`prob-bar ${small ? "prob-bar-sm" : ""}`}>
            {probabilities.map((p, i) => (
                <div
                    key={i}
                    className="prob-segment"
                    style={{
                        width: `${(p / total) * 100}%`,
                        backgroundColor: TIER_COLORS[i],
                    }}
                    title={`${TIER_NAMES[i]}: ${(p / 100).toFixed(1)}%`}
                />
            ))}
        </div>
    );
}

// ============================================
// TIMER DISPLAY
// ============================================
function Timer({ seconds }: { seconds: number }) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return (
        <span className="timer">
            {mins > 0 ? `${mins}m ` : ""}{secs}s
        </span>
    );
}

// ============================================
// QUEUE PANEL
// ============================================
function QueuePanel({
    queue,
    currentIndex,
    connectedWallet,
}: {
    queue: QueueHolder[];
    currentIndex: number;
    connectedWallet: string | null;
}) {
    const userPosition = connectedWallet
        ? queue.findIndex((h) => h.wallet === connectedWallet)
        : -1;

    return (
        <div className="panel queue-panel">
            <h2 className="panel-title">
                Holder Queue <span className="badge">{queue.length}</span>
            </h2>

            {userPosition >= 0 && (
                <div className="your-position">
                    Your position: <strong>#{userPosition + 1}</strong>
                    {userPosition > currentIndex && (
                        <span className="spins-until">
                            {" "}
                            ({userPosition - currentIndex} spins until your turn)
                        </span>
                    )}
                    {userPosition === currentIndex && (
                        <span className="spinning-now"> 🎰 YOUR TURN</span>
                    )}
                </div>
            )}

            <div className="queue-list">
                {queue.map((holder) => {
                    const stardustNum = Number(holder.stardustBalance) / 1e9;
                    const isUser = holder.wallet === connectedWallet;
                    return (
                        <div
                            key={holder.wallet}
                            className={`queue-item ${holder.isCurrent ? "current" : ""} ${isUser ? "is-user" : ""}`}
                        >
                            <div className="queue-item-header">
                                <span className="queue-pos">#{holder.position + 1}</span>
                                <span className="queue-wallet">{holder.walletShort}</span>
                                <span className="queue-stardust">
                                    {stardustNum > 0 ? stardustNum.toFixed(2) : "0"} ✦
                                </span>
                                {holder.isCurrent && <span className="badge badge-spin">SPINNING</span>}
                            </div>
                            <ProbabilityBar probabilities={holder.probabilities} small />
                        </div>
                    );
                })}
                {queue.length === 0 && (
                    <div className="empty-state">No holders in queue</div>
                )}
            </div>
        </div>
    );
}

// ============================================
// RESULTS PANEL
// ============================================
function ResultsPanel({ spins }: { spins: SpinResult[] }) {
    return (
        <div className="panel results-panel">
            <h2 className="panel-title">Recent Results</h2>
            <div className="results-list">
                {spins.map((spin, i) => {
                    const walletShort =
                        spin.walletShort || spin.wallet.slice(0, 4) + "..." + spin.wallet.slice(-4);
                    const reward = (spin.rewardAmount / 1e9).toFixed(4);
                    const timeAgo = getTimeAgo(spin.timestamp);
                    return (
                        <div key={`${spin.timestamp}-${i}`} className="result-item">
                            <div className="result-header">
                                <span className="result-wallet">{walletShort}</span>
                                <span className="result-time">{timeAgo}</span>
                            </div>
                            <div className="result-body">
                                <span
                                    className="result-tier"
                                    style={{ color: TIER_COLORS[spin.rewardTier] || "#fff" }}
                                >
                                    ✦ {spin.tierName}
                                </span>
                                <span className="result-reward">{reward} SOL</span>
                            </div>
                            {spin.txSignature && (
                                <a
                                    href={`https://solscan.io/tx/${spin.txSignature}`}
                                    target="_blank"
                                    className="result-tx"
                                >
                                    tx: {spin.txSignature.slice(0, 12)}...
                                </a>
                            )}
                        </div>
                    );
                })}
                {spins.length === 0 && (
                    <div className="empty-state">No spins yet</div>
                )}
            </div>
        </div>
    );
}

// ============================================
// WALLET PANEL (connected user actions)
// ============================================
function WalletPanel({
    wallet,
    userData,
    earnings,
    onClaimStardust,
    onWithdrawSOL,
    claimLoading,
    withdrawLoading,
}: {
    wallet: string;
    userData: UserData | null;
    earnings: { lifetimeEarned: string; stardustBalance: string } | null;
    onClaimStardust: () => void;
    onWithdrawSOL: () => void;
    claimLoading: boolean;
    withdrawLoading: boolean;
}) {
    const available = userData ? (userData.availableToWithdraw / 1e9).toFixed(4) : "0.0000";
    const stardustBal = earnings
        ? (Number(earnings.stardustBalance) / 1e9).toFixed(2)
        : "0.00";
    const lifetimeEarned = earnings
        ? (Number(earnings.lifetimeEarned) / 1e9).toFixed(2)
        : "0.00";

    return (
        <div className="panel wallet-panel">
            <h2 className="panel-title">Your Wallet</h2>
            <div className="wallet-address">
                {wallet.slice(0, 4)}...{wallet.slice(-4)}
            </div>

            <div className="wallet-stats">
                <div className="wallet-stat">
                    <label>Stardust Balance</label>
                    <div className="wallet-value stardust-val">{stardustBal} ✦</div>
                </div>
                <div className="wallet-stat">
                    <label>Lifetime Earned</label>
                    <div className="wallet-value">{lifetimeEarned} ✦</div>
                </div>
                <div className="wallet-stat">
                    <label>Available to Withdraw</label>
                    <div className="wallet-value sol-val">{available} SOL</div>
                </div>
            </div>

            <div className="wallet-actions">
                <button
                    className="btn btn-claim"
                    onClick={onClaimStardust}
                    disabled={claimLoading}
                >
                    {claimLoading ? "Signing..." : "Claim Stardust ✦"}
                </button>
                <button
                    className="btn btn-withdraw"
                    onClick={onWithdrawSOL}
                    disabled={withdrawLoading || (userData?.availableToWithdraw ?? 0) <= 0}
                >
                    {withdrawLoading ? "Signing..." : "Withdraw SOL"}
                </button>
            </div>
        </div>
    );
}

// ============================================
// COMMUNITY PAGE — /galaxy
// ============================================
function CommunityPage() {
    const [liveData, setLiveData] = useState<LiveData | null>(null);
    const [countdown, setCountdown] = useState(60);
    const [connected, setConnected] = useState<string | null>(null);
    const [userData, setUserData] = useState<UserData | null>(null);
    const [userEarnings, setUserEarnings] = useState<{ lifetimeEarned: string; stardustBalance: string } | null>(null);
    const [claimLoading, setClaimLoading] = useState(false);
    const [withdrawLoading, setWithdrawLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [spinningHolder, setSpinningHolder] = useState<string | null>(null);
    const [mustSpin, setMustSpin] = useState(false);
    const [prizeNumber, setPrizeNumber] = useState(0);
    const [spinResult, setSpinResult] = useState<{ tierName: string; rewardAmount: number; tierIndex: number } | null>(null);
    const [highlightedTier, setHighlightedTier] = useState<number | null>(null);
    const spinResultRef = useRef<{ tier: number } | null>(null);
    const sseRef = useRef<EventSource | null>(null);

    // Fetch initial live data
    useEffect(() => {
        const fetchLive = async () => {
            try {
                const res = await fetch(`${API}/api/wheel/live`);
                const data = await res.json();
                setLiveData(data);
                setCountdown(data.secondsUntilNextSpin || 60);
            } catch (e) {
                console.error("Failed to fetch live data", e);
            }
        };
        fetchLive();
        const interval = setInterval(fetchLive, 30000); // refresh every 30s
        return () => clearInterval(interval);
    }, []);

    // SSE for real-time updates
    useEffect(() => {
        const sse = new EventSource(`${API}/api/wheel/events`);
        sseRef.current = sse;

        sse.addEventListener("timer", (e) => {
            const data = JSON.parse(e.data);
            setCountdown(data.secondsUntil);
        });

        sse.addEventListener("spinning", (e) => {
            const data = JSON.parse(e.data);
            setSpinningHolder(data.wallet);
            setSpinResult(null);
        });

        sse.addEventListener("spin", (e) => {
            const data = JSON.parse(e.data);
            // Start wheel animation pointing at winning tier
            const tier = data.tier ?? 0;
            spinResultRef.current = { tier };
            // Find a segment index for this tier
            const segments: number[] = [];
            WHEEL_TIER_INDICES.forEach((t, idx) => { if (t === tier) segments.push(idx); });
            const targetSegment = segments[Math.floor(Math.random() * segments.length)] ?? 0;
            setPrizeNumber(targetSegment);
            setMustSpin(true);

            // Update liveData with new spin result
            setLiveData((prev) => {
                if (!prev) return prev;
                const newSpin: SpinResult = {
                    wallet: data.wallet,
                    walletShort: data.walletShort,
                    rewardTier: data.tier,
                    rewardAmount: data.rewardAmount,
                    tierName: data.tierName,
                    timestamp: data.timestamp,
                    txSignature: data.txSignature,
                };
                return {
                    ...prev,
                    recentSpins: [newSpin, ...prev.recentSpins.slice(0, 19)],
                    stats: {
                        ...prev.stats,
                        totalSpins: prev.stats.totalSpins + 1,
                        totalDistributed: prev.stats.totalDistributed + data.rewardAmount,
                        totalDistributedFormatted:
                            ((prev.stats.totalDistributed + data.rewardAmount) / 1e9).toFixed(4) + " SOL",
                    },
                    currentIndex: data.nextIndex ?? prev.currentIndex + 1,
                };
            });
        });

        return () => sse.close();
    }, []);

    // Fetch user data when connected
    useEffect(() => {
        if (!connected) {
            setUserData(null);
            setUserEarnings(null);
            return;
        }

        const fetchUser = async () => {
            try {
                const res = await fetch(`${API}/api/wheel/user/${connected}`);
                const data = await res.json();
                setUserData(data);
            } catch (e) {
                console.error("Failed to fetch user data", e);
            }

            // Get earnings info from queue
            if (liveData) {
                const holder = liveData.queue.find((h) => h.wallet === connected);
                if (holder) {
                    setUserEarnings({
                        lifetimeEarned: "0", // TODO: backend needs to expose this
                        stardustBalance: holder.stardustBalance,
                    });
                }
            }
        };
        fetchUser();
    }, [connected, liveData?.stats.totalSpins]);

    // Connect wallet via Phantom
    const connectWallet = useCallback(async () => {
        try {
            const phantom = (window as any).solana;
            if (!phantom?.isPhantom) {
                setError("Phantom wallet not found");
                return;
            }
            const resp = await phantom.connect();
            setConnected(resp.publicKey.toString());
            setError(null);
        } catch (e: any) {
            setError(e.message || "Failed to connect");
        }
    }, []);

    // Claim stardust
    const handleClaimStardust = useCallback(async () => {
        if (!connected) return;
        setClaimLoading(true);
        setError(null);
        try {
            const res = await fetch(`${API}/api/claim-stardust-tx`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ wallet: connected }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            const { Transaction } = await import("@solana/web3.js");
            const tx = Transaction.from(Buffer.from(data.transaction, "base64"));
            const phantom = (window as any).solana;
            const signed = await phantom.signTransaction(tx);

            const { Connection } = await import("@solana/web3.js");
            const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
            const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
            await conn.confirmTransaction(sig, "confirmed");

            setError(null);
            alert(`Stardust claimed! Tx: ${sig.slice(0, 12)}...`);
        } catch (e: any) {
            setError(e.message || "Claim failed");
        } finally {
            setClaimLoading(false);
        }
    }, [connected]);

    // Withdraw SOL
    const handleWithdrawSOL = useCallback(async () => {
        if (!connected) return;
        setWithdrawLoading(true);
        setError(null);
        try {
            const res = await fetch(`${API}/api/wheel/withdraw-tx`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ wallet: connected }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            const { Transaction } = await import("@solana/web3.js");
            const tx = Transaction.from(Buffer.from(data.transaction, "base64"));
            const phantom = (window as any).solana;
            const signed = await phantom.signTransaction(tx);

            const { Connection } = await import("@solana/web3.js");
            const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
            const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
            await conn.confirmTransaction(sig, "confirmed");

            setError(null);
            alert(`SOL withdrawn! Tx: ${sig.slice(0, 12)}...`);
        } catch (e: any) {
            setError(e.message || "Withdraw failed");
        } finally {
            setWithdrawLoading(false);
        }
    }, [connected]);

    if (!liveData) {
        return <div className="loading">Loading Galaxy Wheel...</div>;
    }

    return (
        <div className="community-page">
            {/* Header */}
            <header className="header">
                <div className="header-left">
                    <a href="/" className="header-logo">✦</a>
                    <h1 className="header-title">Galaxy</h1>
                    <span className="header-token">$GXYSTAR</span>
                    {liveData.rpcStatus.online && <span className="badge badge-live">● LIVE</span>}
                </div>
                <div className="header-stats">
                    <div className="stat">
                        <label>Spins</label>
                        <span>{liveData.stats.totalSpins}</span>
                    </div>
                    <div className="stat">
                        <label>Distributed</label>
                        <span>{liveData.stats.totalDistributedFormatted}</span>
                    </div>
                    <div className="stat">
                        <label>Treasury</label>
                        <span className="treasury">{liveData.stats.poolBalanceFormatted}</span>
                    </div>
                </div>
                <div className="header-right">
                    {connected ? (
                        <button className="btn btn-connected" onClick={() => setConnected(null)}>
                            {connected.slice(0, 4)}...{connected.slice(-4)}
                        </button>
                    ) : (
                        <button className="btn btn-connect" onClick={connectWallet}>
                            Connect Wallet
                        </button>
                    )}
                </div>
            </header>

            {error && <div className="error-bar">{error}</div>}

            {/* Timer Bar */}
            <div className="timer-bar">
                <div className="timer-info">
                    <span>Next spin in <Timer seconds={countdown} /></span>
                    {liveData.queue[liveData.currentIndex] && (
                        <span className="timer-holder">
                            for {liveData.queue[liveData.currentIndex]?.walletShort}
                        </span>
                    )}
                </div>
                <div className="timer-progress">
                    <div
                        className="timer-fill"
                        style={{ width: `${(1 - countdown / (liveData.autoSpinInterval / 1000)) * 100}%` }}
                    />
                </div>
            </div>

            {/* Main Content */}
            <div className="main-grid">
                {/* Left: Queue */}
                <QueuePanel
                    queue={liveData.queue}
                    currentIndex={liveData.currentIndex}
                    connectedWallet={connected}
                />

                {/* Center: Wheel + Wallet Actions */}
                <div className="center-col">
                    <div className="wheel-area">
                        <div className="wheel-container">
                            <Wheel
                                mustStartSpinning={mustSpin}
                                prizeNumber={prizeNumber}
                                data={WHEEL_DATA}
                                onStopSpinning={() => {
                                    setMustSpin(false);
                                    setSpinningHolder(null);
                                    const tier = spinResultRef.current?.tier ?? 0;
                                    const latestSpin = liveData?.recentSpins[0];
                                    setSpinResult({
                                        tierName: TIER_NAMES[tier] || 'VOID',
                                        rewardAmount: latestSpin?.rewardAmount || 0,
                                        tierIndex: tier,
                                    });
                                    setHighlightedTier(null);
                                    // Clear result after 5 seconds
                                    setTimeout(() => setSpinResult(null), 5000);
                                }}
                                backgroundColors={TIER_COLORS}
                                textColors={['white']}
                                outerBorderColor="#1e293b"
                                outerBorderWidth={6}
                                innerBorderColor="#f59e0b"
                                innerBorderWidth={3}
                                innerRadius={18}
                                radiusLineColor="#0f172a"
                                radiusLineWidth={1}
                                spinDuration={0.6}
                                startingOptionIndex={0}
                                pointerProps={{ src: undefined, style: { display: 'none' } }}
                            />
                            <div className="wheel-pointer-arrow">▼</div>
                            <div className="wheel-center-label">
                                <span className="wheel-label">GALAXY</span>
                                <span className="wheel-label-sub">WHEEL</span>
                            </div>
                        </div>

                        {/* Spinning for / Result */}
                        {spinningHolder && !spinResult && (
                            <div className="spin-status spinning">
                                🎰 Spinning for {spinningHolder.slice(0, 4)}...{spinningHolder.slice(-4)}
                            </div>
                        )}
                        {spinResult && (
                            <div className="spin-status result" style={{ borderColor: TIER_COLORS[spinResult.tierIndex] }}>
                                <span style={{ color: TIER_COLORS[spinResult.tierIndex] }}>✦ {spinResult.tierName}</span>
                                <span className="result-sol">{(spinResult.rewardAmount / 1e9).toFixed(4)} SOL</span>
                            </div>
                        )}

                        {/* Tier Legend with highlighting */}
                        <div className="tier-legend">
                            {TIER_NAMES.slice().reverse().map((name, ri) => {
                                const i = TIER_NAMES.length - 1 - ri;
                                const basePct = liveData ? (liveData.baseProbabilities[i] / 100).toFixed(1) : '0';
                                const rewardPct = ["1%", "4%", "15%", "40%", "100%"];
                                const isHighlighted = highlightedTier === i;
                                const isWinner = spinResult?.tierIndex === i;
                                return (
                                    <div
                                        key={name}
                                        className={`tier-item ${isHighlighted ? 'tier-highlighted' : ''} ${isWinner ? 'tier-winner' : ''}`}
                                        style={isHighlighted ? { background: `${TIER_COLORS[i]}30` } : undefined}
                                    >
                                        <span className="tier-dot" style={{ backgroundColor: TIER_COLORS[i] }} />
                                        <span className="tier-name">{name}</span>
                                        <span className="tier-pct">{basePct}%</span>
                                        <span className="tier-reward">{rewardPct[i]}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Wallet Panel (only when connected) */}
                    {connected && (
                        <WalletPanel
                            wallet={connected}
                            userData={userData}
                            earnings={userEarnings}
                            onClaimStardust={handleClaimStardust}
                            onWithdrawSOL={handleWithdrawSOL}
                            claimLoading={claimLoading}
                            withdrawLoading={withdrawLoading}
                        />
                    )}
                </div>

                {/* Right: Results */}
                <ResultsPanel spins={liveData.recentSpins} />
            </div>
        </div>
    );
}

// ============================================
// APP ROUTER
// ============================================
function App() {
    const [path, setPath] = useState(window.location.pathname);

    useEffect(() => {
        const onPop = () => setPath(window.location.pathname);
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
    }, []);

    const navigate = (newPath: string) => {
        window.history.pushState({}, "", newPath);
        setPath(newPath);
    };

    if (path === "/galaxy") {
        return <CommunityPage />;
    }
    return <LandingPage onNavigate={navigate} />;
}

// ============================================
// HELPERS
// ============================================
function getTimeAgo(timestamp: number): string {
    const diff = Date.now() - timestamp;
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
}

// ============================================
// MOUNT
// ============================================
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
