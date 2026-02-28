import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

// ============================================
// TYPES
// ============================================
interface WheelTier {
    label: string;
    color: string;
    gradient: string;
    glowColor: string;
    percent: number;
    reward: number;
}

interface QueueHolder {
    position: number;
    wallet: string;
    walletShort: string;
    isCurrent: boolean;
    lifetimeEarned: string;
    probabilities: number[];
    totalWinnings: number;
}

interface RpcStatusInfo {
    online: boolean;
    lastError: string;
    lastErrorTime: number;
    lastSuccess: number;
    consecutiveFailures: number;
    poolFetched: boolean;
}

interface LiveState {
    queue: QueueHolder[];
    currentIndex: number;
    totalHolders: number;
    autoSpinEnabled: boolean;
    autoSpinInterval: number;
    recentSpins: any[];
    stats: {
        totalSpins: number;
        totalDistributed: number;
        totalDistributedFormatted: string;
        poolBalance: number;
        poolBalanceFormatted: string;
    };
    rpcStatus: RpcStatusInfo;
    tierNames: string[];
    baseProbabilities: number[];
}

// ============================================
// WHEEL CONFIG (same as main app)
// ============================================
const WHEEL_CONFIG: WheelTier[] = [
    {
        label: "SUPERNOVA",
        color: "#fbbf24",
        gradient: "linear-gradient(135deg, #ff6b00 0%, #ffd700 30%, #ff4500 60%, #ff8c00 100%)",
        glowColor: "rgba(255, 183, 0, 0.8)",
        percent: 0.5,
        reward: 100
    },
    {
        label: "NEBULA",
        color: "#a855f7",
        gradient: "linear-gradient(135deg, #7c3aed 0%, #ec4899 40%, #a855f7 70%, #6366f1 100%)",
        glowColor: "rgba(168, 85, 247, 0.6)",
        percent: 2,
        reward: 40
    },
    {
        label: "METEORS",
        color: "#3b82f6",
        gradient: "linear-gradient(135deg, #1e3a8a 0%, #3b82f6 40%, #1d4ed8 70%, #2563eb 100%)",
        glowColor: "rgba(59, 130, 246, 0.4)",
        percent: 7.5,
        reward: 15
    },
    {
        label: "COSMOS",
        color: "#10b981",
        gradient: "linear-gradient(135deg, #065f46 0%, #10b981 40%, #059669 70%, #34d399 100%)",
        glowColor: "rgba(16, 185, 129, 0.5)",
        percent: 20,
        reward: 4
    },
    {
        label: "VOID",
        color: "#94a3b8",
        gradient: "linear-gradient(135deg, #334155 0%, #64748b 40%, #94a3b8 70%, #cbd5e1 100%)",
        glowColor: "rgba(148, 163, 184, 0.3)",
        percent: 70,
        reward: 1
    },
];

const TOTAL_PERCENT = WHEEL_CONFIG.reduce((sum, t) => sum + t.percent, 0);
const SPACE_COLOR = "#0f0f1a";
const TIER_EMOJIS = ['🌟', '⚡', '☄️', '🌌', '✨'];

