import React, { useState } from 'react';
import { Wheel } from 'react-custom-roulette';

// Wheel tier configuration
interface WheelTier {
    label: string;
    color: string;
    percent: number;
    reward: number;
    image: string;
}

const WHEEL_CONFIG: WheelTier[] = [
    { label: "NOTHING", color: "#334155", percent: 10, reward: 0, image: "/assets/coins_nothing.png" },
    { label: "1%", color: "#10b981", percent: 75, reward: 1, image: "/assets/coins_1_percent.png" },
    { label: "10%", color: "#3b82f6", percent: 14, reward: 10, image: "/assets/coins_10_percent.png" },
    { label: "50%", color: "#f59e0b", percent: 1, reward: 50, image: "/assets/coins_50_percent.png" },
];

// Build wheel data
const buildWheelData = () => {
    const data: { option: string; style: { backgroundColor: string; textColor: string }; image?: { uri: string; sizeMultiplier?: number; offsetY?: number } }[] = [];
    const tierIndices: number[] = [];

    WHEEL_CONFIG.forEach((tier, tierIndex) => {
        for (let i = 0; i < tier.percent; i++) {
            data.push({
                option: '',
                style: {
                    backgroundColor: tier.color,
                    textColor: 'white',
                },
                image: {
                    uri: tier.image,
                    sizeMultiplier: 0.5,
                    offsetY: 100,
                },
            });
            tierIndices.push(tierIndex);
        }
    });

    return { data, tierIndices };
};

const { data: wheelData, tierIndices } = buildWheelData();
const TOTAL_SEGMENTS = wheelData.length;

