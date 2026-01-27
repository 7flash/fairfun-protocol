import React, { useState, useEffect, useCallback, useMemo } from "react";
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

// Galaxy Wheel Section - Multi-Ring Dartboard Wheel
// Each ring has a colored "win" zone and gray "pass through" zone
// Colors are positioned sequentially (non-overlapping radially)
// Outer = most common (1% reward), Inner = rarest (50% jackpot)

interface WheelTier {
    label: string;
    color: string;
    percent: number; // probability of landing here
    reward: number;
}

// Wheel tiers - NO "nothing" tier - you always win something
// Probabilities must sum to 100%
// Order: from OUTER ring (rarest/biggest) to INNER ring (most common/smallest)
const WHEEL_CONFIG: WheelTier[] = [
    { label: "50%", color: "#f59e0b", percent: 1, reward: 50 },    // Outer ring - 1% chance (JACKPOT!)
    { label: "10%", color: "#3b82f6", percent: 14, reward: 10 },   // Middle ring - 14% chance
    { label: "1%", color: "#10b981", percent: 85, reward: 1 },     // Inner ring - 85% chance (most common)
];

const TOTAL_PERCENT = WHEEL_CONFIG.reduce((sum, t) => sum + t.percent, 0);
const GRAY_COLOR = "#374151"; // Gray for "pass through" zones

// Dartboard Wheel SVG Component
const DartboardWheel: React.FC<{
    rotation: number;
    isSpinning: boolean;
}> = ({ rotation, isSpinning }) => {
    const size = 320;
    const center = size / 2;
    const outerRadius = size / 2 - 15;
    const hubRadius = 35;

    // Calculate ring boundaries (equal ring widths)
    const numRings = WHEEL_CONFIG.length;
    const ringWidth = (outerRadius - hubRadius) / numRings;

    // Generate arc path for a ring segment
    const createArcPath = (
        cx: number, cy: number,
        innerR: number, outerR: number,
        startAngle: number, endAngle: number
    ): string => {
        // Handle full circle case
        if (Math.abs(endAngle - startAngle) >= 359.99) {
            return `M ${cx - outerR} ${cy} 
                    A ${outerR} ${outerR} 0 1 1 ${cx + outerR} ${cy}
                    A ${outerR} ${outerR} 0 1 1 ${cx - outerR} ${cy}
                    M ${cx - innerR} ${cy}
                    A ${innerR} ${innerR} 0 1 0 ${cx + innerR} ${cy}
                    A ${innerR} ${innerR} 0 1 0 ${cx - innerR} ${cy}`;
        }

        const startRad = (startAngle - 90) * (Math.PI / 180);
        const endRad = (endAngle - 90) * (Math.PI / 180);

        const x1Outer = cx + outerR * Math.cos(startRad);
        const y1Outer = cy + outerR * Math.sin(startRad);
        const x2Outer = cx + outerR * Math.cos(endRad);
        const y2Outer = cy + outerR * Math.sin(endRad);

        const x1Inner = cx + innerR * Math.cos(endRad);
        const y1Inner = cy + innerR * Math.sin(endRad);
        const x2Inner = cx + innerR * Math.cos(startRad);
        const y2Inner = cy + innerR * Math.sin(startRad);

        const largeArc = endAngle - startAngle > 180 ? 1 : 0;

        return `M ${x1Outer} ${y1Outer}
                A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2Outer} ${y2Outer}
                L ${x1Inner} ${y1Inner}
                A ${innerR} ${innerR} 0 ${largeArc} 0 ${x2Inner} ${y2Inner}
                Z`;
    };

    // Build the rings - each ring has colored zone + gray zone
    // Colored zones are positioned sequentially (non-overlapping)
    const segments: React.ReactNode[] = [];
    let cumulativeAngle = 0; // Track where each tier's colored zone ends

    WHEEL_CONFIG.forEach((tier, ringIndex) => {
        // Ring boundaries: outer rings first, inner rings last
        const ringOuterR = outerRadius - ringIndex * ringWidth;
        const ringInnerR = outerRadius - (ringIndex + 1) * ringWidth;

        const tierAngle = (tier.percent / TOTAL_PERCENT) * 360;
        const colorStart = cumulativeAngle;
        const colorEnd = cumulativeAngle + tierAngle;

        // Add gray zone FIRST (from 0 to where this tier starts)
        if (colorStart > 0.01) {
            segments.push(
                <path
                    key={`gray-before-${ringIndex}`}
                    d={createArcPath(center, center, ringInnerR, ringOuterR, 0, colorStart)}
                    fill={GRAY_COLOR}
                    stroke="#0f172a"
                    strokeWidth="1"
                />
            );
        }

        // Add colored "win" zone
        segments.push(
            <path
                key={`color-${ringIndex}`}
                d={createArcPath(center, center, ringInnerR, ringOuterR, colorStart, colorEnd)}
                fill={tier.color}
                stroke="#0f172a"
                strokeWidth="1.5"
            />
        );

        // Add gray zone AFTER (from where this tier ends to 360°)
        if (colorEnd < 359.99) {
            segments.push(
                <path
                    key={`gray-after-${ringIndex}`}
                    d={createArcPath(center, center, ringInnerR, ringOuterR, colorEnd, 360)}
                    fill={GRAY_COLOR}
                    stroke="#0f172a"
                    strokeWidth="1"
                />
            );
        }

        cumulativeAngle += tierAngle;
    });

    return (
        <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
        >
            {/* Outer glow */}
            <circle cx={center} cy={center} r={outerRadius + 8} fill="none" stroke="#fbbf24" strokeWidth="3" opacity="0.4" />
            {/* Outer border */}
            <circle cx={center} cy={center} r={outerRadius + 2} fill="none" stroke="#fbbf24" strokeWidth="2" />

            {/* All ring segments */}
            {segments}

            {/* Ring separators */}
            {WHEEL_CONFIG.map((_, idx) => (
                <circle
                    key={`ring-sep-${idx}`}
                    cx={center}
                    cy={center}
                    r={outerRadius - (idx + 1) * ringWidth}
                    fill="none"
                    stroke="#1e293b"
                    strokeWidth="2"
                />
            ))}

            {/* Center hub */}
            <circle cx={center} cy={center} r={hubRadius} fill="#0f172a" stroke="#fbbf24" strokeWidth="2" />
            <text x={center} y={center - 4} textAnchor="middle" fill="#fbbf24" fontSize="9" fontWeight="800">GALAXY</text>
            <text x={center} y={center + 8} textAnchor="middle" fill="#fbbf24" fontSize="9" fontWeight="800">WHEEL</text>
        </svg>
    );
};