// ============================================
// DARTBOARD WHEEL (concentric ring SVG)
// ============================================
function DartboardWheel({ treasuryBalance = 0 }: { treasuryBalance?: number }) {
    const size = 360;
    const center = size / 2;
    const outerRadius = size / 2 - 20;
    const hubRadius = 40;
    const numRings = WHEEL_CONFIG.length;
    const ringWidth = (outerRadius - hubRadius) / numRings;

    const createArcPath = (
        cx: number, cy: number,
        innerR: number, outerR: number,
        startAngle: number, endAngle: number
    ): string => {
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
        const x1O = cx + outerR * Math.cos(startRad);
        const y1O = cy + outerR * Math.sin(startRad);
        const x2O = cx + outerR * Math.cos(endRad);
        const y2O = cy + outerR * Math.sin(endRad);
        const x1I = cx + innerR * Math.cos(endRad);
        const y1I = cy + innerR * Math.sin(endRad);
        const x2I = cx + innerR * Math.cos(startRad);
        const y2I = cy + innerR * Math.sin(startRad);
        const largeArc = endAngle - startAngle > 180 ? 1 : 0;
        return `M ${x1O} ${y1O} A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2O} ${y2O} L ${x1I} ${y1I} A ${innerR} ${innerR} 0 ${largeArc} 0 ${x2I} ${y2I} Z`;
    };

    const stars: React.ReactNode[] = [];
    for (let i = 0; i < 80; i++) {
        const angle = Math.random() * 360;
        const distance = hubRadius + Math.random() * (outerRadius - hubRadius);
        const rad = (angle - 90) * (Math.PI / 180);
        const x = center + distance * Math.cos(rad);
        const y = center + distance * Math.sin(rad);
        const starSize = 0.3 + Math.random() * 1.2;
        const opacity = 0.3 + Math.random() * 0.7;
        stars.push(<circle key={`star-${i}`} cx={x} cy={y} r={starSize} fill="white" opacity={opacity} />);
    }

    const segments: React.ReactNode[] = [];
    let cumulativeAngle = 0;
    WHEEL_CONFIG.forEach((tier, ringIndex) => {
        const reversedIndex = numRings - 1 - ringIndex;
        const ringOuterR = outerRadius - reversedIndex * ringWidth;
        const ringInnerR = outerRadius - (reversedIndex + 1) * ringWidth;
        const tierAngle = (tier.percent / TOTAL_PERCENT) * 360;
        const colorStart = cumulativeAngle;
        const colorEnd = cumulativeAngle + tierAngle;

        if (colorStart > 0.01)
            segments.push(<path key={`space-before-${ringIndex}`} d={createArcPath(center, center, ringInnerR, ringOuterR, 0, colorStart)} fill={SPACE_COLOR} stroke="#1a1a2e" strokeWidth="0.5" />);
        segments.push(<path key={`color-${ringIndex}`} d={createArcPath(center, center, ringInnerR, ringOuterR, colorStart, colorEnd)} fill={`url(#lg-${ringIndex})`} stroke={tier.color} strokeWidth="1" style={{ filter: `drop-shadow(0 0 ${4 + (numRings - ringIndex) * 2}px ${tier.glowColor})` }} />);
        if (colorEnd < 359.99)
            segments.push(<path key={`space-after-${ringIndex}`} d={createArcPath(center, center, ringInnerR, ringOuterR, colorEnd, 360)} fill={SPACE_COLOR} stroke="#1a1a2e" strokeWidth="0.5" />);
        cumulativeAngle += tierAngle;
    });

    return (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <defs>
                {WHEEL_CONFIG.map((tier, idx) => (
                    <linearGradient key={`lg-${idx}`} id={`lg-${idx}`} x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor={tier.gradient.match(/#[a-f0-9]{6}/gi)?.[0] || tier.color} />
                        <stop offset="50%" stopColor={tier.gradient.match(/#[a-f0-9]{6}/gi)?.[1] || tier.color} />
                        <stop offset="100%" stopColor={tier.gradient.match(/#[a-f0-9]{6}/gi)?.[2] || tier.color} />
                    </linearGradient>
                ))}
                <radialGradient id="cosmicBg2" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#1a1a3e" />
                    <stop offset="70%" stopColor="#0f0f1a" />
                    <stop offset="100%" stopColor="#050510" />
                </radialGradient>
            </defs>
            <circle cx={center} cy={center} r={outerRadius + 5} fill="url(#cosmicBg2)" />
            <circle cx={center} cy={center} r={outerRadius + 12} fill="none" stroke="#fbbf24" strokeWidth="2" opacity="0.2" />
            <circle cx={center} cy={center} r={outerRadius + 8} fill="none" stroke="#a855f7" strokeWidth="1.5" opacity="0.3" />
            <circle cx={center} cy={center} r={outerRadius + 4} fill="none" stroke="#06b6d4" strokeWidth="1" opacity="0.4" />
            {stars}
            {segments}
            {WHEEL_CONFIG.map((_t, idx) => {
                const rIdx = numRings - 1 - idx;
                return <circle key={`sep-${idx}`} cx={center} cy={center} r={outerRadius - (rIdx + 1) * ringWidth} fill="none" stroke="#2a2a4e" strokeWidth="1.5" opacity="0.8" />;
            })}
            {/* Arc text reward labels */}
            {WHEEL_CONFIG.map((tier, idx) => {
                const rIdx = numRings - 1 - idx;
                const ringMidR = outerRadius - rIdx * ringWidth - ringWidth / 2;
                const solValue = tier.reward > 0 ? (treasuryBalance * tier.reward / 100) : 0;
                const rewardText = `${solValue.toFixed(4)} SOL`;
                const startA = 240, endA = 120;
                const startRad = (startA - 90) * (Math.PI / 180);
                const endRad = (endA - 90) * (Math.PI / 180);
                const x1 = center + ringMidR * Math.cos(startRad);
                const y1 = center + ringMidR * Math.sin(startRad);
                const x2 = center + ringMidR * Math.cos(endRad);
                const y2 = center + ringMidR * Math.sin(endRad);
                const apId = `live-arc-${idx}`;
                return (
                    <g key={`label-${idx}`}>
                        <defs><path id={apId} d={`M ${x1} ${y1} A ${ringMidR} ${ringMidR} 0 0 0 ${x2} ${y2}`} fill="none" /></defs>
                        <text fill={tier.color} fontSize="10" fontWeight="700" style={{ textShadow: `0 0 6px ${tier.color}, 0 0 12px ${tier.glowColor}` }}>
                            <textPath href={`#${apId}`} startOffset="50%" textAnchor="middle">{rewardText}</textPath>
                        </text>
                    </g>
                );
            })}
            {/* Hub */}
            <circle cx={center} cy={center} r={hubRadius + 2} fill="none" stroke="#a855f7" strokeWidth="2" opacity="0.5" />
            <circle cx={center} cy={center} r={hubRadius} fill="url(#cosmicBg2)" stroke="#fbbf24" strokeWidth="2" />
            <text x={center} y={center - 6} textAnchor="middle" fill="#fbbf24" fontSize="10" fontWeight="800">GALAXY</text>
            <text x={center} y={center + 8} textAnchor="middle" fill="#a855f7" fontSize="10" fontWeight="800">WHEEL</text>
        </svg>
    );
}

// ============================================
// STATUS BANNER COMPONENT
// ============================================
function StatusBanner({ rpcStatus, fetchError }: { rpcStatus?: RpcStatusInfo; fetchError?: string }) {
    if (fetchError) {
        return (
            <div style={{
                background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
                borderRadius: '8px', padding: '12px 16px', margin: '0 16px 12px 16px',
                display: 'flex', alignItems: 'center', gap: '10px',
            }}>
                <span style={{ fontSize: '18px' }}>🔴</span>
                <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#ef4444' }}>Backend Unreachable</div>
                    <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>{fetchError}</div>
                </div>
            </div>
        );
    }

    if (!rpcStatus) return null;

    if (!rpcStatus.online || rpcStatus.consecutiveFailures > 0) {
        const timeSinceError = rpcStatus.lastErrorTime ? formatTimeAgo(rpcStatus.lastErrorTime) : 'unknown';
        const timeSinceSuccess = rpcStatus.lastSuccess ? formatTimeAgo(rpcStatus.lastSuccess) : 'never';
        return (
            <div style={{
                background: rpcStatus.online ? 'rgba(245,158,11,0.12)' : 'rgba(239,68,68,0.12)',
                border: `1px solid ${rpcStatus.online ? 'rgba(245,158,11,0.3)' : 'rgba(239,68,68,0.25)'}`,
                borderRadius: '8px', padding: '12px 16px', margin: '0 16px 12px 16px',
                display: 'flex', alignItems: 'center', gap: '10px',
            }}>
                <span style={{ fontSize: '18px' }}>{rpcStatus.online ? '🟡' : '🔴'}</span>
                <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: rpcStatus.online ? '#f59e0b' : '#ef4444' }}>
                        {rpcStatus.online ? 'RPC Degraded' : 'RPC Offline'}
                        <span style={{ fontSize: '11px', fontWeight: 400, color: '#64748b', marginLeft: '8px' }}>
                            {rpcStatus.consecutiveFailures} consecutive failure{rpcStatus.consecutiveFailures !== 1 ? 's' : ''}
                        </span>
                    </div>
                    <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
                        {rpcStatus.lastError}
                    </div>
                    <div style={{ fontSize: '10px', color: '#475569', marginTop: '2px' }}>
                        Last error: {timeSinceError} · Last success: {timeSinceSuccess}
                    </div>
                </div>
            </div>
        );
    }

    return null;
}

// ============================================
// LIVE VIEWER APP
// ============================================
function LiveViewer() {
    const [liveState, setLiveState] = useState<LiveState | null>(null);
    const [fetchError, setFetchError] = useState<string>('');
    const [sseConnected, setSseConnected] = useState(false);
    const [lastSseError, setLastSseError] = useState('');
    const [isSpinning, setIsSpinning] = useState(false);
    const [spinResult, setSpinResult] = useState<any>(null);
    const [recentSpins, setRecentSpins] = useState<any[]>([]);
    const [pointerRotation, setPointerRotation] = useState(0);
    const [currentSpinWallet, setCurrentSpinWallet] = useState('');
    const [countdown, setCountdown] = useState(30);
    const animRef = useRef<number | null>(null);
    const spinStartRef = useRef(0);
    const constantStartRef = useRef(0);
    const phaseStartRef = useRef(0);
    const targetRotRef = useRef(0);

    type Phase = 'idle' | 'accelerating' | 'constant' | 'decel_1' | 'decel_2' | 'decel_3' | 'decel_4' | 'decel_5';
    const [spinPhase, setSpinPhase] = useState<Phase>('idle');

    const ACCEL_DURATION = 800;
    const BASE_SPEED = 720;
    const DECEL_SPEEDS = [540, 360, 180, 90, 36];
    const DECEL_STAGE_DURATIONS = [600, 600, 800, 1000, 0];

    const getTargetAngleForTier = (tierIndex: number): number => {
        const safeIndex = Math.max(0, Math.min(tierIndex, WHEEL_CONFIG.length - 1));
        let cum = 0;
        for (let i = 0; i < safeIndex; i++) cum += (WHEEL_CONFIG[i].percent / TOTAL_PERCENT) * 360;
        const tierAngle = (WHEEL_CONFIG[safeIndex].percent / TOTAL_PERCENT) * 360;
        return cum + tierAngle / 2 + (Math.random() - 0.5) * (tierAngle * 0.3);
    };

    const calculatePreFinalRotation = (): number => {
        let rot = 0;
        for (let i = 0; i < 4; i++) rot += DECEL_SPEEDS[i] * (DECEL_STAGE_DURATIONS[i] / 1000);
        return rot;
    };

    // Animation loop
    const animate = useCallback((timestamp: number) => {
        const elapsed = timestamp - spinStartRef.current;

        if (spinPhase === 'accelerating') {
            const progress = Math.min(elapsed / ACCEL_DURATION, 1);
            const easeIn = progress * progress;
            const rotation = constantStartRef.current + (easeIn * BASE_SPEED * (ACCEL_DURATION / 1000));
            setPointerRotation(rotation);
            if (progress >= 1) {
                setSpinPhase('constant');
                spinStartRef.current = timestamp;
                constantStartRef.current = rotation;
            }
        } else if (spinPhase === 'constant') {
            setPointerRotation(constantStartRef.current + (elapsed / 1000) * BASE_SPEED);
        } else if (spinPhase.startsWith('decel_')) {
            const stageNum = parseInt(spinPhase.split('_')[1]) - 1;
            const speed = DECEL_SPEEDS[stageNum];
            const duration = stageNum < 4 ? DECEL_STAGE_DURATIONS[stageNum] :
                Math.max(0, (targetRotRef.current - phaseStartRef.current) / speed * 1000);
            const progress = Math.min(elapsed / duration, 1);
            const rotation = phaseStartRef.current + (progress * speed * (duration / 1000));
            setPointerRotation(rotation);
            if (progress >= 1) {
                if (stageNum < 4) {
                    phaseStartRef.current = rotation;
                    spinStartRef.current = timestamp;
                    setSpinPhase(`decel_${stageNum + 2}` as Phase);
                } else {
                    setSpinPhase('idle');
                    setPointerRotation(targetRotRef.current);
                    setIsSpinning(false);
                    return;
                }
            }
        }
        if (spinPhase !== 'idle') animRef.current = requestAnimationFrame(animate);
    }, [spinPhase]);

    useEffect(() => {
        if (spinPhase !== 'idle' && animRef.current === null) {
            spinStartRef.current = performance.now();
            animRef.current = window.requestAnimationFrame(animate);
        }
        return () => { if (animRef.current) { window.cancelAnimationFrame(animRef.current); animRef.current = null; } };
    }, [spinPhase, animate]);

    const startSpinToTier = (tierIndex: number) => {
        setIsSpinning(true);
        setSpinResult(null);
        constantStartRef.current = pointerRotation;
        spinStartRef.current = performance.now();
        setSpinPhase('accelerating');

        const target = getTargetAngleForTier(tierIndex);
        const preFinal = calculatePreFinalRotation();
        const baseTravel = pointerRotation + preFinal;
        const remainder = ((baseTravel % 360) + 360) % 360;
        const minFull = 3 + Math.floor(Math.random() * 2);
        const stage5Travel = ((target - remainder) % 360 + 360) % 360;
        targetRotRef.current = baseTravel + minFull * 360 + stage5Travel;

        setTimeout(() => {
            constantStartRef.current = pointerRotation + BASE_SPEED * (ACCEL_DURATION / 1000);
            phaseStartRef.current = constantStartRef.current;
            setSpinPhase('decel_1');
            spinStartRef.current = performance.now();
        }, ACCEL_DURATION + 500);
    };

    // Fetch initial live state
    useEffect(() => {
        const fetchLive = () => {
            fetch('/api/wheel/live')
                .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
                .then((data: any) => {
                    setLiveState(data);
                    setRecentSpins(data.recentSpins || []);
                    setFetchError('');
                })
                .catch((e: any) => {
                    setFetchError(e.message || 'Failed to connect to backend');
                });
        };

        fetchLive();
        const interval = setInterval(fetchLive, 15000);
        return () => clearInterval(interval);
    }, []);

    // SSE subscription
    useEffect(() => {
        const eventSource = new EventSource('/api/wheel/events');

        eventSource.onopen = () => {
            setSseConnected(true);
            setLastSseError('');
        };

        eventSource.onerror = () => {
            setSseConnected(false);
            setLastSseError('SSE connection lost');
        };

        eventSource.addEventListener('spinning', (event: any) => {
            const data = JSON.parse(event.data);
            setCurrentSpinWallet(data.walletShort || '');
            startSpinToTier(2);
            setCountdown(30);
        });

        eventSource.addEventListener('spin', (event: any) => {
            const data = JSON.parse(event.data);
            setSpinResult(data);
            setRecentSpins((prev: any[]) => [data, ...prev].slice(0, 20));
            setCurrentSpinWallet('');
            setCountdown(30);

            setLiveState((prev: LiveState | null) => prev ? {
                ...prev,
                currentIndex: (prev.currentIndex + 1) % Math.max(prev.totalHolders, 1),
                stats: {
                    ...prev.stats,
                    totalSpins: prev.stats.totalSpins + 1,
                    totalDistributed: prev.stats.totalDistributed + (data.rewardAmount || 0),
                    totalDistributedFormatted: ((prev.stats.totalDistributed + (data.rewardAmount || 0)) / 1e9).toFixed(4) + ' SOL',
                },
            } : prev);
        });

        eventSource.addEventListener('error', (event: any) => {
            try {
                const data = JSON.parse(event.data);
                setLastSseError(data.message || 'Unknown error');
                // Update rpcStatus in liveState
                setLiveState((prev: LiveState | null) => prev ? {
                    ...prev,
                    rpcStatus: { ...prev.rpcStatus, online: false, lastError: data.message, lastErrorTime: data.timestamp, consecutiveFailures: prev.rpcStatus.consecutiveFailures + 1 },
                } : prev);
            } catch { }
        });

        return () => eventSource.close();
    }, []);

    // Countdown timer
    useEffect(() => {
        const interval = setInterval(() => setCountdown((p: number) => Math.max(0, p - 1)), 1000);
        return () => clearInterval(interval);
    }, []);

    const treasurySOL = liveState ? liveState.stats.poolBalance / 1e9 : 0;
    const rpcStatus = liveState?.rpcStatus;
    const isRpcOk = rpcStatus?.online !== false && !fetchError;

    return (
        <div style={{
            minHeight: '100vh',
            background: 'linear-gradient(135deg, #0a0a1a 0%, #0d1117 50%, #0a0a2e 100%)',
            color: 'white',
            fontFamily: "'Inter', -apple-system, sans-serif",
            overflow: 'hidden',
        }}>
            {/* Header */}
            <div style={{
                padding: '12px 24px',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: 'rgba(0,0,0,0.3)',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{ fontSize: '24px' }}>🌀</span>
                    <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 700, letterSpacing: '-0.02em' }}>
                        Galaxy Wheel <span style={{ color: '#64748b', fontWeight: 400, fontSize: '14px' }}>LIVE</span>
                    </h1>
                    {/* Connection status */}
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 10px', borderRadius: '12px',
                        background: isRpcOk
                            ? (liveState?.autoSpinEnabled ? 'rgba(34,197,94,0.15)' : 'rgba(245,158,11,0.15)')
                            : 'rgba(239,68,68,0.15)',
                        border: `1px solid ${isRpcOk
                            ? (liveState?.autoSpinEnabled ? 'rgba(34,197,94,0.3)' : 'rgba(245,158,11,0.3)')
                            : 'rgba(239,68,68,0.3)'}`,
                    }}>
                        <div style={{
                            width: '6px', height: '6px', borderRadius: '50%',
                            background: isRpcOk ? (liveState?.autoSpinEnabled ? '#22c55e' : '#f59e0b') : '#ef4444',
                            animation: isRpcOk && liveState?.autoSpinEnabled ? 'pulse 2s infinite' : 'none',
                        }} />
                        <span style={{ fontSize: '11px', fontWeight: 600, color: isRpcOk ? (liveState?.autoSpinEnabled ? '#22c55e' : '#f59e0b') : '#ef4444' }}>
                            {fetchError ? 'OFFLINE' : !rpcStatus?.online ? 'RPC DOWN' : liveState?.autoSpinEnabled ? 'LIVE' : 'PAUSED'}
                        </span>
                    </div>
                    {/* SSE indicator */}
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: '4px', padding: '2px 8px', borderRadius: '8px',
                        background: sseConnected ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                    }}>
                        <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: sseConnected ? '#22c55e' : '#ef4444' }} />
                        <span style={{ fontSize: '10px', color: sseConnected ? '#22c55e' : '#ef4444' }}>SSE</span>
                    </div>
                </div>
                <div style={{ display: 'flex', gap: '24px', fontSize: '12px', color: '#94a3b8' }}>
                    <div><span style={{ color: '#64748b' }}>Spins </span><span style={{ color: '#e2e8f0', fontWeight: 600 }}>{liveState?.stats.totalSpins || 0}</span></div>
                    <div><span style={{ color: '#64748b' }}>Distributed </span><span style={{ color: '#22c55e', fontWeight: 600 }}>{liveState?.stats.totalDistributedFormatted || '—'}</span></div>
                    <div>
                        <span style={{ color: '#64748b' }}>Treasury </span>
                        <span style={{ color: rpcStatus?.poolFetched ? '#f59e0b' : '#ef4444', fontWeight: 600 }}>
                            {rpcStatus?.poolFetched ? `${treasurySOL.toFixed(4)} SOL` : '⚠ unavailable'}
                        </span>
                    </div>
                </div>
            </div>

            {/* Error/Status Banner */}
            <StatusBanner rpcStatus={rpcStatus} fetchError={fetchError} />

            {/* Main layout */}
            <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr 320px', height: `calc(100vh - 49px ${(fetchError || (rpcStatus && !rpcStatus.online)) ? '- 60px' : ''})`, gap: '0' }}>
                {/* Left: Queue */}
                <div style={{ borderRight: '1px solid rgba(255,255,255,0.06)', padding: '16px', overflowY: 'auto' }}>
                    <h3 style={{ margin: '0 0 12px 0', fontSize: '13px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Holder Queue ({liveState?.totalHolders || 0})
                    </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {(liveState?.queue || []).map((holder) => {
                            const isCurrent = holder.position === liveState?.currentIndex;
                            return (
                                <div key={holder.wallet} style={{
                                    padding: '10px 12px', borderRadius: '8px',
                                    background: isCurrent ? (isSpinning ? 'rgba(245,158,11,0.15)' : 'rgba(59,130,246,0.12)') : 'rgba(255,255,255,0.02)',
                                    border: isCurrent ? `1px solid ${isSpinning ? 'rgba(245,158,11,0.3)' : 'rgba(59,130,246,0.2)'}` : '1px solid transparent',
                                    transition: 'all 0.3s ease',
                                }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <span style={{ fontSize: '11px', fontWeight: 700, color: isCurrent ? '#f59e0b' : '#475569', width: '20px' }}>
                                                #{holder.position + 1}
                                            </span>
                                            <span style={{ fontFamily: 'monospace', fontSize: '12px', color: isCurrent ? '#e2e8f0' : '#94a3b8' }}>
                                                {holder.walletShort}
                                            </span>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                            {holder.totalWinnings > 0 && (
                                                <span style={{ fontSize: '10px', color: '#22c55e' }}>
                                                    {(holder.totalWinnings / 1e9).toFixed(3)} SOL
                                                </span>
                                            )}
                                            {isCurrent && isSpinning && (
                                                <span style={{ fontSize: '10px', fontWeight: 700, color: '#f59e0b', animation: 'pulse 1s infinite' }}>
                                                    SPINNING
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    {isCurrent && (
                                        <div style={{ marginTop: '6px', display: 'flex', gap: '2px' }}>
                                            {WHEEL_CONFIG.map((tier, pi) => (
                                                <div key={pi} style={{
                                                    flex: holder.probabilities?.[pi] || WHEEL_CONFIG[pi].percent,
                                                    height: '3px', borderRadius: '2px',
                                                    background: tier.color, opacity: 0.8,
                                                }} />
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                        {(liveState?.queue || []).length === 0 && (
                            <div style={{ color: '#475569', fontSize: '13px', textAlign: 'center', padding: '32px 0' }}>
                                {fetchError ? '⚠ Cannot load queue' : 'No holders in queue'}
                            </div>
                        )}
                    </div>
                </div>

                {/* Center: Wheel + Timer */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
                    {/* Status / Countdown */}
                    <div style={{ marginBottom: '16px', textAlign: 'center' }}>
                        {fetchError ? (
                            <div style={{ fontSize: '16px', fontWeight: 600, color: '#ef4444' }}>
                                🔴 Backend Unreachable
                                <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 400, marginTop: '4px' }}>{fetchError}</div>
                            </div>
                        ) : !rpcStatus?.online && rpcStatus?.lastError ? (
                            <div style={{ fontSize: '14px', fontWeight: 600, color: '#ef4444' }}>
                                ⚠ RPC Error
                                <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 400, marginTop: '4px' }}>{rpcStatus.lastError}</div>
                                <div style={{ fontSize: '10px', color: '#475569', marginTop: '2px' }}>Retrying every 30s...</div>
                            </div>
                        ) : isSpinning ? (
                            <div style={{ fontSize: '16px', fontWeight: 700, color: '#f59e0b', animation: 'pulse 1s infinite' }}>
                                ✨ Spinning for {currentSpinWallet || '...'}
                            </div>
                        ) : spinResult ? (
                            <div style={{ fontSize: '14px', color: '#94a3b8' }}>
                                Last: <span style={{ color: WHEEL_CONFIG[spinResult.tier || 0]?.color, fontWeight: 700 }}>
                                    {TIER_EMOJIS[spinResult.tier || 0]} {spinResult.tierName}
                                </span> — {spinResult.rewardFormatted}
                            </div>
                        ) : (
                            <div>
                                <div style={{ fontSize: '42px', fontWeight: 800, fontFamily: 'monospace', color: '#e2e8f0', letterSpacing: '-0.02em' }}>
                                    {String(Math.floor(countdown / 60)).padStart(2, '0')}:{String(countdown % 60).padStart(2, '0')}
                                </div>
                                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>until next spin</div>
                            </div>
                        )}
                    </div>

                    {/* Wheel with rotating pointer */}
                    <div style={{ position: 'relative', width: '360px', height: '360px', opacity: fetchError ? 0.4 : 1, transition: 'opacity 0.5s' }}>
                        <div style={{
                            position: 'absolute', top: '50%', left: '50%',
                            transform: 'translate(-50%, -50%)',
                            borderRadius: '50%',
                            boxShadow: '0 0 60px rgba(168,85,247,0.3), inset 0 0 40px rgba(0,0,0,0.6)',
                        }}>
                            <DartboardWheel treasuryBalance={treasurySOL} />
                        </div>
                        <div style={{
                            position: 'absolute', top: '50%', left: '50%',
                            width: '360px', height: '360px',
                            transform: `translate(-50%, -50%) rotate(${pointerRotation}deg)`,
                            zIndex: 30, pointerEvents: 'none',
                        }}>
                            <div style={{
                                position: 'absolute', top: '-12px', left: '50%',
                                transform: 'translateX(-50%)',
                                width: '20px', height: '20px', borderRadius: '50%',
                                background: 'radial-gradient(circle at 30% 30%, #fff, #fbbf24)',
                                boxShadow: '0 0 20px rgba(251,191,36,1), 0 0 40px rgba(255,183,0,0.8), inset 0 0 5px rgba(255,255,255,0.5)',
                                border: '2px solid #fff',
                            }} />
                        </div>
                        {isSpinning && (
                            <div style={{
                                position: 'absolute', top: '50%', left: '50%',
                                width: '4px', height: '180px',
                                background: 'linear-gradient(to top, transparent 0%, #fbbf24 100%)',
                                transform: `translate(-50%, -100%) rotate(${pointerRotation}deg)`,
                                transformOrigin: 'bottom center',
                                zIndex: 25, animation: 'rayShoot 0.4s ease-out forwards',
                                boxShadow: '0 0 20px #fbbf24',
                            }} />
                        )}
                    </div>

                    {/* Tier Legend */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', marginTop: '16px' }}>
                        {WHEEL_CONFIG.map((tier, i) => (
                            <div key={i} style={{
                                display: 'flex', alignItems: 'center', gap: '12px', padding: '4px 16px',
                                borderRadius: '6px', width: '200px',
                                background: spinResult?.tier === i ? `${tier.color}33` : 'transparent',
                                border: spinResult?.tier === i ? `1px solid ${tier.color}` : '1px solid transparent',
                                transition: 'all 0.3s ease',
                            }}>
                                <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: tier.color, boxShadow: `0 0 6px ${tier.color}80` }} />
                                <span style={{ fontSize: '11px', fontWeight: 600, color: tier.color, width: '80px' }}>{tier.label}</span>
                                <span style={{ fontSize: '10px', color: '#64748b' }}>{tier.percent}%</span>
                                <span style={{ fontSize: '10px', color: '#94a3b8', marginLeft: 'auto' }}>{tier.reward}%</span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Right: Results Feed */}
                <div style={{ borderLeft: '1px solid rgba(255,255,255,0.06)', padding: '16px', overflowY: 'auto' }}>
                    <h3 style={{ margin: '0 0 12px 0', fontSize: '13px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Recent Results
                    </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {recentSpins.length === 0 && (
                            <div style={{ color: '#475569', fontSize: '13px', textAlign: 'center', padding: '32px 0' }}>
                                {fetchError ? '⚠ Cannot load results' : !rpcStatus?.online ? '⚠ Waiting for RPC...' : 'Waiting for spins...'}
                            </div>
                        )}
                        {recentSpins.map((spin: any, i: number) => {
                            const tierIdx = spin.tier ?? spin.rewardTier ?? 0;
                            const tierColor = WHEEL_CONFIG[tierIdx]?.color || '#94a3b8';
                            return (
                                <div key={i} style={{
                                    padding: '10px 12px', borderRadius: '8px',
                                    background: i === 0 ? `${tierColor}15` : 'rgba(255,255,255,0.02)',
                                    border: i === 0 ? `1px solid ${tierColor}33` : '1px solid transparent',
                                    animation: i === 0 ? 'fadeIn 0.5s ease' : 'none',
                                }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <span style={{ fontFamily: 'monospace', fontSize: '12px', color: '#94a3b8' }}>
                                            {spin.walletShort || (spin.wallet?.slice(0, 4) + '...' + spin.wallet?.slice(-4))}
                                        </span>
                                        <span style={{ fontSize: '11px', color: '#475569' }}>{formatTimeAgo(spin.timestamp)}</span>
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                                        <span style={{ fontSize: '12px', fontWeight: 600, color: tierColor }}>
                                            {TIER_EMOJIS[tierIdx]} {spin.tierName}
                                        </span>
                                        <span style={{ fontSize: '12px', fontWeight: 600, color: '#22c55e' }}>
                                            {spin.rewardFormatted || ((spin.rewardAmount / 1e9).toFixed(4) + ' SOL')}
                                        </span>
                                    </div>
                                    {spin.txSignature && (
                                        <a href={`https://solscan.io/tx/${spin.txSignature}`} target="_blank" rel="noopener noreferrer"
                                            style={{ fontSize: '10px', color: '#3b82f6', textDecoration: 'none', marginTop: '2px', display: 'inline-block' }}>
                                            tx: {spin.txSignature.slice(0, 12)}...
                                        </a>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {/* Error log at bottom */}
                    {lastSseError && (
                        <div style={{
                            marginTop: '16px', padding: '10px 12px', borderRadius: '8px',
                            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)',
                        }}>
                            <div style={{ fontSize: '11px', fontWeight: 600, color: '#ef4444' }}>Latest Error</div>
                            <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '2px' }}>{lastSseError}</div>
                        </div>
                    )}
                </div>
            </div>

            <style>{`
                @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
                @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
                @keyframes rayShoot { from { opacity: 0; height: 0; } to { opacity: 1; height: 180px; } }
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
                ::-webkit-scrollbar { width: 4px; }
                ::-webkit-scrollbar-track { background: transparent; }
                ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
            `}</style>
        </div>
    );
}

function formatTimeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 0) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

const root = createRoot(document.getElementById('root')!);
root.render(<LiveViewer />);
