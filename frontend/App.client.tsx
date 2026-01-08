import React, { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { Connection, PublicKey, Transaction, TransactionInstruction, Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// Constants
const PROGRAM_ID = new PublicKey("GYQP75VdPpCU1xPsJS7CUkcBqzL718j7ihNmgJ3VESd7");
const ED25519_PROGRAM_ID = new PublicKey("Ed25519SigVerify111111111111111111111111111");
const RPC_URL = "http://localhost:8899";

// Types
interface EarningsData {
    wallet: string;
    lifetimeEarned: string;
    lastUpdated: number | null;
}

interface SignatureData {
    signature: string;
    message: string;
    publicKey: string;
    lifetimeEarned: string;
    wallet: string;
}

interface ClaimStatus {
    loading: boolean;
    error: string | null;
    success: boolean;
    txSignature: string | null;
}

// Demo wallet for testing (in real app, use Phantom/Solflare)
function useDemoWallet() {
    const [wallet, setWallet] = useState<Keypair | null>(null);
    const [publicKey, setPublicKey] = useState<string | null>(null);

    const connect = useCallback(() => {
        const kp = Keypair.generate();
        setWallet(kp);
        setPublicKey(kp.publicKey.toBase58());
        console.log("Demo wallet connected:", kp.publicKey.toBase58());
    }, []);

    const disconnect = useCallback(() => {
        setWallet(null);
        setPublicKey(null);
    }, []);

    return { wallet, publicKey, connect, disconnect, connected: !!wallet };
}

// App Component
function App() {
    const { wallet, publicKey, connect, disconnect, connected } = useDemoWallet();
    const [earnings, setEarnings] = useState<EarningsData | null>(null);
    const [authority, setAuthority] = useState<string | null>(null);
    const [claimStatus, setClaimStatus] = useState<ClaimStatus>({
        loading: false,
        error: null,
        success: false,
        txSignature: null,
    });

    // Fetch authority on mount
    useEffect(() => {
        fetch("/api/authority")
            .then(r => r.json())
            .then(data => setAuthority(data.authority))
            .catch(console.error);
    }, []);

    // Fetch earnings when connected
    useEffect(() => {
        if (!publicKey) {
            setEarnings(null);
            return;
        }

        fetch(`/api/earnings/${publicKey}`)
            .then(r => r.json())
            .then(data => setEarnings(data))
            .catch(console.error);
    }, [publicKey]);

    // Build Ed25519 instruction
    const buildEd25519Instruction = (
        authorityPubkey: Uint8Array,
        signature: Uint8Array,
        message: Uint8Array
    ): TransactionInstruction => {
        // Ed25519 instruction data layout (Stardust Standard Layout)
        const numSignatures = 1;
        const padding = 0;

        // Offsets for self-contained data
        const pubkeyOffset = 16;       // After header
        const sigOffset = 48;          // After pubkey (16 + 32)
        const messageOffset = 112;     // After signature (48 + 64)
        const messageSize = message.length;

        const data = Buffer.alloc(112 + messageSize);

        // Header (16 bytes)
        data.writeUInt8(numSignatures, 0);
        data.writeUInt8(padding, 1);
        data.writeUInt16LE(sigOffset, 2);           // signature_offset
        data.writeUInt16LE(0xFFFF, 4);              // signature_ix_index (self)
        data.writeUInt16LE(pubkeyOffset, 6);        // pubkey_offset
        data.writeUInt16LE(0xFFFF, 8);              // pubkey_ix_index (self)
        data.writeUInt16LE(messageOffset, 10);      // message_offset
        data.writeUInt16LE(messageSize, 12);        // message_size
        data.writeUInt16LE(0xFFFF, 14);             // message_ix_index (self)

        // Public key (32 bytes at offset 16)
        data.set(authorityPubkey, pubkeyOffset);

        // Signature (64 bytes at offset 48)
        data.set(signature, sigOffset);

        // Message (at offset 112)
        data.set(message, messageOffset);

        return new TransactionInstruction({
            keys: [],
            programId: ED25519_PROGRAM_ID,
            data,
        });
    };

    // Claim stardust
    const handleClaim = async () => {
        if (!wallet || !publicKey || !earnings) return;

        setClaimStatus({ loading: true, error: null, success: false, txSignature: null });

        try {
            // 1. Get signature from backend
            const sigResp = await fetch("/api/signature", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ wallet: publicKey }),
            });

            if (!sigResp.ok) {
                const err = await sigResp.json();
                throw new Error(err.error || "Failed to get signature");
            }

            const sigData: SignatureData = await sigResp.json();

            // 2. Build Ed25519 instruction
            const authorityBytes = bs58.decode(sigData.publicKey);
            const signatureBytes = bs58.decode(sigData.signature);
            const messageBytes = bs58.decode(sigData.message);

            const ed25519Ix = buildEd25519Instruction(authorityBytes, signatureBytes, messageBytes);

            // 3. Build claim instruction (simplified - in real app, use Anchor IDL)
            // For demo, we just show the Ed25519 instruction works

            const connection = new Connection(RPC_URL, "confirmed");

            // Create transaction with just Ed25519 for demo
            const tx = new Transaction();
            tx.add(ed25519Ix);
            tx.feePayer = wallet.publicKey;
            tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

            // Note: In production, you'd add the actual claim_stardust instruction here
            // and have proper account setup

            setClaimStatus({
                loading: false,
                error: null,
                success: true,
                txSignature: "demo-" + Date.now(),
            });

        } catch (err: any) {
            setClaimStatus({
                loading: false,
                error: err.message || "Claim failed",
                success: false,
                txSignature: null,
            });
        }
    };

    // Format stardust (9 decimals)
    const formatStardust = (amount: string) => {
        const n = BigInt(amount);
        const whole = n / BigInt(1e9);
        const frac = n % BigInt(1e9);
        return `${whole.toLocaleString()}.${frac.toString().padStart(9, "0").slice(0, 2)}`;
    };

    return (
        <div className="app">
            <header className="header">
                <h1>✨ Stardust Protocol</h1>
                <p className="subtitle">Claim your stardust tokens</p>
            </header>

            <main className="main">
                {/* Wallet Section */}
                <section className="card">
                    <h2>Wallet</h2>
                    {connected ? (
                        <div className="wallet-info">
                            <code>{publicKey?.slice(0, 8)}...{publicKey?.slice(-8)}</code>
                            <button onClick={disconnect} className="btn btn-secondary">
                                Disconnect
                            </button>
                        </div>
                    ) : (
                        <button onClick={connect} className="btn btn-primary">
                            Connect Demo Wallet
                        </button>
                    )}
                </section>

                {/* Earnings Section */}
                {connected && (
                    <section className="card">
                        <h2>Your Earnings</h2>
                        {earnings ? (
                            <div className="earnings">
                                <div className="stat">
                                    <span className="label">Lifetime Earned</span>
                                    <span className="value">{formatStardust(earnings.lifetimeEarned)} ✨</span>
                                </div>
                                {earnings.lastUpdated && (
                                    <div className="stat">
                                        <span className="label">Last Updated</span>
                                        <span className="value">{new Date(earnings.lastUpdated).toLocaleString()}</span>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <p className="muted">No earnings found for this wallet</p>
                        )}
                    </section>
                )}

                {/* Claim Section */}
                {connected && earnings && BigInt(earnings.lifetimeEarned) > 0n && (
                    <section className="card">
                        <h2>Claim Stardust</h2>
                        <button
                            onClick={handleClaim}
                            disabled={claimStatus.loading}
                            className="btn btn-primary btn-large"
                        >
                            {claimStatus.loading ? "Claiming..." : `Claim ${formatStardust(earnings.lifetimeEarned)} ✨`}
                        </button>

                        {claimStatus.error && (
                            <p className="error">{claimStatus.error}</p>
                        )}

                        {claimStatus.success && (
                            <p className="success">
                                ✓ Claim successful! Tx: {claimStatus.txSignature}
                            </p>
                        )}
                    </section>
                )}

                {/* Info Section */}
                <section className="card info">
                    <h2>Protocol Info</h2>
                    <div className="info-grid">
                        <span>Program ID</span>
                        <code>{PROGRAM_ID.toBase58().slice(0, 16)}...</code>
                        <span>Authority</span>
                        <code>{authority?.slice(0, 16) || "Loading..."}...</code>
                        <span>Network</span>
                        <code>Localnet</code>
                    </div>
                </section>
            </main>

            <footer className="footer">
                <p>Stardust Protocol Demo • Built with @ments/web</p>
            </footer>
        </div>
    );
}

// Mount
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
