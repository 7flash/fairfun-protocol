import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";

// Config
const WHEEL_PROGRAM_ID = new PublicKey("3M12BfitAEYz14WJBMnjahEuSvhsWhjfGJXbzur26o2U");
const AUTHORITY_PUBKEY = "77cQ99WQ2FWQT19kgpN2a9CfgYSfDqpomNVGtyYUrpAY";
const RPC_URL = "https://mainnet.helius-rpc.com/?api-key=15319bf4-5b40-4958-ac8d-6313aa55eb92";

// PDAs
const [STATE_PDA] = PublicKey.findProgramAddressSync([Buffer.from("wheel_state")], WHEEL_PROGRAM_ID);
const [POOL_PDA] = PublicKey.findProgramAddressSync([Buffer.from("wheel_pool")], WHEEL_PROGRAM_ID);

interface WheelState {
    authority: string;
    stardustMint: string;
    costPerSpin: number;
    numTiers: number;
    probabilities: number[];
    rewardBps: number[];
    totalSpins: number;
    totalDistributed: number;
}

function AdminPage() {
    const [connected, setConnected] = useState(false);
    const [publicKey, setPublicKey] = useState<string | null>(null);
    const [phantomWallet, setPhantomWallet] = useState<any>(null);
    const [unauthorized, setUnauthorized] = useState(false);

    const [wheelState, setWheelState] = useState<WheelState | null>(null);
    const [poolBalance, setPoolBalance] = useState(0);
    const [loading, setLoading] = useState(true);

    const [fundAmount, setFundAmount] = useState("0.1");
    const [newSpinCost, setNewSpinCost] = useState("1000");
    const [status, setStatus] = useState("");

    // Connect wallet
    const handleConnect = async () => {
        try {
            const phantom = (window as any).phantom?.solana;
            if (!phantom) {
                alert("Please install Phantom wallet");
                return;
            }
            const { publicKey } = await phantom.connect();
            const pubkeyStr = publicKey.toString();
            setPublicKey(pubkeyStr);
            setPhantomWallet(phantom);
            setConnected(true);

            // Check if authorized
            if (pubkeyStr !== AUTHORITY_PUBKEY) {
                setUnauthorized(true);
            }
        } catch (e) {
            console.error(e);
        }
    };

    // Fetch wheel state
    const fetchWheelState = async () => {
        try {
            const connection = new Connection(RPC_URL, "confirmed");

            // Get pool balance
            const balance = await connection.getBalance(POOL_PDA);
            setPoolBalance(balance / LAMPORTS_PER_SOL);

            // Get wheel state account
            const stateInfo = await connection.getAccountInfo(STATE_PDA);
            if (!stateInfo) {
                setWheelState(null);
                setLoading(false);
                return;
            }

            // Parse state (skip 8 byte discriminator)
            const data = stateInfo.data;
            let offset = 8;

            const authority = new PublicKey(data.slice(offset, offset + 32)).toBase58();
            offset += 32;

            const stardustMint = new PublicKey(data.slice(offset, offset + 32)).toBase58();
            offset += 32;

            const costPerSpin = Number(data.readBigUInt64LE(offset)) / 1e9;
            offset += 8;

            const numTiers = data.readUInt8(offset);
            offset += 1;

            const probabilities: number[] = [];
            for (let i = 0; i < 10; i++) {
                probabilities.push(data.readUInt16LE(offset));
                offset += 2;
            }

            const rewardBps: number[] = [];
            for (let i = 0; i < 10; i++) {
                rewardBps.push(data.readUInt16LE(offset));
                offset += 2;
            }

            const totalSpins = Number(data.readBigUInt64LE(offset));
            offset += 8;

            const totalDistributed = Number(data.readBigUInt64LE(offset)) / LAMPORTS_PER_SOL;

            setWheelState({
                authority,
                stardustMint,
                costPerSpin,
                numTiers,
                probabilities: probabilities.slice(0, numTiers),
                rewardBps: rewardBps.slice(0, numTiers),
                totalSpins,
                totalDistributed,
            });

            setNewSpinCost(costPerSpin.toString());
            setLoading(false);
        } catch (e) {
            console.error("Failed to fetch wheel state:", e);
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchWheelState();
        const interval = setInterval(fetchWheelState, 10000);
        return () => clearInterval(interval);
    }, []);

    // Fund treasury
    const handleFundTreasury = async () => {
        if (!phantomWallet || !publicKey) return;

        setStatus("Funding treasury...");
        try {
            const connection = new Connection(RPC_URL, "confirmed");
            const amountLamports = BigInt(Math.floor(parseFloat(fundAmount) * LAMPORTS_PER_SOL));

            // Discriminator for fund_pool: sha256("global:fund_pool")[:8]
            const discriminator = Buffer.from([0x24, 0x39, 0xe9, 0xb0, 0xb5, 0x14, 0x57, 0x9f]);

            const data = Buffer.alloc(8 + 8);
            discriminator.copy(data, 0);
            data.writeBigUInt64LE(amountLamports, 8);

            const fundIx = new TransactionInstruction({
                programId: WHEEL_PROGRAM_ID,
                keys: [
                    { pubkey: POOL_PDA, isSigner: false, isWritable: true },
                    { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: true },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                ],
                data,
            });

            const tx = new Transaction().add(fundIx);
            const { blockhash } = await connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.feePayer = new PublicKey(publicKey);

            const { signature } = await phantomWallet.signAndSendTransaction(tx);
            await connection.confirmTransaction(signature, "confirmed");

            setStatus(`✅ Funded! TX: ${signature.slice(0, 20)}...`);
            fetchWheelState();
        } catch (e: any) {
            setStatus(`❌ Error: ${e.message}`);
        }
    };

    // Update spin cost
    const handleUpdateSpinCost = async () => {
        if (!phantomWallet || !publicKey) return;

        setStatus("Updating spin cost...");
        try {
            const connection = new Connection(RPC_URL, "confirmed");
            const costLamports = BigInt(Math.floor(parseFloat(newSpinCost) * 1e9));

            // Discriminator for set_spin_cost: sha256("global:set_spin_cost")[:8]
            const discriminator = Buffer.from([0xd0, 0x2d, 0xd5, 0x5f, 0xd6, 0x1f, 0x55, 0x2f]);

            const data = Buffer.alloc(8 + 8);
            discriminator.copy(data, 0);
            data.writeBigUInt64LE(costLamports, 8);

            const ix = new TransactionInstruction({
                programId: WHEEL_PROGRAM_ID,
                keys: [
                    { pubkey: STATE_PDA, isSigner: false, isWritable: true },
                    { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: false },
                ],
                data,
            });

            const tx = new Transaction().add(ix);
            const { blockhash } = await connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.feePayer = new PublicKey(publicKey);

            const { signature } = await phantomWallet.signAndSendTransaction(tx);
            await connection.confirmTransaction(signature, "confirmed");

            setStatus(`✅ Spin cost updated! TX: ${signature.slice(0, 20)}...`);
            fetchWheelState();
        } catch (e: any) {
            setStatus(`❌ Error: ${e.message}`);
        }
    };

    if (unauthorized) {
        return (
            <div style={{ padding: 40, fontFamily: "monospace", background: "#0f1419", color: "#fff", minHeight: "100vh" }}>
                <h1>🚫 Unauthorized</h1>
                <p>Connected wallet: {publicKey}</p>
                <p>Required authority: {AUTHORITY_PUBKEY}</p>
            </div>
        );
    }

    return (
        <div style={{ padding: 40, fontFamily: "system-ui", background: "#0f1419", color: "#fff", minHeight: "100vh" }}>
            <h1>🎡 Galaxy Wheel Admin</h1>

            {!connected ? (
                <button onClick={handleConnect} style={buttonStyle}>Connect Wallet</button>
            ) : (
                <div style={{ marginBottom: 20, color: "#22c55e" }}>✅ Connected: {publicKey?.slice(0, 8)}...</div>
            )}

            {loading ? (
                <p>Loading...</p>
            ) : wheelState ? (
                <>
                    <div style={cardStyle}>
                        <h2>📊 Current State</h2>
                        <table style={{ width: "100%", borderCollapse: "collapse" }}>
                            <tbody>
                                <tr style={rowStyle}><td>Authority</td><td>{wheelState.authority.slice(0, 12)}...</td></tr>
                                <tr style={rowStyle}><td>Spin Cost</td><td>{wheelState.costPerSpin.toLocaleString()} stardust</td></tr>
                                <tr style={rowStyle}><td>Treasury Balance</td><td style={{ color: "#fbbf24", fontWeight: "bold" }}>{poolBalance.toFixed(4)} SOL</td></tr>
                                <tr style={rowStyle}><td>Total Spins</td><td>{wheelState.totalSpins.toLocaleString()}</td></tr>
                                <tr style={rowStyle}><td>Total Distributed</td><td>{wheelState.totalDistributed.toFixed(4)} SOL</td></tr>
                            </tbody>
                        </table>
                    </div>

                    <div style={cardStyle}>
                        <h2>🎯 Tier Configuration ({wheelState.numTiers} tiers)</h2>
                        <table style={{ width: "100%", borderCollapse: "collapse" }}>
                            <thead>
                                <tr style={rowStyle}>
                                    <th>Tier</th>
                                    <th>Probability</th>
                                    <th>Reward</th>
                                    <th>Current Value</th>
                                </tr>
                            </thead>
                            <tbody>
                                {wheelState.probabilities.map((prob, i) => (
                                    <tr key={i} style={rowStyle}>
                                        <td>{i}</td>
                                        <td>{(prob / 100).toFixed(1)}%</td>
                                        <td>{(wheelState.rewardBps[i] / 100).toFixed(1)}% of treasury</td>
                                        <td style={{ color: "#22c55e" }}>{((poolBalance * wheelState.rewardBps[i]) / 10000).toFixed(4)} SOL</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {connected && (
                        <>
                            <div style={cardStyle}>
                                <h2>💰 Fund Treasury</h2>
                                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                                    <input
                                        type="number"
                                        value={fundAmount}
                                        onChange={e => setFundAmount(e.target.value)}
                                        style={inputStyle}
                                        step="0.1"
                                    />
                                    <span>SOL</span>
                                    <button onClick={handleFundTreasury} style={buttonStyle}>Fund Treasury</button>
                                </div>
                            </div>

                            <div style={cardStyle}>
                                <h2>⚙️ Update Spin Cost</h2>
                                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                                    <input
                                        type="number"
                                        value={newSpinCost}
                                        onChange={e => setNewSpinCost(e.target.value)}
                                        style={inputStyle}
                                        step="100"
                                    />
                                    <span>stardust</span>
                                    <button onClick={handleUpdateSpinCost} style={buttonStyle}>Update Cost</button>
                                </div>
                            </div>
                        </>
                    )}

                    {status && <div style={{ marginTop: 20, padding: 10, background: "#1a202c", borderRadius: 8 }}>{status}</div>}
                </>
            ) : (
                <p>Wheel not initialized</p>
            )}

            <div style={{ marginTop: 40, fontSize: 12, color: "#6b7280" }}>
                <p>Program ID: {WHEEL_PROGRAM_ID.toBase58()}</p>
                <p>State PDA: {STATE_PDA.toBase58()}</p>
                <p>Pool PDA: {POOL_PDA.toBase58()}</p>
            </div>
        </div>
    );
}

const buttonStyle: React.CSSProperties = {
    background: "linear-gradient(135deg, #fbbf24, #f59e0b)",
    border: "none",
    padding: "10px 20px",
    borderRadius: 8,
    color: "#000",
    fontWeight: "bold",
    cursor: "pointer",
};

const cardStyle: React.CSSProperties = {
    background: "#1a202c",
    padding: 20,
    borderRadius: 12,
    marginTop: 20,
    border: "1px solid #2d3748",
};

const rowStyle: React.CSSProperties = {
    borderBottom: "1px solid #2d3748",
};

const inputStyle: React.CSSProperties = {
    background: "#0f1419",
    border: "1px solid #2d3748",
    padding: "8px 12px",
    borderRadius: 6,
    color: "#fff",
    width: 120,
};

// Mount
const root = document.getElementById("root");
if (root) {
    createRoot(root).render(<AdminPage />);
}
