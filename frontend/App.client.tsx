import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";

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
const TIER_GLOWS = ["rgba(85,85,85,0.3)", "rgba(34,197,94,0.4)", "rgba(59,130,246,0.4)", "rgba(168,85,247,0.5)", "rgba(245,158,11,0.6)"];
const API = "";

// ============================================
// GALAXY WHEEL — Custom Canvas
// ============================================
function GalaxyWheelCanvas({ spinning, resultTier, onRingLocked }: {
    spinning: boolean;
    resultTier: number | null;
    onRingLocked?: (ringIndex: number, hit: boolean) => void;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const animRef = useRef<number>(0);
    const ptcRef = useRef<{ ring: number; angle: number; speed: number; sz: number; op: number }[]>([]);

    // Per-ring independent state
    const ringRots = useRef([0, 0, 0, 0, 0]);           // current rotation per ring
    const ringSpds = useRef([0.04, -0.035, 0.03, -0.025, 0.02]); // speed (sign = direction)
    const ringLocked = useRef([false, false, false, false, false]);
    const ringTargets = useRef<(number | null)[]>([null, null, null, null, null]);
    const ringDecel = useRef([0, 0, 0, 0, 0]);          // deceleration rate per ring (rad/frame²)
    const cascadeIndex = useRef(-1);
    const cascadeTimer = useRef(0);
    const notifiedRings = useRef([false, false, false, false, false]);
    const resultTierRef = useRef<number | null>(null);

    const PROB = [0.50, 0.30, 0.15, 0.045, 0.005];
    const ARCS = [5, 4, 3, 2, 1];
    const LOCK_DELAY_MS = 650;

    // Find the nearest active arc's center angle for a ring at current rotation
    const findNearestArc = (ringIdx: number, currentRot: number, targetAngle: number) => {
        const arcLen = (PROB[ringIdx] / ARCS[ringIdx]) * Math.PI * 2;
        const gapLen = (Math.PI * 2 * (1 - PROB[ringIdx])) / ARCS[ringIdx];
        const stride = arcLen + gapLen;
        const dir = ringSpds.current[ringIdx] >= 0 ? 1 : -1;
        let bestDist = Infinity, bestTarget = currentRot;
        for (let a = 0; a < ARCS[ringIdx]; a++) {
            const arcCenter = a * stride + arcLen / 2;
            let targetRot = targetAngle - arcCenter;
            const diff = targetRot - currentRot;
            const mod = ((diff % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
            targetRot = currentRot + (dir > 0 ? mod : mod - Math.PI * 2);
            const minTravel = Math.PI * 2;
            if (dir > 0 && targetRot < currentRot + minTravel) targetRot += Math.PI * 2;
            if (dir < 0 && targetRot > currentRot - minTravel) targetRot -= Math.PI * 2;
            const dist = Math.abs(targetRot - currentRot);
            if (dist < bestDist) { bestDist = dist; bestTarget = targetRot; }
        }
        return bestTarget;
    };

    // Find a rotation that places NO active arc at targetAngle
    const findMissAngle = (ringIdx: number, currentRot: number, targetAngle: number) => {
        const arcLen = (PROB[ringIdx] / ARCS[ringIdx]) * Math.PI * 2;
        const gapLen = (Math.PI * 2 * (1 - PROB[ringIdx])) / ARCS[ringIdx];
        const gapCenter = arcLen + gapLen / 2;
        const dir = ringSpds.current[ringIdx] >= 0 ? 1 : -1;
        let targetRot = targetAngle - gapCenter;
        const diff = targetRot - currentRot;
        const mod = ((diff % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        targetRot = currentRot + (dir > 0 ? mod : mod - Math.PI * 2);
        const minTravel = Math.PI * 2;
        if (dir > 0 && targetRot < currentRot + minTravel) targetRot += Math.PI * 2;
        if (dir < 0 && targetRot > currentRot - minTravel) targetRot -= Math.PI * 2;
        return targetRot;
    };

    // Initialize particles
    useEffect(() => {
        const p: typeof ptcRef.current = [];
        for (let ring = 0; ring < 5; ring++) {
            for (let i = 0; i < 6 + ring * 4; i++) {
                p.push({ ring, angle: Math.random() * Math.PI * 2, speed: 0.002 + Math.random() * 0.005, sz: 0.8 + Math.random() * 2, op: 0.3 + Math.random() * 0.6 });
            }
        }
        ptcRef.current = p;
    }, []);

    // Start spinning — randomize directions and speeds
    useEffect(() => {
        if (spinning) {
            const dirs = [1, -1, 1, -1, 1];
            for (let i = 0; i < 5; i++) {
                ringSpds.current[i] = dirs[i] * (0.025 + Math.random() * 0.035);
                ringLocked.current[i] = false;
                ringTargets.current[i] = null;
                ringDecel.current[i] = 0;
                notifiedRings.current[i] = false;
            }
            cascadeIndex.current = -1;
            cascadeTimer.current = 0;
        }
    }, [spinning]);

    // When result arrives, begin cascade
    useEffect(() => {
        if (resultTier !== null && !spinning) {
            resultTierRef.current = resultTier;
            cascadeIndex.current = 0;
            cascadeTimer.current = 0;
        }
    }, [resultTier, spinning]);

    // Main draw loop
    useEffect(() => {
        const c = canvasRef.current; if (!c) return;
        const ctx = c.getContext('2d'); if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        const S = 380;
        c.width = S * dpr; c.height = S * dpr;
        c.style.width = S + 'px'; c.style.height = S + 'px';
        ctx.scale(dpr, dpr);
        const cx = S / 2, cy = S / 2;
        const radii = [165, 138, 111, 84, 60];
        const widths = [20, 20, 20, 18, 16];
        const PTR = -Math.PI / 2;

        const draw = () => {
            ctx.clearRect(0, 0, S, S);
            const t = Date.now() * 0.003;
            const now = Date.now();

            // --- Update ring rotations ---
            const rt = resultTierRef.current;
            for (let i = 0; i < 5; i++) {
                if (ringLocked.current[i]) continue;

                if (cascadeIndex.current === i && ringTargets.current[i] !== null) {
                    // Physics-based deceleration: ring keeps its direction, speed decreases
                    const target = ringTargets.current[i]!;
                    const remaining = target - ringRots.current[i];
                    const absRemaining = Math.abs(remaining);
                    const dir = remaining >= 0 ? 1 : -1;

                    if (absRemaining < 0.001) {
                        // Close enough — snap and lock
                        ringRots.current[i] = target;
                        ringLocked.current[i] = true;
                        ringSpds.current[i] = 0;
                        const isHit = rt !== null && i <= rt;
                        if (!notifiedRings.current[i] && onRingLocked) {
                            onRingLocked(i, isHit);
                            notifiedRings.current[i] = true;
                        }
                        cascadeTimer.current = now;
                    } else {
                        // Decelerate: speed = sqrt(2 * decel * remaining)
                        // This gives a constant-deceleration profile (like real friction)
                        const speed = dir * Math.sqrt(2 * ringDecel.current[i] * absRemaining);
                        ringSpds.current[i] = speed;
                        ringRots.current[i] += speed;
                    }
                } else if (cascadeIndex.current >= 0 && i > cascadeIndex.current && !ringLocked.current[i]) {
                    // Waiting rings — very gentle slowdown
                    ringSpds.current[i] *= 0.998;
                    ringRots.current[i] += ringSpds.current[i];
                } else {
                    ringRots.current[i] += ringSpds.current[i];
                }
            }

            // --- Cascade progression ---
            if (rt !== null && cascadeIndex.current >= 0 && cascadeIndex.current < 5) {
                const ci = cascadeIndex.current;

                // Initialize lock target for current ring
                if (ringTargets.current[ci] === null) {
                    if (cascadeTimer.current === 0 || now - cascadeTimer.current >= LOCK_DELAY_MS) {
                        const isHit = ci <= rt;
                        const target = isHit
                            ? findNearestArc(ci, ringRots.current[ci], PTR)
                            : findMissAngle(ci, ringRots.current[ci], PTR);
                        ringTargets.current[ci] = target;
                        // Compute deceleration: v² = 2*a*d → a = v²/(2d)
                        const dist = Math.abs(target - ringRots.current[ci]);
                        const v0 = Math.abs(ringSpds.current[ci]);
                        ringDecel.current[ci] = (v0 * v0) / (2 * dist);
                    }
                }

                // Move to next ring after current finishes + delay
                const isLocked = ringLocked.current[ci];
                const elapsed = isLocked ? now - cascadeTimer.current : -1;
                if (isLocked && elapsed >= LOCK_DELAY_MS) {
                    if (ci < 4) {
                        cascadeIndex.current = ci + 1;
                    } else {
                        cascadeIndex.current = 5;
                    }
                }
            }

            const allDone = cascadeIndex.current >= 5;
            const showingResult = rt !== null && cascadeIndex.current >= 0;

            // --- Background glow ---
            const bg = ctx.createRadialGradient(cx, cy, 30, cx, cy, 185);
            bg.addColorStop(0, 'rgba(15,17,26,0.95)');
            bg.addColorStop(0.7, 'rgba(10,11,15,0.6)');
            bg.addColorStop(1, 'rgba(10,11,15,0)');
            ctx.fillStyle = bg;
            ctx.beginPath(); ctx.arc(cx, cy, 185, 0, Math.PI * 2); ctx.fill();

            // --- Pointer beam line ---
            if (showingResult) {
                ctx.save();
                const beamColor = allDone && resultTier !== null ? TIER_COLORS[resultTier] : '#f59e0b';
                ctx.strokeStyle = beamColor;
                ctx.globalAlpha = 0.25 + Math.sin(t * 2) * 0.15;
                ctx.lineWidth = 2;
                ctx.setLineDash([4, 6]);
                ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - 180);
                ctx.stroke(); ctx.setLineDash([]);
                ctx.restore();
            }

            // --- Draw 5 rings ---
            for (let i = 0; i < 5; i++) {
                const r = radii[i], w = widths[i];
                const locked = ringLocked.current[i];
                const locking = cascadeIndex.current === i && ringTargets.current[i] !== null;
                const isHit = locked && resultTier !== null && i <= resultTier;
                const isMiss = locked && resultTier !== null && i > resultTier;
                const isWinTier = allDone && resultTier === i;
                const isFaded = allDone && resultTier !== null && i !== resultTier;

                const alpha = isMiss ? 0.15 : (isFaded && !isWinTier ? 0.25 : 1.0);
                const pulse = isWinTier ? (1 + Math.sin(t * 3) * 0.06) : 1;
                const dr = r * pulse;
                const dw = isWinTier ? w + 3 : (locked && isHit ? w + 1 : w);

                const rot = ringRots.current[i];
                const arcPerZone = (PROB[i] / ARCS[i]) * Math.PI * 2;
                const gapPerZone = (Math.PI * 2 * (1 - PROB[i])) / ARCS[i];

                // Dim full circle background
                ctx.save();
                ctx.globalAlpha = alpha * 0.10;
                ctx.strokeStyle = TIER_COLORS[i]; ctx.lineWidth = dw;
                ctx.beginPath(); ctx.arc(cx, cy, dr, 0, Math.PI * 2); ctx.stroke();
                ctx.restore();

                // Glow
                ctx.save(); ctx.globalAlpha = alpha;
                ctx.shadowColor = (isWinTier || (locked && isHit)) ? TIER_COLORS[i] : TIER_GLOWS[i];
                ctx.shadowBlur = isWinTier ? 30 + Math.sin(t * 4) * 10 : (locked && isHit ? 15 : 5);
                ctx.beginPath(); ctx.arc(cx, cy, dr, 0, Math.PI * 2);
                ctx.strokeStyle = 'transparent'; ctx.lineWidth = dw + 4; ctx.stroke();
                ctx.restore();

                // Active arcs
                for (let a = 0; a < ARCS[i]; a++) {
                    const start = rot + a * (arcPerZone + gapPerZone);
                    const end = start + arcPerZone;
                    const bright = (locked && isHit) ? 0.95 : (locking ? 0.8 : 0.55);
                    ctx.beginPath(); ctx.arc(cx, cy, dr, start, end);
                    ctx.strokeStyle = TIER_COLORS[i];
                    ctx.globalAlpha = bright * alpha;
                    ctx.lineWidth = dw; ctx.lineCap = 'butt'; ctx.stroke();
                    // Extra glow on winning/hit arcs
                    if (isWinTier || (locked && isHit)) {
                        ctx.save(); ctx.shadowColor = TIER_COLORS[i]; ctx.shadowBlur = 10;
                        ctx.beginPath(); ctx.arc(cx, cy, dr, start, end);
                        ctx.strokeStyle = TIER_COLORS[i]; ctx.globalAlpha = 0.3 * alpha;
                        ctx.lineWidth = dw + 5; ctx.stroke(); ctx.restore();
                    }
                }
                ctx.globalAlpha = 1;

                // Inactive tick marks
                for (let a = 0; a < ARCS[i]; a++) {
                    const gStart = rot + a * (arcPerZone + gapPerZone) + arcPerZone;
                    const ticks = Math.max(2, Math.floor(gapPerZone / 0.18));
                    const tickLen = gapPerZone / ticks;
                    for (let s = 0; s < ticks; s++) {
                        const sa = gStart + s * tickLen;
                        ctx.beginPath(); ctx.arc(cx, cy, dr, sa, sa + tickLen * 0.35);
                        ctx.strokeStyle = TIER_COLORS[i]; ctx.globalAlpha = 0.05 * alpha;
                        ctx.lineWidth = dw * 0.4; ctx.stroke();
                    }
                }
                ctx.globalAlpha = 1;

                // Tier label (show when locking or locked)
                if (locked || locking || (!spinning && cascadeIndex.current < 0)) {
                    ctx.save();
                    ctx.font = `700 ${isWinTier ? 10 : (i === 4 ? 7 : 8)}px Inter, sans-serif`;
                    ctx.fillStyle = TIER_COLORS[i];
                    ctx.globalAlpha = isWinTier ? 1 : (locked && isHit ? 0.8 : (isMiss ? 0.12 : 0.5));
                    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                    ctx.fillText(TIER_NAMES[i], cx, cy - dr);
                    ctx.restore();
                }

                // Lock indicator — checkmark or X
                if (locked) {
                    ctx.save();
                    ctx.font = '700 12px Inter, sans-serif';
                    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                    if (isHit) {
                        ctx.fillStyle = TIER_COLORS[i]; ctx.globalAlpha = 0.9;
                        ctx.fillText('✓', cx + dr + 14, cy);
                    } else if (isMiss) {
                        ctx.fillStyle = '#ef4444'; ctx.globalAlpha = 0.7;
                        ctx.fillText('✗', cx + dr + 14, cy);
                    }
                    ctx.restore();
                }
            }

            // --- Particles ---
            for (const p of ptcRef.current) {
                p.angle += p.speed + Math.abs(ringSpds.current[p.ring]) * 0.3;
                const pr = radii[p.ring];
                const winP = allDone && resultTier === p.ring;
                const fadeP = allDone && resultTier !== null && p.ring !== resultTier;
                ctx.beginPath(); ctx.arc(cx + Math.cos(p.angle) * pr, cy + Math.sin(p.angle) * pr, winP ? p.sz * 1.5 : p.sz, 0, Math.PI * 2);
                ctx.fillStyle = TIER_COLORS[p.ring];
                ctx.globalAlpha = (fadeP ? 0.04 : 1) * p.op * (0.4 + Math.sin(t * 1.3 + p.angle * 3) * 0.6);
                ctx.fill();
            }
            ctx.globalAlpha = 1;

            // --- Center hub ---
            const hubR = allDone ? 42 : 38;
            const hg = ctx.createRadialGradient(cx, cy, 5, cx, cy, hubR + 2);
            hg.addColorStop(0, '#1e2130'); hg.addColorStop(1, '#0c0d14');
            ctx.beginPath(); ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
            ctx.fillStyle = hg; ctx.fill();
            if (allDone && resultTier !== null) {
                ctx.strokeStyle = TIER_COLORS[resultTier]; ctx.lineWidth = 3;
                ctx.shadowColor = TIER_COLORS[resultTier]; ctx.shadowBlur = 15;
                ctx.stroke(); ctx.shadowBlur = 0;
                ctx.fillStyle = TIER_COLORS[resultTier]; ctx.font = '800 11px Inter, sans-serif';
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText(TIER_NAMES[resultTier], cx, cy - 5);
                ctx.fillStyle = '#8891a5'; ctx.font = '600 8px Inter, sans-serif';
                ctx.fillText('★ WINNER', cx, cy + 9);
            } else {
                ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2.5; ctx.stroke();
                ctx.fillStyle = '#f59e0b'; ctx.font = '800 12px Inter, sans-serif';
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText('GALAXY', cx, cy - 7);
                ctx.fillStyle = '#555b6e'; ctx.font = '500 8px Inter, sans-serif';
                ctx.fillText('WHEEL', cx, cy + 8);
            }

            // --- Pointer triangle ---
            ctx.save();
            ctx.fillStyle = allDone && resultTier !== null ? TIER_COLORS[resultTier] : '#f59e0b';
            ctx.shadowColor = allDone && resultTier !== null ? TIER_GLOWS[resultTier] : 'rgba(245,158,11,0.7)';
            ctx.shadowBlur = 14;
            ctx.beginPath();
            ctx.moveTo(cx - 9, 4); ctx.lineTo(cx + 9, 4); ctx.lineTo(cx, 20); ctx.closePath();
            ctx.fill(); ctx.restore();

            animRef.current = requestAnimationFrame(draw);
        };
        animRef.current = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(animRef.current);
    }, [resultTier, spinning]);

    return <canvas ref={canvasRef} className={`galaxy-canvas ${spinning ? 'galaxy-spinning' : ''}`} />;
}


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
    const [spinResult, setSpinResult] = useState<{ tierName: string; rewardAmount: number; tierIndex: number } | null>(null);
    const [lockedTiers, setLockedTiers] = useState<{ [key: number]: boolean }>({});  // ringIndex -> hit/miss
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
            setLockedTiers({});
        });

        sse.addEventListener("spin", (e) => {
            const data = JSON.parse(e.data);
            const tier = data.tier ?? 0;

            // Set spin result for canvas wheel to show
            setSpinResult({
                tierName: TIER_NAMES[tier] || 'VOID',
                rewardAmount: data.rewardAmount || 0,
                tierIndex: tier,
            });
            // Clear spinning holder quickly since cascade handles the reveal
            setTimeout(() => setSpinningHolder(null), 1000);
            // Clear result after cascade completes (~18s)
            setTimeout(() => setSpinResult(null), 20000);

            // Update liveData
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
                        <GalaxyWheelCanvas
                            spinning={!!spinningHolder}
                            resultTier={spinResult?.tierIndex ?? null}
                            onRingLocked={(ringIdx, hit) => setLockedTiers(prev => ({ ...prev, [ringIdx]: hit }))}
                        />

                        {/* Spinning for / Result */}
                        {spinningHolder && !spinResult && (
                            <div className="spin-status spinning">
                                ✦ Spinning for {spinningHolder.slice(0, 4)}...{spinningHolder.slice(-4)}
                            </div>
                        )}
                        {spinResult && (
                            <div className="spin-status result" style={{ borderColor: TIER_COLORS[spinResult.tierIndex] }}>
                                <span style={{ color: TIER_COLORS[spinResult.tierIndex] }}>✦ {spinResult.tierName}</span>
                                <span className="result-sol">{(spinResult.rewardAmount / 1e9).toFixed(4)} SOL</span>
                            </div>
                        )}

                        {/* Tier Legend — progressive cascade */}
                        <div className="tier-legend">
                            {TIER_NAMES.map((name, i) => {
                                const isLocked = i in lockedTiers;
                                const isHit = lockedTiers[i] === true;
                                const isMiss = lockedTiers[i] === false;
                                const isWinTier = spinResult?.tierIndex === i && Object.keys(lockedTiers).length > i;
                                const treasury = liveData?.stats?.poolBalance ?? 0;
                                const rewardShares = [0.01, 0.04, 0.15, 0.40, 1.00];
                                const solReward = (treasury * rewardShares[i] / 1e9).toFixed(4);
                                return (
                                    <div key={name} className={`tier-item ${isWinTier ? 'tier-winner' : ''} ${isHit ? 'tier-hit' : ''} ${isMiss ? 'tier-miss' : ''}`}
                                        style={{ opacity: isMiss ? 0.35 : (isLocked ? 1 : 0.5), transition: 'all 0.5s' }}>
                                        <span className="tier-dot" style={{ backgroundColor: TIER_COLORS[i] }} />
                                        <span className="tier-name">{name}</span>
                                        <span className="tier-reward" style={{ color: isHit ? TIER_COLORS[i] : '#666' }}>
                                            {isLocked ? (isHit ? `+${solReward} SOL` : '—') : `${solReward} SOL`}
                                        </span>
                                        {isHit && <span style={{ color: TIER_COLORS[i], fontSize: '13px' }}>✓</span>}
                                        {isMiss && <span style={{ color: '#ef4444', fontSize: '13px' }}>✗</span>}
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