export const WheelDemo: React.FC = () => {
    const treasuryBalance = 2.5;

    const [result, setResult] = useState<WheelTier | null>(null);
    const [prizeNumber, setPrizeNumber] = useState(0);
    const [mustSpin, setMustSpin] = useState(false);

    const getSegmentForTier = (tier: number): number => {
        const segments: number[] = [];
        tierIndices.forEach((t, idx) => {
            if (t === tier) segments.push(idx);
        });
        return segments[Math.floor(Math.random() * segments.length)];
    };

    const handleSpin = () => {
        if (mustSpin) return;
        setResult(null);

        const r = Math.random() * TOTAL_SEGMENTS;
        let cumulative = 0;
        let selectedTier = 0;
        for (let i = 0; i < WHEEL_CONFIG.length; i++) {
            cumulative += WHEEL_CONFIG[i].percent;
            if (r < cumulative) {
                selectedTier = i;
                break;
            }
        }

        const segment = getSegmentForTier(selectedTier);
        setPrizeNumber(segment);
        setMustSpin(true);
    };

    const handleStopSpinning = () => {
        setMustSpin(false);
        const winningTier = tierIndices[prizeNumber];
        setResult(WHEEL_CONFIG[winningTier]);
    };

    return (
        <div style={{
            minHeight: '100vh',
            background: 'linear-gradient(180deg, #0f172a 0%, #020617 100%)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            padding: '40px',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            color: 'white'
        }}>
            <div style={{
                background: 'rgba(15, 23, 42, 0.8)',
                padding: '40px',
                borderRadius: '24px',
                border: '1px solid rgba(251,191,36,0.3)',
                textAlign: 'center',
                boxShadow: '0 25px 100px rgba(0,0,0,0.5)'
            }}>
                {/* Jackpot */}
                <div style={{
                    display: 'inline-flex',
                    flexDirection: 'column',
                    background: 'rgba(251,191,36,0.1)',
                    border: '1px solid rgba(251,191,36,0.3)',
                    padding: '16px 32px',
                    borderRadius: '16px',
                    marginBottom: '24px'
                }}>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: '#fbbf24', letterSpacing: '2px' }}>
                        🏆 JACKPOT POOL
                    </span>
                    <span style={{ fontSize: '32px', fontWeight: 800, color: '#fbbf24', textShadow: '0 0 30px rgba(251,191,36,0.5)' }}>
                        {treasuryBalance.toFixed(4)} SOL
                    </span>
                    <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', marginTop: '8px', fontSize: '12px', fontWeight: 600 }}>
                        {WHEEL_CONFIG.filter(t => t.reward > 0).map((tier, i) => (
                            <span key={i} style={{ color: tier.color }}>
                                {tier.percent}% → {((treasuryBalance * tier.reward) / 100).toFixed(3)} SOL
                            </span>
                        ))}
                    </div>
                </div>

                {/* Wheel */}
                <div style={{ position: 'relative', width: '450px', height: '450px', margin: '0 auto 28px' }}>
                    <Wheel
                        mustStartSpinning={mustSpin}
                        prizeNumber={prizeNumber}
                        data={wheelData}
                        onStopSpinning={handleStopSpinning}
                        backgroundColors={WHEEL_CONFIG.map(t => t.color)}
                        textColors={['white']}
                        outerBorderColor="#1e293b"
                        outerBorderWidth={10}
                        innerBorderColor="#fbbf24"
                        innerBorderWidth={5}
                        innerRadius={12}
                        radiusLineColor="#0f172a"
                        radiusLineWidth={1}
                        spinDuration={0.6}
                        pointerProps={{
                            style: { display: 'none' }
                        }}
                    />

                    {/* Pointer */}
                    <div style={{
                        position: 'absolute',
                        top: '-12px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        fontSize: '42px',
                        color: '#fbbf24',
                        textShadow: '0 4px 12px rgba(0,0,0,0.8)',
                        zIndex: 20,
                        filter: 'drop-shadow(0 0 10px rgba(251,191,36,0.6))'
                    }}>▼</div>

                    {/* Center */}
                    <div style={{
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '90px',
                        height: '90px',
                        background: '#0f172a',
                        border: '4px solid #fbbf24',
                        borderRadius: '50%',
                        zIndex: 10,
                        boxShadow: '0 0 20px rgba(251,191,36,0.3)'
                    }}>
                        <span style={{ fontSize: '12px', fontWeight: 800, color: '#fbbf24' }}>GALAXY</span>
                        <span style={{ fontSize: '12px', fontWeight: 800, color: '#fbbf24' }}>WHEEL</span>
                    </div>
                </div>

                {/* Result */}
                {result && (
                    <div style={{
                        padding: '16px 32px',
                        borderRadius: '12px',
                        marginBottom: '20px',
                        fontWeight: 700,
                        fontSize: '20px',
                        border: `2px solid ${result.color}`,
                        background: result.reward > 0 ? 'rgba(16, 185, 129, 0.15)' : 'rgba(100, 116, 139, 0.15)',
                        color: result.reward > 0 ? '#10b981' : '#64748b'
                    }}>
                        {result.reward > 0
                            ? `🎉 You won ${result.reward}% = ${((treasuryBalance * result.reward) / 100).toFixed(4)} SOL!`
                            : '😔 Better luck next time!'}
                    </div>
                )}

                {/* Button */}
                <button
                    onClick={handleSpin}
                    disabled={mustSpin}
                    style={{
                        background: mustSpin
                            ? 'linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)'
                            : 'linear-gradient(135deg, #fbbf24 0%, #d97706 100%)',
                        border: 'none',
                        borderRadius: '50px',
                        padding: '18px 56px',
                        color: 'white',
                        fontSize: '20px',
                        fontWeight: 800,
                        cursor: mustSpin ? 'not-allowed' : 'pointer',
                        boxShadow: mustSpin
                            ? '0 4px 24px rgba(139,92,246,0.4)'
                            : '0 4px 24px rgba(251,191,36,0.4)',
                        transition: 'all 0.2s',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        margin: '0 auto',
                        opacity: mustSpin ? 0.8 : 1
                    }}
                >
                    {mustSpin ? '✨ SPINNING...' : '🎰 DEMO SPIN'}
                    <span style={{ fontSize: '12px', opacity: 0.9, marginTop: '4px' }}>No transaction required</span>
                </button>

                {/* Segment count info */}
                <div style={{ marginTop: '24px', fontSize: '12px', color: '#64748b' }}>
                    Total segments: {TOTAL_SEGMENTS} (
                    {WHEEL_CONFIG.map((t, i) => `${t.percent}× ${t.label}`).join(' + ')})
                </div>
            </div>
        </div>
    );
};

export default WheelDemo;
