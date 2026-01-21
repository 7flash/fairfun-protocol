import React, { useState, useEffect, useCallback } from "react";
import { PublicKey, Connection, Transaction, TransactionInstruction, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";

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
            <a href="#wallet" className="nav-link">Wallet</a>
            <a href="#wheel" className="nav-link">Wheel</a>
            <a href="#leaders" className="nav-link">Leaders</a>
            <a href="#history" className="nav-link">History</a>
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
                <strong>Galaxy Wheel:</strong> Spend 1,000,000 stardust to spin and win SOL rewards!
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
}> = ({ available, spinning, onSpin }) => {
    const canSpin = available >= SPIN_COST;

    // Wheel segments
    const segments = [
        { label: "0.001", color: "#94a3b8" },
        { label: "0.01", color: "#22c55e" },
        { label: "0.1", color: "#3b82f6" },
        { label: "1", color: "#a855f7" },
        { label: "10", color: "#fbbf24" },
    ];

    return (
        <Section label="GALAXY WHEEL" className="wheel-section" id="wheel">
            <div className="wheel-container">
                <div className="wheel-wrapper">
                    <div className="wheel-pointer">▼</div>
                    <svg viewBox="0 0 200 200" className={`wheel-svg ${spinning ? 'spinning' : ''}`}>
                        {segments.map((seg, i) => {
                            const angle = (360 / 5) * i - 90;
                            const endAngle = angle + 72;
                            const startRad = (angle * Math.PI) / 180;
                            const endRad = (endAngle * Math.PI) / 180;
                            const x1 = 100 + 85 * Math.cos(startRad);
                            const y1 = 100 + 85 * Math.sin(startRad);
                            const x2 = 100 + 85 * Math.cos(endRad);
                            const y2 = 100 + 85 * Math.sin(endRad);
                            const path = `M100,100 L${x1},${y1} A85,85 0 0,1 ${x2},${y2} Z`;
                            const midAngle = angle + 36;
                            const midRad = (midAngle * Math.PI) / 180;
                            const textX = 100 + 55 * Math.cos(midRad);
                            const textY = 100 + 55 * Math.sin(midRad);
                            return (
                                <g key={i}>
                                    <path d={path} fill={seg.color} stroke="#0a0d0f" strokeWidth="2" />
                                    <text x={textX} y={textY} fill="#fff" fontSize="12" fontWeight="bold" textAnchor="middle" dominantBaseline="middle">
                                        {seg.label}
                                    </text>
                                </g>
                            );
                        })}
                        <circle cx="100" cy="100" r="25" fill="#0a0d0f" stroke="#fbbf24" strokeWidth="3" />
                        <text x="100" y="100" fill="#fbbf24" fontSize="16" textAnchor="middle" dominantBaseline="middle">SOL</text>
                    </svg>
                </div>
                <div className="wheel-info">
                    <div className="wheel-cost">Cost: {SPIN_COST.toLocaleString()} ✨</div>
                    <div className="wheel-balance">Your balance: {available.toLocaleString()} ✨</div>
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
                    <th>Earned SOL</th>
                </tr>
            </thead>
            <tbody>
                {leaderboard.length === 0 ? (
                    <tr><td colSpan={4} className="empty">No data yet</td></tr>
                ) : leaderboard.slice(0, 10).map((entry, i) => {
                    const claimed = Number(BigInt(entry.claimed || "0")) / 1e9;
                    const earnedSol = claimed / SPIN_COST * 0.05; // Rough estimate
                    const isMe = entry.wallet === currentWallet;
                    return (
                        <tr key={entry.wallet} className={isMe ? 'current-user' : ''}>
                            <td className={`rank ${i < 3 ? ['gold', 'silver', 'bronze'][i] : ''}`}>{i + 1}</td>
                            <td className="wallet">{entry.wallet.slice(0, 4)}...{entry.wallet.slice(-4)}</td>
                            <td>{claimed.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                            <td className="sol">{earnedSol.toFixed(3)} SOL</td>
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
        } catch (e) {
            console.error('Connect failed:', e);
        }
    };

    const handleDisconnect = () => {
        setConnected(false);
        setPublicKey(null);
        setEarnings(null);
        localStorage.removeItem('stardust-wallet');
    };

    // Fetch config
    useEffect(() => {
        fetch('/api/config').then(r => r.json()).then(setConfig).catch(console.error);
    }, []);

    // Fetch earnings
    const fetchEarnings = useCallback(async () => {
        if (!publicKey) return;
        try {
            const res = await fetch(`/api/earnings/${publicKey}`);
            const data = await res.json();
            setEarnings(data);
        } catch (e) {
            console.error('Fetch earnings failed:', e);
        }
    }, [publicKey]);

    useEffect(() => {
        fetchEarnings();
        const interval = setInterval(fetchEarnings, 10000);
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
            // Use Helius public RPC (more reliable than official mainnet-beta)
            // Disable WebSocket to avoid "ws does not work in browser" error
            const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=15319bf4-5b40-4958-ac8d-6313aa55eb92', {
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

            alert(`✅ Claimed successfully!\n\nTransaction: ${signature.slice(0, 20)}...`);
            fetchEarnings();

        } catch (e: any) {
            console.error('Claim error:', e);
            if (e.message?.includes('User rejected')) {
                alert('Transaction cancelled by user');
            } else {
                alert(`Claim failed: ${e.message}`);
            }
        } finally {
            setClaiming(false);
        }
    };

    // Spin handler
    const handleSpin = async () => {
        if (!publicKey) {
            setShowLogin(true);
            return;
        }
        setSpinning(true);
        try {
            const res = await fetch('/api/redemption/spin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ wallet: publicKey }),
            });
            const result = await res.json();
            if (!res.ok) {
                alert(`Spin failed: ${result.error}`);
                return;
            }
            setTimeout(() => {
                alert(`🎉 ${result.tierName}! You won ${result.rewardFormatted}!`);
            }, 500);
            fetchEarnings();
            fetchWinners();
        } catch (e: any) {
            alert(`Spin failed: ${e.message}`);
        } finally {
            setSpinning(false);
        }
    };

    // Use stardustTokenBalance (actual tokens in wallet) for wheel, not unclaimed (claimable from protocol)
    const available = earnings ? Number(BigInt(earnings.stardustTokenBalance || earnings.claimed || "0")) / 1e9 : 0;

    return (
        <>
            <div className="app-background" />
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
