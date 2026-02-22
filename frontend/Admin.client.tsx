import React, { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";

const API_BASE = "http://localhost:3005";

// ============================================
// TYPES
// ============================================
interface SpinResult {
    success: boolean;
    spinNumber: number;
    wallet: string;
    walletShort: string;
    tier: number;
    tierName: string;
    rewardAmount: number;
    rewardFormatted: string;
    probabilities: string[];
    stardustTotal: string;
    txSignature: string;
    queuePosition: number;
    nextHolder: string;
}

interface QueueEntry {
    position: number;
    wallet: string;
    walletShort: string;
    lifetimeEarned: string;
    starBalance: string;
    isCurrent: boolean;
}

interface WheelConfig {
    tiers: { name: string; reward: number; rewardFormatted: string; baseProbability: string }[];
    poolBalance: number;
    poolBalanceFormatted: string;
    totalSpins: number;
    totalDistributed: number;
    totalDistributedFormatted: string;
    queueLength: number;
    currentIndex: number;
}

interface HistoryEntry {
    wallet: string;
    walletShort: string;
    rewardTier: number;
    rewardAmount: number;
    rewardFormatted: string;
    tierName: string;
    timeAgo: string;
    stardustTotal: string;
}

const TIER_COLORS = ["#94a3b8", "#3b82f6", "#a855f7", "#f97316", "#fbbf24"];
const TIER_EMOJIS = ["⬛", "☄️", "🌌", "✨", "💥"];

// ============================================
// ADMIN PAGE
// ============================================
function AdminPage() {
    const [config, setConfig] = useState<WheelConfig | null>(null);
    const [queue, setQueue] = useState<QueueEntry[]>([]);
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [lastSpin, setLastSpin] = useState<SpinResult | null>(null);
    const [spinning, setSpinning] = useState(false);
    const [autoSpin, setAutoSpin] = useState(false);
    const [autoSpinInterval, setAutoSpinInterval] = useState(3); // seconds between spins
    const [fundAmount, setFundAmount] = useState("1");
    const [status, setStatus] = useState("");

    // Fetch config
    const fetchConfig = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/wheel/config`);
            const data = await res.json();
            setConfig(data);
        } catch (e) { /* ignore */ }
    }, []);

    // Fetch queue
    const fetchQueue = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/admin/queue`);
            const data = await res.json();
            setQueue(data.queue);
        } catch (e) { /* ignore */ }
    }, []);

    // Fetch history
    const fetchHistory = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/wheel/history?limit=30`);
            const data = await res.json();
            setHistory(data.spins);
        } catch (e) { /* ignore */ }
    }, []);

    // Spin next
    const spinNext = useCallback(async () => {
        setSpinning(true);
        try {
            const res = await fetch(`${API_BASE}/api/admin/spin-next`, { method: "POST" });
            const data = await res.json();
            if (data.success) {
                setLastSpin(data);
                setStatus("");
                // Refresh data
                fetchConfig();
                fetchQueue();
                fetchHistory();
            } else {
                setStatus(`❌ ${data.error}`);
                setAutoSpin(false); // stop auto-spin on error
            }
        } catch (e: any) {
            setStatus(`❌ Error: ${e.message}`);
            setAutoSpin(false);
        }
        setSpinning(false);
    }, [fetchConfig, fetchQueue, fetchHistory]);

    // Fund pool
    const handleFundPool = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/admin/fund-pool`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ amount: parseFloat(fundAmount) }),
            });
            const data = await res.json();
            if (data.success) {
                setStatus(`✅ Added ${fundAmount} SOL to pool`);
                fetchConfig();
            } else {
                setStatus(`❌ ${data.error}`);
            }
        } catch (e: any) {
            setStatus(`❌ ${e.message}`);
        }
    };

    // Reset queue
    const handleResetQueue = async () => {
        const res = await fetch(`${API_BASE}/api/admin/reset-queue`, { method: "POST" });
        const data = await res.json();
        setStatus(`Queue reset — ${data.queueLength} holders`);
        fetchQueue();
        fetchConfig();
    };

    // Initial fetch
    useEffect(() => {
        fetchConfig();
        fetchQueue();
        fetchHistory();
        const interval = setInterval(() => {
            fetchConfig();
            fetchHistory();
        }, 5000);
        return () => clearInterval(interval);
    }, [fetchConfig, fetchQueue, fetchHistory]);

    // Auto-spin loop
    useEffect(() => {
        if (!autoSpin) return;
        const interval = setInterval(spinNext, autoSpinInterval * 1000);
        return () => clearInterval(interval);
    }, [autoSpin, autoSpinInterval, spinNext]);

    return (
        <div style={{ padding: 24, fontFamily: "system-ui, -apple-system", background: "#0a0e17", color: "#e2e8f0", minHeight: "100vh" }}>
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
                <h1 style={{ margin: 0, fontSize: 28, background: "linear-gradient(135deg, #fbbf24, #f59e0b)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                    🎰 Galaxy Wheel — Admin Control
                </h1>
                {config && (
                    <div style={{ textAlign: "right", fontSize: 13, color: "#94a3b8" }}>
                        <div>Pool: <span style={{ color: "#fbbf24", fontWeight: "bold" }}>{config.poolBalanceFormatted}</span></div>
                        <div>Spins: {config.totalSpins} · Distributed: {config.totalDistributedFormatted}</div>
                        <div>Queue: {config.queueLength} holders · Position: {config.currentIndex + 1}/{config.queueLength}</div>
                    </div>
                )}
            </div>

            {/* Main Grid */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

                {/* Left Column: Spin Controls */}
                <div>
                    {/* Spin Button */}
                    <div style={cardStyle}>
                        <h2 style={{ marginTop: 0, fontSize: 18 }}>🎡 Spin Controls</h2>
                        <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
                            <button
                                onClick={spinNext}
                                disabled={spinning}
                                style={{
                                    ...buttonStyle,
                                    opacity: spinning ? 0.6 : 1,
                                    flex: 1,
                                    fontSize: 16,
                                    padding: "12px 20px",
                                }}
                            >
                                {spinning ? "⏳ Spinning..." : "🎰 Spin Next Holder"}
                            </button>
                            <button
                                onClick={() => setAutoSpin(!autoSpin)}
                                style={{
                                    ...buttonStyle,
                                    background: autoSpin ? "linear-gradient(135deg, #ef4444, #dc2626)" : "linear-gradient(135deg, #22c55e, #16a34a)",
                                    flex: 1,
                                }}
                            >
                                {autoSpin ? "⏹ Stop Auto-Spin" : "▶️ Auto-Spin"}
                            </button>
                        </div>
                        {autoSpin && (
                            <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: "#94a3b8" }}>
                                <span>Interval:</span>
                                <input
                                    type="number"
                                    value={autoSpinInterval}
                                    onChange={e => setAutoSpinInterval(Math.max(1, parseInt(e.target.value) || 3))}
                                    style={{ ...inputStyle, width: 60 }}
                                    min={1}
                                />
                                <span>seconds</span>
                                <span style={{ marginLeft: "auto", color: "#22c55e", animation: "pulse 1s infinite" }}>● LIVE</span>
                            </div>
                        )}

                        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                            <button onClick={handleResetQueue} style={{ ...smallButton, background: "#374151" }}>🔄 Reset Queue</button>
                        </div>
                    </div>

                    {/* Last Spin Result */}
                    {lastSpin && (
                        <div style={{
                            ...cardStyle,
                            border: `2px solid ${TIER_COLORS[lastSpin.tier]}`,
                            boxShadow: `0 0 20px ${TIER_COLORS[lastSpin.tier]}40`,
                        }}>
                            <h2 style={{ marginTop: 0, fontSize: 18 }}>
                                {TIER_EMOJIS[lastSpin.tier]} Last Spin #{lastSpin.spinNumber}
                            </h2>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 14 }}>
                                <div>Holder: <span style={{ color: "#94a3b8", fontFamily: "monospace" }}>{lastSpin.walletShort}</span></div>
                                <div>Tier: <span style={{ color: TIER_COLORS[lastSpin.tier], fontWeight: "bold" }}>{lastSpin.tierName}</span></div>
                                <div>Reward: <span style={{ color: "#22c55e", fontWeight: "bold" }}>{lastSpin.rewardFormatted}</span></div>
                                <div>Stardust: {BigInt(lastSpin.stardustTotal) > 0n ? (Number(BigInt(lastSpin.stardustTotal)) / 1e9).toFixed(0) : "0"}</div>
                                <div>Probabilities: <span style={{ fontSize: 11, color: "#94a3b8" }}>{lastSpin.probabilities.join(", ")}</span></div>
                                <div>Next: <span style={{ fontFamily: "monospace" }}>{lastSpin.nextHolder}</span></div>
                            </div>
                            <div style={{ marginTop: 8, fontSize: 11, color: "#6b7280" }}>
                                TX: <a
                                    href={`https://solscan.io/tx/${lastSpin.txSignature}`}
                                    target="_blank"
                                    rel="noopener"
                                    style={{ color: "#60a5fa", textDecoration: "underline" }}
                                >{lastSpin.txSignature.slice(0, 20)}...</a>
                            </div>
                        </div>
                    )}

                    {/* Fund Pool */}
                    <div style={cardStyle}>
                        <h2 style={{ marginTop: 0, fontSize: 18 }}>💰 Fund Pool</h2>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                            <input
                                type="number"
                                value={fundAmount}
                                onChange={e => setFundAmount(e.target.value)}
                                style={inputStyle}
                                step="0.1"
                            />
                            <span style={{ color: "#94a3b8" }}>SOL</span>
                            <button onClick={handleFundPool} style={buttonStyle}>Add to Pool</button>
                        </div>
                    </div>

                    {/* Tier Config */}
                    {config && (
                        <div style={cardStyle}>
                            <h2 style={{ marginTop: 0, fontSize: 18 }}>🎯 Tier Configuration</h2>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                                <thead>
                                    <tr style={rowStyle}>
                                        <th style={{ textAlign: "left", padding: "6px 0" }}>Tier</th>
                                        <th>Base Prob</th>
                                        <th>Reward</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {config.tiers.map((tier, i) => (
                                        <tr key={i} style={rowStyle}>
                                            <td style={{ padding: "6px 0" }}>
                                                <span style={{ color: TIER_COLORS[i] }}>{TIER_EMOJIS[i]} {tier.name}</span>
                                            </td>
                                            <td style={{ textAlign: "center" }}>{tier.baseProbability}</td>
                                            <td style={{ textAlign: "center", color: "#22c55e" }}>{tier.rewardFormatted}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {/* Right Column: Queue & History */}
                <div>
                    {/* Holder Queue */}
                    <div style={cardStyle}>
                        <h2 style={{ marginTop: 0, fontSize: 18 }}>📋 Holder Queue ({queue.length} shown)</h2>
                        <div style={{ maxHeight: 300, overflowY: "auto" }}>
                            {queue.length === 0 ? (
                                <p style={{ color: "#6b7280", fontSize: 13 }}>No holders in queue. Register wallets first.</p>
                            ) : (
                                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                                    <thead>
                                        <tr style={rowStyle}>
                                            <th style={{ textAlign: "left", padding: "4px 0" }}>#</th>
                                            <th style={{ textAlign: "left" }}>Wallet</th>
                                            <th>Stardust</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {queue.map((entry, i) => (
                                            <tr key={i} style={{
                                                ...rowStyle,
                                                background: entry.isCurrent ? "#fbbf2420" : "transparent",
                                                fontWeight: entry.isCurrent ? "bold" : "normal",
                                            }}>
                                                <td style={{ padding: "4px 0" }}>
                                                    {entry.isCurrent ? "▶" : entry.position + 1}
                                                </td>
                                                <td style={{ fontFamily: "monospace" }}>{entry.walletShort}</td>
                                                <td style={{ textAlign: "center", fontSize: 11 }}>
                                                    {BigInt(entry.lifetimeEarned) > 0n ? (Number(BigInt(entry.lifetimeEarned)) / 1e9).toFixed(0) : "0"}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </div>

                    {/* Spin History */}
                    <div style={cardStyle}>
                        <h2 style={{ marginTop: 0, fontSize: 18 }}>📜 Recent Spins</h2>
                        <div style={{ maxHeight: 400, overflowY: "auto" }}>
                            {history.length === 0 ? (
                                <p style={{ color: "#6b7280", fontSize: 13 }}>No spins yet. Click "Spin Next" to start.</p>
                            ) : (
                                history.map((spin, i) => (
                                    <div key={i} style={{
                                        display: "flex",
                                        justifyContent: "space-between",
                                        alignItems: "center",
                                        padding: "6px 0",
                                        borderBottom: "1px solid #1e293b",
                                        fontSize: 13,
                                    }}>
                                        <span style={{ fontFamily: "monospace", color: "#94a3b8" }}>{spin.walletShort}</span>
                                        <span style={{ color: TIER_COLORS[spin.rewardTier], fontWeight: "bold" }}>
                                            {TIER_EMOJIS[spin.rewardTier]} {spin.tierName}
                                        </span>
                                        <span style={{ color: "#22c55e" }}>{spin.rewardFormatted}</span>
                                        <span style={{ color: "#6b7280", fontSize: 11 }}>{spin.timeAgo}</span>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Status Bar */}
            {status && (
                <div style={{ marginTop: 16, padding: 10, background: "#1a202c", borderRadius: 8, fontSize: 13 }}>
                    {status}
                </div>
            )}
        </div>
    );
}

// ============================================
// STYLES
// ============================================
const buttonStyle: React.CSSProperties = {
    background: "linear-gradient(135deg, #fbbf24, #f59e0b)",
    border: "none",
    padding: "10px 20px",
    borderRadius: 8,
    color: "#000",
    fontWeight: "bold",
    cursor: "pointer",
    fontSize: 14,
};

const smallButton: React.CSSProperties = {
    border: "1px solid #4b5563",
    padding: "6px 14px",
    borderRadius: 6,
    color: "#e2e8f0",
    cursor: "pointer",
    fontSize: 12,
};

const cardStyle: React.CSSProperties = {
    background: "#111827",
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
    border: "1px solid #1e293b",
};

const rowStyle: React.CSSProperties = {
    borderBottom: "1px solid #1e293b",
};

const inputStyle: React.CSSProperties = {
    background: "#0a0e17",
    border: "1px solid #374151",
    padding: "8px 12px",
    borderRadius: 6,
    color: "#fff",
    width: 100,
};

// ============================================
// MOUNT
// ============================================
const root = document.getElementById("root");
if (root) {
    createRoot(root).render(<AdminPage />);
}