const GalaxyWheelSection: React.FC<{
    available: number;
    spinning: boolean;
    onSpin: () => void;
    targetTier: number | null;
    onSpinFinish: () => void;
    isAdmin?: boolean;
    treasuryBalance?: number;
    onFundTreasury?: (amount: number) => void;
    spinCost: number;
}> = ({ available, spinning, onSpin, targetTier, onSpinFinish, isAdmin, treasuryBalance, onFundTreasury, spinCost }) => {
    const canSpin = available >= spinCost;
    const [fundAmount, setFundAmount] = React.useState("0.1");

    // Animation state
    const [demoActive, setDemoActive] = React.useState(false);
    const [result, setResult] = React.useState<WheelTier | null>(null);

    // Three-stage pointer animation state
    type SpinPhase = 'idle' | 'accelerating' | 'constant' | 'decelerating';
    const [spinPhase, setSpinPhase] = React.useState<SpinPhase>('idle');
    const [pointerRotation, setPointerRotation] = React.useState(0);
    const [targetRotation, setTargetRotation] = React.useState(0);
    const animationRef = React.useRef<number | null>(null);
    const spinStartTime = React.useRef<number>(0);
    const constantSpinStartRotation = React.useRef<number>(0);

    const isSpinning = spinPhase !== 'idle';

    // Animation constants
    const ACCEL_DURATION = 800; // ms to accelerate
    const BASE_SPEED = 720; // degrees per second at constant speed
    const DECEL_DURATION = 2500; // ms to decelerate

    // Determine tier based on random weighted selection
    const selectTierByProbability = (): number => {
        const r = Math.random() * TOTAL_PERCENT;
        let cumulative = 0;
        for (let i = 0; i < WHEEL_CONFIG.length; i++) {
            cumulative += WHEEL_CONFIG[i].percent;
            if (r < cumulative) return i;
        }
        return 0;
    };

    // Calculate target rotation to land on a tier's colored zone
    const getTargetAngleForTier = (tierIndex: number): number => {
        let cumulativeAngle = 0;
        for (let i = 0; i < tierIndex; i++) {
            cumulativeAngle += (WHEEL_CONFIG[i].percent / TOTAL_PERCENT) * 360;
        }
        const tierAngle = (WHEEL_CONFIG[tierIndex].percent / TOTAL_PERCENT) * 360;
        const randomOffset = Math.random() * tierAngle;
        return cumulativeAngle + randomOffset;
    };

    // Animation loop
    const animate = React.useCallback((timestamp: number) => {
        const elapsed = timestamp - spinStartTime.current;

        if (spinPhase === 'accelerating') {
            // Ease-in: accelerate from 0 to base speed
            const progress = Math.min(elapsed / ACCEL_DURATION, 1);
            const easeIn = progress * progress; // quadratic ease-in
            const rotation = constantSpinStartRotation.current + (easeIn * BASE_SPEED * (ACCEL_DURATION / 1000));
            setPointerRotation(rotation);

            if (progress >= 1) {
                // Transition to constant phase
                setSpinPhase('constant');
                spinStartTime.current = timestamp;
                constantSpinStartRotation.current = rotation;
            }
        } else if (spinPhase === 'constant') {
            // Constant speed spin
            const rotation = constantSpinStartRotation.current + (elapsed / 1000) * BASE_SPEED;
            setPointerRotation(rotation);
        } else if (spinPhase === 'decelerating') {
            // Ease-out: decelerate to target
            const progress = Math.min(elapsed / DECEL_DURATION, 1);
            const easeOut = 1 - Math.pow(1 - progress, 3); // cubic ease-out
            const startRot = constantSpinStartRotation.current;
            const rotation = startRot + (targetRotation - startRot) * easeOut;
            setPointerRotation(rotation);

            if (progress >= 1) {
                // Animation complete
                setSpinPhase('idle');
                setPointerRotation(targetRotation);
                return;
            }
        }

        if (spinPhase !== 'idle') {
            animationRef.current = requestAnimationFrame(animate);
        }
    }, [spinPhase, targetRotation]);

    // Start animation loop when phase changes
    React.useEffect(() => {
        if (spinPhase !== 'idle' && animationRef.current === null) {
            spinStartTime.current = performance.now();
            animationRef.current = requestAnimationFrame(animate);
        }
        return () => {
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
                animationRef.current = null;
            }
        };
    }, [spinPhase, animate]);

    // Handle spin finish
    React.useEffect(() => {
        if (spinPhase === 'idle' && (demoActive || spinning) && result === null) {
            // Check if we just finished decelerating
        }
    }, [spinPhase, demoActive, spinning, result]);

    // Handle demo spin
    const handleDemo = () => {
        if (isSpinning) return;
        setResult(null);
        setDemoActive(true);

        const selectedTier = selectTierByProbability();
        startAcceleration(selectedTier);
    };

    // Handle real spin trigger
    const handleRealSpin = () => {
        if (!canSpin || isSpinning) return;
        setResult(null);
        onSpin();
        // Start accelerating immediately, will wait in constant phase for result
        startAcceleration(null);
    };

    // Start the acceleration phase
    const startAcceleration = (knownTier: number | null) => {
        constantSpinStartRotation.current = pointerRotation;
        spinStartTime.current = performance.now();
        setSpinPhase('accelerating');

        if (knownTier !== null) {
            // For demo, we already know the result - calculate target
            const target = getTargetAngleForTier(knownTier);
            // Add some full rotations during decel
            const fullRotations = 3 + Math.floor(Math.random() * 2);
            setTargetRotation(pointerRotation + (fullRotations * 360) + target);

            // Schedule transition to decel after accel + brief constant
            setTimeout(() => {
                if (animationRef.current) {
                    constantSpinStartRotation.current = pointerRotation + BASE_SPEED * (ACCEL_DURATION / 1000);
                }
                setSpinPhase('decelerating');
                spinStartTime.current = performance.now();

                // Set result after decel
                setTimeout(() => {
                    setResult(WHEEL_CONFIG[knownTier]);
                    setDemoActive(false);
                }, DECEL_DURATION);
            }, ACCEL_DURATION + 500); // Brief constant spin
        }
    };

    // When targetTier is set from parent (after tx confirms), transition to deceleration
    React.useEffect(() => {
        if (targetTier !== null && spinning && spinPhase === 'constant') {
            const target = getTargetAngleForTier(targetTier);
            const currentRotation = pointerRotation;
            const fullRotations = 3 + Math.floor(Math.random() * 2);

            // Target needs to be ahead of current position
            const targetRot = currentRotation + (fullRotations * 360) + target;
            setTargetRotation(targetRot);
            constantSpinStartRotation.current = currentRotation;

            setSpinPhase('decelerating');
            spinStartTime.current = performance.now();

            // Set result after decel
            setTimeout(() => {
                setResult(WHEEL_CONFIG[targetTier]);
                onSpinFinish();
            }, DECEL_DURATION);
        }
    }, [targetTier, spinning, spinPhase, pointerRotation]);

    return (
        <Section label="GALAXY WHEEL" className="wheel-section" id="wheel">
            {/* Jackpot Pool Display */}
            {treasuryBalance !== undefined && (
                <div style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                    background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)',
                    padding: '16px 32px', borderRadius: '16px', marginBottom: '24px', textAlign: 'center'
                }}>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: '#fbbf24', letterSpacing: '2px' }}>🏆 JACKPOT POOL</span>
                    <span style={{ fontSize: '32px', fontWeight: 800, color: '#fbbf24', textShadow: '0 0 30px rgba(251,191,36,0.5)' }}>
                        {treasuryBalance.toFixed(4)} SOL
                    </span>
                    <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', marginTop: '8px', fontSize: '12px', fontWeight: 600, flexWrap: 'wrap' }}>
                        {WHEEL_CONFIG.filter(t => t.reward > 0).map((tier, i) => (
                            <span key={i} style={{ color: tier.color }}>
                                {tier.percent}% → {((treasuryBalance * tier.reward) / 100).toFixed(3)} SOL
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {/* Wheel Container with Rotating Pointer */}
            <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '24px' }}>
                {/* Outer rotating pointer ring */}
                <div style={{
                    position: 'relative',
                    width: '360px',
                    height: '360px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }}>
                    {/* Rotating pointer */}
                    <div style={{
                        position: 'absolute',
                        width: '100%',
                        height: '100%',
                        transform: `rotate(${pointerRotation}deg)`,
                        zIndex: 30,
                        pointerEvents: 'none'
                    }}>
                        {/* Pointer triangle at top */}
                        <div style={{
                            position: 'absolute',
                            top: '0',
                            left: '50%',
                            transform: 'translateX(-50%)',
                            fontSize: '32px',
                            color: '#fbbf24',
                            textShadow: '0 4px 12px rgba(0,0,0,0.8)',
                            filter: 'drop-shadow(0 0 10px rgba(251,191,36,0.8))'
                        }}>▼</div>
                    </div>

                    {/* Static Dartboard Wheel */}
                    <div style={{
                        position: 'absolute',
                        borderRadius: '50%',
                        boxShadow: '0 0 60px rgba(251,191,36,0.4), inset 0 0 30px rgba(0,0,0,0.5)'
                    }}>
                        <DartboardWheel rotation={0} isSpinning={false} />
                    </div>
                </div>

                {/* Legend */}
                <div style={{
                    display: 'flex', gap: '16px', marginTop: '16px', justifyContent: 'center', flexWrap: 'wrap'
                }}>
                    {WHEEL_CONFIG.map((tier, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
                            <div style={{ width: '12px', height: '12px', borderRadius: '3px', background: tier.color }} />
                            <span style={{ color: '#94a3b8' }}>{tier.label}</span>
                            <span style={{ color: tier.color, fontWeight: 600 }}>({tier.percent}%)</span>
                        </div>
                    ))}
                </div>
            </div>

            {/* Result */}
            {result && (
                <div style={{
                    padding: '16px 32px', borderRadius: '12px', marginBottom: '20px',
                    fontWeight: 700, fontSize: '18px', textAlign: 'center',
                    border: `2px solid ${result.color}`,
                    background: result.reward > 0 ? 'rgba(16, 185, 129, 0.15)' : 'rgba(100, 116, 139, 0.15)',
                    color: result.reward > 0 ? '#10b981' : '#64748b'
                }}>
                    {result.reward > 0
                        ? `🎉 You won ${result.reward}% = ${treasuryBalance ? ((treasuryBalance * result.reward) / 100).toFixed(4) : '?'} SOL!`
                        : '😔 Better luck next time!'}
                </div>
            )}

            {/* Controls */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
                <button
                    className="btn btn-gold"
                    onClick={handleRealSpin}
                    disabled={!canSpin || isSpinning}
                    style={{
                        padding: '14px 40px',
                        fontSize: '16px',
                        fontWeight: 700,
                        borderRadius: '50px',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        background: 'linear-gradient(135deg, #fbbf24, #f59e0b)',
                        border: 'none',
                        color: '#0f172a',
                        cursor: canSpin && !isSpinning ? 'pointer' : 'not-allowed',
                        opacity: canSpin && !isSpinning ? 1 : 0.6,
                        boxShadow: '0 4px 20px rgba(251, 191, 36, 0.4)'
                    }}
                >
                    {isSpinning ? '✨ SPINNING...' : '🎰 SPIN WHEEL'}
                    <span style={{ fontSize: '11px', opacity: 0.8, marginTop: '2px' }}>{spinCost.toLocaleString()} STARDUST</span>
                </button>

                <button
                    onClick={handleDemo}
                    disabled={isSpinning}
                    style={{
                        padding: '8px 20px',
                        fontSize: '13px',
                        background: 'transparent',
                        border: '1px solid #475569',
                        color: '#94a3b8',
                        borderRadius: '20px',
                        cursor: isSpinning ? 'not-allowed' : 'pointer',
                        opacity: isSpinning ? 0.5 : 1
                    }}
                >
                    🎮 DEMO SPIN
                </button>

                {!canSpin && !isSpinning && (
                    <p style={{ color: '#ef4444', fontSize: '13px', margin: 0 }}>
                        Need {(spinCost - available).toLocaleString()} more STARDUST
                    </p>
                )}
            </div>

            {/* Admin Panel */}
            {isAdmin && onFundTreasury && (
                <div style={{ marginTop: '24px', display: 'flex', justifyContent: 'center', gap: '8px' }}>
                    <input
                        type="number"
                        value={fundAmount}
                        onChange={(e) => setFundAmount(e.target.value)}
                        style={{ padding: '10px 12px', borderRadius: '8px', border: '1px solid #334155', background: '#0f172a', color: 'white', width: '80px', fontSize: '14px' }}
                    />
                    <button
                        className="btn btn-secondary"
                        onClick={() => onFundTreasury(parseFloat(fundAmount))}
                        style={{ padding: '10px 20px' }}
                    >
                        💰 Fund Treasury
                    </button>
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
    const [targetTier, setTargetTier] = useState<number | null>(null);
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

            // Set target tier so the wheel animation lands on the correct segment
            setTargetTier(tier);

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
                            targetTier={targetTier}
                            onSpinFinish={() => {
                                setSpinning(false);
                                setTargetTier(null);
                            }}
                            spinCost={SPIN_COST}
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
