import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Keypair, PublicKey } from "@solana/web3.js";

// ==================== TYPES ====================
interface EarningsData {
    wallet: string;
    lifetimeEarned: string;
    claimed: string;
    unclaimed: string;
    starBalance: string;
    lastUpdated: number | null;
}

interface LeaderboardEntry {
    rank: number;
    wallet: string;
    lifetimeEarned: string;
    claimed: string;
    unclaimed: string;
    starBalance: string;
}

interface Stats {
    totalHolders: number;
    totalEarned: string;
    totalClaimed: string;
    totalUnclaimed: string;
    totalStarBalance: string;
}

interface TestUser {
    id: number;
    publicKey: string;
    secretKey: string;
    starTokenAccount: string;
    stardustTokenAccount: string;
    starBalance: number;
}

interface Config {
    programId: string;
    statePda: string;
    stardustMint: string;
    starTokenMint: string;
    authority: string;
}

interface TreasuryData {
    totalValue: number;
    history: { timestamp: number; value: number }[];
    tokens: { symbol: string; amount: number; value: number }[];
}

interface ChartDataPoint {
    timestamp: number;
    value: number;
    label?: string;
}

// ==================== UTILITIES ====================
const formatStardust = (amount: string) => {
    const n = BigInt(amount || "0");
    const whole = n / BigInt(1e9);
    return whole.toLocaleString();
};

const formatShort = (wallet: string) =>
    wallet ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : "";

const formatTime = (ts: number) => new Date(ts).toLocaleTimeString();

// ==================== CHART COMPONENT ====================
function LineChart({
    data,
    width = 400,
    height = 200,
    color = "#00d4ff",
    gradientColor = "rgba(0, 212, 255, 0.15)",
    title,
    formatValue = (v: number) => v.toLocaleString(),
    showGrid = true,
}: {
    data: ChartDataPoint[];
    width?: number;
    height?: number;
    color?: string;
    gradientColor?: string;
    title?: string;
    formatValue?: (v: number) => string;
    showGrid?: boolean;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [hoveredPoint, setHoveredPoint] = useState<ChartDataPoint | null>(null);
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || data.length < 2) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.scale(dpr, dpr);

        const padding = { top: 30, right: 20, bottom: 30, left: 60 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;

        // Clear
        ctx.clearRect(0, 0, width, height);

        // Get data range
        const values = data.map((d) => d.value);
        const minVal = Math.min(...values) * 0.95;
        const maxVal = Math.max(...values) * 1.05;
        const range = maxVal - minVal || 1;

        // Scale functions
        const scaleX = (i: number) => padding.left + (i / (data.length - 1)) * chartWidth;
        const scaleY = (v: number) =>
            padding.top + chartHeight - ((v - minVal) / range) * chartHeight;

        // Draw grid
        if (showGrid) {
            ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
            ctx.lineWidth = 1;
            for (let i = 0; i <= 4; i++) {
                const y = padding.top + (i / 4) * chartHeight;
                ctx.beginPath();
                ctx.moveTo(padding.left, y);
                ctx.lineTo(width - padding.right, y);
                ctx.stroke();
            }
        }

        // Draw gradient fill
        const gradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
        gradient.addColorStop(0, gradientColor);
        gradient.addColorStop(1, "transparent");

        ctx.beginPath();
        ctx.moveTo(scaleX(0), scaleY(data[0].value));
        for (let i = 1; i < data.length; i++) {
            ctx.lineTo(scaleX(i), scaleY(data[i].value));
        }
        ctx.lineTo(scaleX(data.length - 1), height - padding.bottom);
        ctx.lineTo(scaleX(0), height - padding.bottom);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        // Draw line
        ctx.beginPath();
        ctx.moveTo(scaleX(0), scaleY(data[0].value));
        for (let i = 1; i < data.length; i++) {
            ctx.lineTo(scaleX(i), scaleY(data[i].value));
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();

        // Draw glow
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Draw points
        data.forEach((point, i) => {
            ctx.beginPath();
            ctx.arc(scaleX(i), scaleY(point.value), 3, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
        });

        // Y-axis labels
        ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
        ctx.font = "10px Inter, sans-serif";
        ctx.textAlign = "right";
        for (let i = 0; i <= 4; i++) {
            const val = minVal + ((4 - i) / 4) * range;
            const y = padding.top + (i / 4) * chartHeight;
            ctx.fillText(formatValue(val), padding.left - 8, y + 4);
        }

        // Title
        if (title) {
            ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
            ctx.font = "12px Inter, sans-serif";
            ctx.textAlign = "left";
            ctx.fillText(title, padding.left, 16);
        }
    }, [data, width, height, color, gradientColor, title, formatValue, showGrid]);

    const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas || data.length < 2) return;

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const padding = { left: 60, right: 20 };
        const chartWidth = width - padding.left - padding.right;

        const index = Math.round(((x - padding.left) / chartWidth) * (data.length - 1));
        if (index >= 0 && index < data.length) {
            setHoveredPoint(data[index]);
            setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        }
    };

    return (
        <div className="chart-container" style={{ position: "relative", width, height }}>
            <canvas
                ref={canvasRef}
                style={{ width, height }}
                onMouseMove={handleMouseMove}
                onMouseLeave={() => setHoveredPoint(null)}
            />
            {hoveredPoint && (
                <div
                    className="chart-tooltip"
                    style={{
                        position: "absolute",
                        left: Math.min(mousePos.x + 10, width - 120),
                        top: Math.max(mousePos.y - 40, 0),
                    }}
                >
                    <div>{formatValue(hoveredPoint.value)}</div>
                    <div className="tooltip-time">{formatTime(hoveredPoint.timestamp)}</div>
                </div>
            )}
        </div>
    );
}

