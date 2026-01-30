import React, { useState } from 'react';
import { Wheel } from 'react-custom-roulette';

// Wheel tier configuration
// 4 tiers matching on-chain configuration exactly:
// On-chain: probabilities [1000, 7500, 1400, 100] = [10%, 75%, 14%, 1%]
// On-chain: reward_bps [0, 100, 1000, 5000] = [0%, 1%, 10%, 50%]
interface WheelTier {
    label: string;
    color: string;
    percent: number;  // This becomes the number of segments (1% = 1 segment, etc.)
    reward: number;   // Percentage of treasury to win
    image: string;    // Coin stack image
}

const WHEEL_CONFIG: WheelTier[] = [
    { label: "VOID", color: "#475569", percent: 10, reward: 0, image: "/assets/coins_nothing.png" },
    { label: "METEOR", color: "#3b82f6", percent: 75, reward: 1, image: "/assets/coins_1_percent.png" },
    { label: "NEBULA", color: "#a855f7", percent: 14, reward: 10, image: "/assets/coins_10_percent.png" },
    { label: "SUPERNOVA", color: "#fbbf24", percent: 1, reward: 50, image: "/assets/coins_50_percent.png" },
];


interface GalaxyWheelProps {
    available: number;
    spinning: boolean;
    onSpin: () => void;
    targetTier?: number | null;
    onSpinFinish?: () => void;
    isAdmin?: boolean;
    treasuryBalance?: number;
    onFundTreasury?: (amount: number) => void;
    spinCost: number;
}

// Build wheel data: each tier becomes multiple equal segments based on percent
const buildWheelData = () => {
    const data: { option: string; style: { backgroundColor: string; textColor: string }; image?: { uri: string; sizeMultiplier?: number; offsetY?: number } }[] = [];
    const tierIndices: number[] = []; // Maps segment index to tier index

    WHEEL_CONFIG.forEach((tier, tierIndex) => {
        // Create 'percent' number of segments for this tier
        for (let i = 0; i < tier.percent; i++) {
            data.push({
                option: '', // No text, we'll use images
                style: {
                    backgroundColor: tier.color,
                    textColor: 'white',
                },
                image: {
                    uri: tier.image,
                    sizeMultiplier: 0.6,
                    offsetY: 120,
                },
            });
            tierIndices.push(tierIndex);
        }
    });

    return { data, tierIndices };
};

const { data: wheelData, tierIndices } = buildWheelData();
const TOTAL_SEGMENTS = wheelData.length; // Should be 100 (10 + 75 + 14 + 1)