// ==================== DONUT CHART ====================
function DonutChart({
    data,
    size = 150,
    colors = ["#00d4ff", "#a855f7", "#f59e0b", "#10b981"],
}: {
    data: { label: string; value: number }[];
    size?: number;
    colors?: string[];
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const total = data.reduce((sum, d) => sum + d.value, 0);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || total === 0) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = size * dpr;
        canvas.height = size * dpr;
        ctx.scale(dpr, dpr);

        const centerX = size / 2;
        const centerY = size / 2;
        const outerRadius = size / 2 - 10;
        const innerRadius = outerRadius * 0.6;

        let startAngle = -Math.PI / 2;

        data.forEach((item, i) => {
            const sliceAngle = (item.value / total) * 2 * Math.PI;

            ctx.beginPath();
            ctx.arc(centerX, centerY, outerRadius, startAngle, startAngle + sliceAngle);
            ctx.arc(centerX, centerY, innerRadius, startAngle + sliceAngle, startAngle, true);
            ctx.closePath();

            ctx.fillStyle = colors[i % colors.length];
            ctx.fill();

            // Glow effect
            ctx.shadowColor = colors[i % colors.length];
            ctx.shadowBlur = 8;
            ctx.fill();
            ctx.shadowBlur = 0;

            startAngle += sliceAngle;
        });

        // Center text
        ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
        ctx.font = "bold 18px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(total.toLocaleString(), centerX, centerY - 8);
        ctx.font = "10px Inter, sans-serif";
        ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
        ctx.fillText("TOTAL", centerX, centerY + 12);
    }, [data, size, colors, total]);

    return (
        <div className="donut-chart">
            <canvas ref={canvasRef} style={{ width: size, height: size }} />
            <div className="donut-legend">
                {data.map((item, i) => (
                    <div key={item.label} className="legend-item">
                        <span
                            className="legend-dot"
                            style={{ background: colors[i % colors.length] }}
                        />
                        <span className="legend-label">{item.label}</span>
                        <span className="legend-value">{item.value.toLocaleString()}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ==================== BAR CHART ====================
function BarChart({
    data,
    width = 300,
    height = 150,
    color = "#a855f7",
}: {
    data: { label: string; value: number }[];
    width?: number;
    height?: number;
    color?: string;
}) {
    const maxValue = Math.max(...data.map((d) => d.value), 1);

    return (
        <div className="bar-chart" style={{ width, height }}>
            {data.map((item, i) => (
                <div key={item.label} className="bar-row">
                    <span className="bar-label">{item.label}</span>
                    <div className="bar-container">
                        <div
                            className="bar-fill"
                            style={{
                                width: `${(item.value / maxValue) * 100}%`,
                                background: `linear-gradient(90deg, ${color}44, ${color})`,
                                boxShadow: `0 0 10px ${color}55`,
                            }}
                        />
                    </div>
                    <span className="bar-value">{item.value.toLocaleString()}</span>
                </div>
            ))}
        </div>
    );
}

// ==================== STATS CARD ====================
function StatsCard({
    label,
    value,
    icon,
    trend,
    subValue,
}: {
    label: string;
    value: string;
    icon: string;
    trend?: "up" | "down" | "neutral";
    subValue?: string;
}) {
    return (
        <div className="stat-card">
            <span className="stat-icon">{icon}</span>
            <div className="stat-content">
                <span className="stat-value">
                    {value}
                    {trend && (
                        <span className={`trend ${trend}`}>
                            {trend === "up" ? "↑" : trend === "down" ? "↓" : "→"}
                        </span>
                    )}
                </span>
                <span className="stat-label">{label}</span>
                {subValue && <span className="stat-sub">{subValue}</span>}
            </div>
        </div>
    );
}

// ==================== LEADERBOARD ====================
function Leaderboard({
    entries,
    currentWallet,
}: {
    entries: LeaderboardEntry[];
    currentWallet: string | null;
}) {
    return (
        <div className="leaderboard">
            <div className="leaderboard-header">
                <span>Rank</span>
                <span>Wallet</span>
                <span>STAR</span>
                <span>Earned ✨</span>
            </div>
            {entries.map((e) => (
                <div
                    key={e.wallet}
                    className={`leaderboard-row ${e.wallet === currentWallet ? "highlight" : ""}`}
                >
                    <span className="rank">
                        {e.rank === 1 ? "🥇" : e.rank === 2 ? "🥈" : e.rank === 3 ? "🥉" : `#${e.rank}`}
                    </span>
                    <span className="wallet">{formatShort(e.wallet)}</span>
                    <span className="star-balance">{(Number(e.starBalance) / 1e9).toFixed(0)} ⭐</span>
                    <span className="earned">{formatStardust(e.lifetimeEarned)}</span>
                </div>
            ))}
        </div>
    );
}

// ==================== USER DASHBOARD ====================
function UserDashboard({
    earnings,
    earningsHistory,
    onClaim,
    claiming,
}: {
    earnings: EarningsData | null;
    earningsHistory: ChartDataPoint[];
    onClaim: () => void;
    claiming: boolean;
}) {
    if (!earnings) return null;

    const starBalance = Number(earnings.starBalance) / 1e9;
    const lifetimeEarned = Number(BigInt(earnings.lifetimeEarned || "0") / BigInt(1e9));
    const claimed = Number(BigInt(earnings.claimed || "0") / BigInt(1e9));
    const unclaimed = Number(BigInt(earnings.unclaimed || "0") / BigInt(1e9));

    const earningsRate = starBalance * 0.001; // Example rate per second

    return (
        <div className="user-dashboard">
            <div className="dashboard-header">
                <h2>Your Dashboard</h2>
                <span className="wallet-badge">{formatShort(earnings.wallet)}</span>
            </div>

            <div className="dashboard-stats">
                <div className="big-stat">
                    <span className="big-stat-icon">⭐</span>
                    <div className="big-stat-content">
                        <span className="big-stat-value">{starBalance.toFixed(0)}</span>
                        <span className="big-stat-label">STAR Balance</span>
                    </div>
                </div>
                <div className="big-stat accent">
                    <span className="big-stat-icon">✨</span>
                    <div className="big-stat-content">
                        <span className="big-stat-value">{unclaimed.toLocaleString()}</span>
                        <span className="big-stat-label">Available to Claim</span>
                    </div>
                </div>
            </div>

            <button
                onClick={onClaim}
                disabled={claiming || unclaimed === 0}
                className="btn btn-claim"
            >
                {claiming ? (
                    <span className="claim-loading">Processing...</span>
                ) : (
                    <>
                        <span className="claim-icon">💎</span>
                        <span>Claim {unclaimed.toLocaleString()} STARDUST</span>
                    </>
                )}
            </button>

            <div className="dashboard-charts">
                <div className="chart-card">
                    <h4>Earnings Over Time</h4>
                    <LineChart
                        data={earningsHistory}
                        width={380}
                        height={160}
                        color="#00d4ff"
                        formatValue={(v) => `${v.toLocaleString()} ✨`}
                    />
                </div>

                <div className="stats-breakdown">
                    <h4>Breakdown</h4>
                    <DonutChart
                        data={[
                            { label: "Claimed", value: claimed },
                            { label: "Unclaimed", value: unclaimed },
                        ]}
                        size={140}
                        colors={["#10b981", "#a855f7"]}
                    />
                </div>
            </div>

            <div className="earnings-details">
                <div className="detail-row">
                    <span>Lifetime Earned</span>
                    <span>{lifetimeEarned.toLocaleString()} ✨</span>
                </div>
                <div className="detail-row">
                    <span>Already Claimed</span>
                    <span>{claimed.toLocaleString()} ✨</span>
                </div>
                <div className="detail-row highlight">
                    <span>Earning Rate</span>
                    <span>~{earningsRate.toFixed(2)} ✨/sec</span>
                </div>
            </div>
        </div>
    );
}

// ==================== TREASURY PANEL ====================
function TreasuryPanel({ treasury }: { treasury: TreasuryData }) {
    return (
        <div className="treasury-panel">
            <div className="treasury-header">
                <h2>🏦 Protocol Treasury</h2>
                <div className="treasury-value">
                    <span className="value-label">Total Value</span>
                    <span className="value-amount">${treasury.totalValue.toLocaleString()}</span>
                </div>
            </div>

            <div className="treasury-chart">
                <h4>Treasury Value Over Time</h4>
                <LineChart
                    data={treasury.history}
                    width={380}
                    height={180}
                    color="#f59e0b"
                    gradientColor="rgba(245, 158, 11, 0.15)"
                    formatValue={(v) => `$${v.toLocaleString()}`}
                />
            </div>

            <div className="treasury-assets">
                <h4>Treasury Assets</h4>
                <BarChart
                    data={treasury.tokens.map((t) => ({
                        label: t.symbol,
                        value: t.value,
                    }))}
                    color="#f59e0b"
                />
            </div>

            <div className="exchange-cta">
                <p>Exchange 1,000,000 ✨ STARDUST for a random portion of treasury!</p>
                <button className="btn btn-exchange" disabled>
                    🎲 Exchange (Coming Soon)
                </button>
            </div>
        </div>
    );
}

// ==================== USER SELECTOR ====================
function UserSelector({
    testUsers,
    selectedUser,
    onSelect,
}: {
    testUsers: TestUser[];
    selectedUser: TestUser | null;
    onSelect: (user: TestUser) => void;
}) {
    return (
        <div className="user-selector">
            <h3>Select Test User</h3>
            <div className="user-grid">
                {testUsers.map((user) => (
                    <button
                        key={user.id}
                        onClick={() => onSelect(user)}
                        className={`user-card ${selectedUser?.id === user.id ? "active" : ""}`}
                    >
                        <div className="user-avatar">👤</div>
                        <span className="user-id">User {user.id}</span>
                        <span className="user-key">{formatShort(user.publicKey)}</span>
                        <span className="user-balance">{user.starBalance} STAR ⭐</span>
                    </button>
                ))}
            </div>
        </div>
    );
}

// ==================== MAIN APP ====================
function App() {
    const [testUsers, setTestUsers] = useState<TestUser[]>([]);
    const [config, setConfig] = useState<Config | null>(null);
    const [selectedUser, setSelectedUser] = useState<TestUser | null>(null);
    const [userKeypair, setUserKeypair] = useState<Keypair | null>(null);
    const [publicKey, setPublicKey] = useState<string | null>(null);
    const [earnings, setEarnings] = useState<EarningsData | null>(null);
    const [earningsHistory, setEarningsHistory] = useState<ChartDataPoint[]>([]);
    const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
    const [stats, setStats] = useState<Stats | null>(null);
    const [claiming, setClaiming] = useState(false);
    const [connected, setConnected] = useState(false);
    const [activeTab, setActiveTab] = useState<"dashboard" | "treasury">("dashboard");

    // Mock treasury data (will be replaced with real data)
    const [treasury] = useState<TreasuryData>({
        totalValue: 125000,
        history: Array.from({ length: 20 }, (_, i) => ({
            timestamp: Date.now() - (20 - i) * 3600000,
            value: 100000 + Math.random() * 50000,
        })),
        tokens: [
            { symbol: "SOL", amount: 500, value: 75000 },
            { symbol: "USDC", amount: 30000, value: 30000 },
            { symbol: "STAR", amount: 100000, value: 20000 },
        ],
    });

    // Fetch test users
    useEffect(() => {
        fetch("/api/test-users")
            .then((r) => r.json())
            .then((data: any) => {
                setTestUsers(data.users || []);
                setConfig(data.config || null);
            })
            .catch(console.error);
    }, []);

    // Connect with user
    const connect = useCallback((user: TestUser) => {
        const secretKeyBinary = atob(user.secretKey);
        const secretKey = new Uint8Array(secretKeyBinary.length);
        for (let i = 0; i < secretKeyBinary.length; i++) {
            secretKey[i] = secretKeyBinary.charCodeAt(i);
        }
        const kp = Keypair.fromSecretKey(secretKey);
        setUserKeypair(kp);
        setPublicKey(user.publicKey);
        setSelectedUser(user);
        setConnected(true);
        setEarningsHistory([]);
    }, []);

    const disconnect = useCallback(() => {
        setPublicKey(null);
        setSelectedUser(null);
        setUserKeypair(null);
        setConnected(false);
        setEarnings(null);
        setEarningsHistory([]);
    }, []);

    // Fetch global data
    const fetchData = useCallback(async () => {
        try {
            const [statsRes, lbRes] = await Promise.all([
                fetch("/api/stats"),
                fetch("/api/leaderboard?limit=10"),
            ]);
            setStats(await statsRes.json());
            const lbData = await lbRes.json();
            setLeaderboard(lbData.leaderboard || []);
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

            // Add to history
            setEarningsHistory((prev) => {
                const earned = Number(BigInt(data.lifetimeEarned || "0") / BigInt(1e9));
                const newPoint = { timestamp: Date.now(), value: earned };
                const updated = [...prev, newPoint].slice(-30);
                return updated;
            });
        } catch (e) {
            console.error("Failed to fetch earnings:", e);
        }
    }, [publicKey]);

    // Polling
    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 5000);
        return () => clearInterval(interval);
    }, [fetchData]);

    useEffect(() => {
        if (connected) {
            fetchEarnings();
            const interval = setInterval(fetchEarnings, 2000);
            return () => clearInterval(interval);
        }
    }, [connected, fetchEarnings]);

    // Claim handler (mock for now)
    const handleClaim = async () => {
        setClaiming(true);
        // Simulate claim
        await new Promise((r) => setTimeout(r, 2000));
        setClaiming(false);
        fetchEarnings();
    };

    // Global stats for display
    const totalStarBalance = Number(stats?.totalStarBalance || 0) / 1e9;
    const totalEarned = Number(BigInt(stats?.totalEarned || "0") / BigInt(1e9));
    const totalClaimed = Number(BigInt(stats?.totalClaimed || "0") / BigInt(1e9));

    return (
        <div className="app">
            <header className="header">
                <div className="header-content">
                    <div className="logo">
                        <span className="logo-icon">✨</span>
                        <h1>Stardust Protocol</h1>
                    </div>
                    <nav className="nav-tabs">
                        <button
                            className={`nav-tab ${activeTab === "dashboard" ? "active" : ""}`}
                            onClick={() => setActiveTab("dashboard")}
                        >
                            📊 Dashboard
                        </button>
                        <button
                            className={`nav-tab ${activeTab === "treasury" ? "active" : ""}`}
                            onClick={() => setActiveTab("treasury")}
                        >
                            🏦 Treasury
                        </button>
                    </nav>
                    <div className="header-right">
                        <span className="network-badge">🔴 LOCALNET</span>
                        {connected && publicKey && (
                            <div className="wallet-connected">
                                <span className="user-badge">User {selectedUser?.id}</span>
                                <button onClick={disconnect} className="btn btn-sm">
                                    Disconnect
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </header>

            <main className="main">
                {/* Global Stats Bar */}
                <section className="stats-bar">
                    <StatsCard
                        icon="👥"
                        label="Holders"
                        value={stats?.totalHolders?.toString() || "0"}
                    />
                    <StatsCard
                        icon="⭐"
                        label="Total STAR"
                        value={totalStarBalance.toFixed(0)}
                        trend="up"
                    />
                    <StatsCard
                        icon="✨"
                        label="Stardust Earned"
                        value={totalEarned.toLocaleString()}
                        trend="up"
                    />
                    <StatsCard
                        icon="💎"
                        label="Claimed"
                        value={totalClaimed.toLocaleString()}
                    />
                    <StatsCard
                        icon="🏦"
                        label="Treasury"
                        value={`$${treasury.totalValue.toLocaleString()}`}
                        trend="up"
                    />
                </section>

                {activeTab === "dashboard" && (
                    <div className="dashboard-layout">
                        {/* Left: User Panel */}
                        <section className="panel user-panel">
                            {!connected ? (
                                <UserSelector
                                    testUsers={testUsers}
                                    selectedUser={selectedUser}
                                    onSelect={connect}
                                />
                            ) : (
                                <UserDashboard
                                    earnings={earnings}
                                    earningsHistory={earningsHistory}
                                    onClaim={handleClaim}
                                    claiming={claiming}
                                />
                            )}
                        </section>

                        {/* Right: Leaderboard */}
                        <section className="panel leaderboard-panel">
                            <div className="panel-header">
                                <h2>🏆 Leaderboard</h2>
                                <span className="live-indicator">● LIVE</span>
                            </div>
                            <Leaderboard entries={leaderboard} currentWallet={publicKey} />
                        </section>
                    </div>
                )}

                {activeTab === "treasury" && (
                    <div className="treasury-layout">
                        <TreasuryPanel treasury={treasury} />
                    </div>
                )}

                {/* Footer Info */}
                <footer className="footer">
                    <span>Program: {config?.programId?.slice(0, 16) || "..."}...</span>
                    <span>STAR Mint: {config?.starTokenMint?.slice(0, 16) || "..."}...</span>
                    <span>STARDUST Mint: {config?.stardustMint?.slice(0, 16) || "..."}...</span>
                </footer>
            </main>
        </div>
    );
}

// Mount
createRoot(document.getElementById("root")!).render(<App />);