export const GalaxyWheelSection: React.FC<GalaxyWheelProps> = ({
    available, spinning, onSpin, targetTier, onSpinFinish, isAdmin, treasuryBalance, onFundTreasury, spinCost
}) => {
    const canSpin = available >= spinCost;

    // Demo mode
    const [demoActive, setDemoActive] = useState(false);
    const [demoTarget, setDemoTarget] = useState<number | null>(null);
    const [result, setResult] = useState<WheelTier | null>(null);

    const isSpinning = demoActive || spinning;
    const effectiveTarget = demoTarget ?? targetTier ?? null;

    // Map target tier to a random segment index within that tier
    const getSegmentForTier = (tier: number): number => {
        const segments: number[] = [];
        tierIndices.forEach((t, idx) => {
            if (t === tier) segments.push(idx);
        });
        return segments[Math.floor(Math.random() * segments.length)];
    };

    const [prizeNumber, setPrizeNumber] = useState(0);
    const [mustSpin, setMustSpin] = useState(false);

    // Handle demo spin
    const handleDemo = () => {
        if (isSpinning || mustSpin) return;
        setResult(null);
        setDemoActive(true);

        // Pick random tier (weighted by segment count)
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

    // Handle real spin
    const handleRealSpin = () => {
        if (!canSpin || isSpinning || mustSpin) return;
        setResult(null);
        onSpin();
    };

    // When spinning starts with a target tier
    React.useEffect(() => {
        if (effectiveTarget !== null && spinning && !mustSpin) {
            const segment = getSegmentForTier(effectiveTarget);
            setPrizeNumber(segment);
            setMustSpin(true);
        }
    }, [effectiveTarget, spinning, mustSpin]);

    // Handle spin complete
    const handleStopSpinning = () => {
        setMustSpin(false);
        const winningTier = tierIndices[prizeNumber];
        setResult(WHEEL_CONFIG[winningTier]);

        if (demoActive) {
            setDemoActive(false);
            setDemoTarget(null);
        } else if (onSpinFinish) {
            onSpinFinish();
        }
    };

    const [fundAmount, setFundAmount] = useState('1');

    return (
        <section className="wheel-section" id="wheel">
            {/* Jackpot Display + Legend */}
            {treasuryBalance !== undefined && (
                <div className="jackpot-box">
                    <span className="jackpot-label">🏆 JACKPOT POOL</span>
                    <span className="jackpot-value">{treasuryBalance.toFixed(4)} SOL</span>

                    {/* Clear Legend */}
                    <div className="wheel-legend">
                        <div className="legend-header">
                            <span>TIER</span>
                            <span>CHANCE</span>
                            <span>WIN</span>
                        </div>
                        {WHEEL_CONFIG.map((tier, i) => (
                            <div key={i} className="legend-row" style={{ borderLeft: `4px solid ${tier.color}` }}>
                                <span className="legend-tier" style={{ color: tier.color }}>{tier.label}</span>
                                <span className="legend-chance">{tier.percent}%</span>
                                <span className="legend-win">
                                    {tier.reward === 0
                                        ? '—'
                                        : `${((treasuryBalance * tier.reward) / 100).toFixed(4)} SOL`
                                    }
                                </span>
                            </div>
                        ))}
                    </div>

                    <div className="rules-note">
                        ✨ Spin costs 1,000 Stardust • Rewards paid from treasury pool
                    </div>
                </div>
            )}


            {/* Wheel */}
            <div className="wheel-container">
                <Wheel
                    mustStartSpinning={mustSpin}
                    prizeNumber={prizeNumber}
                    data={wheelData}
                    onStopSpinning={handleStopSpinning}
                    backgroundColors={WHEEL_CONFIG.map(t => t.color)}
                    textColors={['white']}
                    outerBorderColor="#1e293b"
                    outerBorderWidth={8}
                    innerBorderColor="#fbbf24"
                    innerBorderWidth={4}
                    innerRadius={15}
                    radiusLineColor="#0f172a"
                    radiusLineWidth={2}
                    spinDuration={0.8}
                    startingOptionIndex={0}
                    pointerProps={{
                        src: undefined,
                        style: { display: 'none' }
                    }}
                />
                <div className="wheel-pointer">▼</div>
                <div className="wheel-center">
                    <span>GALAXY</span>
                    <span>WHEEL</span>
                </div>
            </div>

            {/* Result */}
            {result && (
                <div className={`result-box ${result.reward > 0 ? 'win' : 'lose'}`} style={{ borderColor: result.color }}>
                    {result.reward > 0
                        ? `🎉 You won ${result.reward}% = ${treasuryBalance ? ((treasuryBalance * result.reward) / 100).toFixed(4) : '?'} SOL!`
                        : '😔 Better luck next time!'}
                </div>
            )}

            {/* Controls */}
            <div className="wheel-controls">
                <button
                    className={`btn-main ${isSpinning || mustSpin ? 'active' : ''}`}
                    onClick={handleRealSpin}
                    disabled={!canSpin || isSpinning || mustSpin}
                >
                    {isSpinning || mustSpin ? '✨ SPINNING...' : '🎰 SPIN WHEEL'}
                    <span className="btn-cost">{spinCost.toLocaleString()} STARDUST</span>
                </button>

                <button className="btn-demo" onClick={handleDemo} disabled={isSpinning || mustSpin}>
                    🎮 DEMO SPIN
                </button>

                {!canSpin && !isSpinning && !mustSpin && (
                    <p className="need-more">Need {(spinCost - available).toLocaleString()} more STARDUST</p>
                )}
            </div>

            {/* Admin Panel */}
            {isAdmin && onFundTreasury && (
                <div className="admin-panel">
                    <input type="number" value={fundAmount} onChange={e => setFundAmount(e.target.value)} />
                    <button onClick={() => onFundTreasury(parseFloat(fundAmount))}>Fund Treasury</button>
                </div>
            )}

            <style>{`
                .wheel-section {
                    background: linear-gradient(180deg, #0f172a 0%, #020617 100%);
                    padding: 40px 24px;
                    border-radius: 24px;
                    border: 1px solid rgba(251,191,36,0.2);
                    text-align: center;
                }
                
                .jackpot-box {
                    display: inline-flex;
                    flex-direction: column;
                    background: rgba(251,191,36,0.1);
                    border: 1px solid rgba(251,191,36,0.3);
                    padding: 16px 32px;
                    border-radius: 16px;
                    margin-bottom: 24px;
                }
                .jackpot-label { 
                    font-size: 12px; 
                    font-weight: 600; 
                    color: #fbbf24; 
                    letter-spacing: 2px; 
                }
                .jackpot-value { 
                    font-size: 32px; 
                    font-weight: 800; 
                    color: #fbbf24; 
                    text-shadow: 0 0 30px rgba(251,191,36,0.5); 
                }
                
                /* Legend Styles */
                .wheel-legend {
                    margin-top: 16px;
                    width: 100%;
                }
                .legend-header {
                    display: grid;
                    grid-template-columns: 1fr 80px 120px;
                    font-size: 10px;
                    font-weight: 600;
                    color: #64748b;
                    text-transform: uppercase;
                    letter-spacing: 1px;
                    padding: 8px 12px;
                    border-bottom: 1px solid rgba(255,255,255,0.1);
                }
                .legend-row {
                    display: grid;
                    grid-template-columns: 1fr 80px 120px;
                    padding: 10px 12px;
                    font-size: 13px;
                    background: rgba(0,0,0,0.2);
                    margin-top: 4px;
                    border-radius: 6px;
                }
                .legend-tier {
                    font-weight: 700;
                }
                .legend-chance {
                    color: #94a3b8;
                    text-align: center;
                }
                .legend-win {
                    color: #10b981;
                    font-weight: 600;
                    text-align: right;
                }
                .rules-note {
                    margin-top: 16px;
                    font-size: 11px;
                    color: #64748b;
                    text-align: center;
                }
                

                .wheel-container {
                    position: relative;
                    width: 400px;
                    height: 400px;
                    margin: 0 auto 28px;
                }
                
                .wheel-pointer {
                    position: absolute;
                    top: -12px;
                    left: 50%;
                    transform: translateX(-50%);
                    font-size: 36px;
                    color: #fbbf24;
                    text-shadow: 0 4px 12px rgba(0,0,0,0.8);
                    z-index: 20;
                    filter: drop-shadow(0 0 8px rgba(251,191,36,0.5));
                }
                
                .wheel-center {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    width: 80px;
                    height: 80px;
                    background: #0f172a;
                    border: 3px solid #fbbf24;
                    border-radius: 50%;
                    z-index: 10;
                }
                .wheel-center span {
                    font-size: 11px;
                    font-weight: 800;
                    color: #fbbf24;
                    line-height: 1.2;
                }
                
                .result-box {
                    padding: 16px 32px;
                    border-radius: 12px;
                    margin-bottom: 20px;
                    font-weight: 700;
                    font-size: 18px;
                    border: 2px solid;
                }
                .result-box.win {
                    background: rgba(16, 185, 129, 0.15);
                    color: #10b981;
                }
                .result-box.lose {
                    background: rgba(100, 116, 139, 0.15);
                    color: #64748b;
                }
                
                .wheel-controls {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 12px;
                }
                
                .btn-main {
                    background: linear-gradient(135deg, #fbbf24 0%, #d97706 100%);
                    border: none;
                    border-radius: 50px;
                    padding: 18px 56px;
                    color: white;
                    font-size: 20px;
                    font-weight: 800;
                    cursor: pointer;
                    box-shadow: 0 4px 24px rgba(251,191,36,0.4);
                    transition: all 0.2s;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                }
                .btn-main:hover:not(:disabled) { 
                    transform: translateY(-3px); 
                    box-shadow: 0 8px 36px rgba(251,191,36,0.5); 
                }
                .btn-main:disabled { 
                    opacity: 0.6; 
                    cursor: not-allowed; 
                }
                .btn-main.active { 
                    animation: pulse-btn 0.8s infinite; 
                }
                @keyframes pulse-btn { 
                    0%,100% { box-shadow: 0 4px 24px rgba(251,191,36,0.4); } 
                    50% { box-shadow: 0 4px 48px rgba(251,191,36,0.8); } 
                }
                .btn-cost { 
                    font-size: 12px; 
                    opacity: 0.9; 
                    margin-top: 4px; 
                }
                
                .btn-demo {
                    background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%);
                    border: none;
                    border-radius: 50px;
                    padding: 12px 32px;
                    color: white;
                    font-size: 15px;
                    font-weight: 700;
                    cursor: pointer;
                    box-shadow: 0 4px 18px rgba(139,92,246,0.3);
                    transition: all 0.2s;
                }
                .btn-demo:hover:not(:disabled) { 
                    transform: translateY(-2px); 
                    box-shadow: 0 6px 28px rgba(139,92,246,0.5); 
                }
                .btn-demo:disabled { 
                    opacity: 0.5; 
                    cursor: not-allowed; 
                }
                
                .need-more { 
                    color: #ef4444; 
                    font-size: 14px; 
                    margin: 0; 
                }
                
                .admin-panel {
                    margin-top: 24px;
                    display: flex;
                    justify-content: center;
                    gap: 8px;
                }
                .admin-panel input {
                    padding: 10px 12px;
                    border-radius: 8px;
                    border: 1px solid #334155;
                    background: #0f172a;
                    color: white;
                    width: 80px;
                    font-size: 14px;
                }
                .admin-panel button {
                    padding: 10px 20px;
                    border-radius: 8px;
                    border: none;
                    background: #334155;
                    color: white;
                    cursor: pointer;
                    font-weight: 600;
                    transition: background 0.2s;
                }
                .admin-panel button:hover {
                    background: #475569;
                }
            `}</style>
        </section>
    );
};

export default GalaxyWheelSection;
