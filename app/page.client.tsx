import { render } from 'tradjs/client';

interface LeaderboardEntry {
    rank: number;
    address: string;
    addressShort: string;
    tokenBalance: number;
    tokenValueUsd: number;
    percentSupplyFormatted: string;
    accumulatedGravity: number;
    gravityShare: number;
    gravityShareFormatted: string;
    totalSolRewardsEarned: number;
}

interface TreasuryEvent {
    signature: string;
    amountSol: number;
    payoutAmountSol: number;
    observedTotalDepositsSol: number;
    timestamp: number;
}

interface WalletTotals {
    address: string;
    addressShort: string;
    rank: number | null;
    tokenBalance: number;
    tokenValueUsd: number;
    accumulatedGravity: number;
    gravityShareFormatted: string;
    totalSolRewardsEarned: number;
    totalSolRewardsClaimed: number;
    claimableSolRewards: number;
    claimEnabled: boolean;
    claimDisabledReason: string;
}

interface LeaderboardResponse {
    success: boolean;
    entries: LeaderboardEntry[];
    total: number;
    totalSupply: number;
    tokenPriceUsd: number;
    epochIndex: number;
    totalFeesAccumulatedSol: number;
    treasuryBalanceSol: number;
    totalAccumulatedGravity: number;
}

interface TreasuryResponse {
    success: boolean;
    events: TreasuryEvent[];
    total: number;
}

interface WalletResponse {
    success: boolean;
    wallet: WalletTotals;
}

interface ToastState {
    kind: 'success' | 'error';
    message: string;
    txSignature?: string;
}

type NumberFormatKind = 'tokens' | 'usd' | 'gravity' | 'sol' | 'int';
type ActivityTab = 'leaderboard' | 'treasury';

interface RuntimeConfig {
    rpcUrl: string;
    treasuryAddress: string;
    tokenMint: string;
    tokenSymbol: string;
    projectName: string;
    explorerTxBaseUrl: string;
    claimEnabled: boolean;
}

function shortAddress(address: string) {
    if (address.length <= 10) return address;
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function getRuntimeConfig(): RuntimeConfig {
    const configRoot = document.getElementById('app-config-root');
    return {
        rpcUrl: configRoot?.getAttribute('data-rpc-url') ?? '',
        treasuryAddress: configRoot?.getAttribute('data-treasury-address') ?? '',
        tokenMint: configRoot?.getAttribute('data-token-mint') ?? '',
        tokenSymbol: configRoot?.getAttribute('data-token-symbol') ?? 'TOKEN',
        projectName: configRoot?.getAttribute('data-project-name') ?? 'FairFun',
        explorerTxBaseUrl: configRoot?.getAttribute('data-explorer-tx-base-url') ?? 'https://solscan.io/tx/',
        claimEnabled: configRoot?.getAttribute('data-claim-enabled') === 'true',
    };
}

function formatNumber(value: number, kind: NumberFormatKind) {
    switch (kind) {
        case 'usd':
            if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
            if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
            if (value > 0 && value < 0.01) return `$${value.toFixed(6)}`;
            return `$${value.toFixed(2)}`;
        case 'gravity':
            if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
            if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
            if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
            return value.toFixed(2);
        case 'sol':
            if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K SOL`;
            return `${value.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL`;
        case 'tokens':
            if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
            if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
            return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
        case 'int':
            return Math.round(value).toLocaleString();
    }
}

function formatRelativeTime(timestamp: number) {
    if (!timestamp) return 'just now';
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
}

function AnimatedValue({ value, kind }: { value: number; kind: NumberFormatKind }) {
    return (
        <span className="animated-number" data-animate-number="true" data-target={String(value)} data-format={kind}>
            {formatNumber(value, kind)}
        </span>
    );
}

function animateNumbers(scope: ParentNode) {
    const nodes = scope.querySelectorAll<HTMLElement>('[data-animate-number="true"]');
    nodes.forEach((node) => {
        const target = Number(node.dataset.target ?? '0');
        const kind = (node.dataset.format ?? 'int') as NumberFormatKind;
        const current = Number(node.dataset.current ?? '0');
        if (!Number.isFinite(target)) return;
        if (Math.abs(target - current) < 0.0000001) {
            node.textContent = formatNumber(target, kind);
            node.dataset.current = String(target);
            return;
        }

        const start = current;
        const startTime = performance.now();
        const duration = 650;
        const step = (timestamp: number) => {
            const progress = Math.min(1, (timestamp - startTime) / duration);
            const eased = 1 - Math.pow(1 - progress, 3);
            const next = start + (target - start) * eased;
            node.textContent = formatNumber(next, kind);
            if (progress < 1) {
                requestAnimationFrame(step);
            } else {
                node.textContent = formatNumber(target, kind);
                node.dataset.current = String(target);
                node.classList.add('value-updated');
                setTimeout(() => node.classList.remove('value-updated'), 900);
            }
        };
        requestAnimationFrame(step);
    });
}

function HeroMetrics({
    total,
    totalSupply,
    tokenPriceUsd,
    totalFeesAccumulatedSol,
    totalAccumulatedGravity,
    epochIndex,
}: {
    total: number;
    totalSupply: number;
    tokenPriceUsd: number;
    totalFeesAccumulatedSol: number;
    totalAccumulatedGravity: number;
    epochIndex: number;
}) {
    const marketCap = totalSupply * tokenPriceUsd;

    return (
        <>
            <div className="metric-card">
                <div className="metric-label">Holders</div>
                <div className="metric-value"><AnimatedValue value={total} kind="int" /></div>
            </div>
            <div className="metric-card">
                <div className="metric-label">Market Cap</div>
                <div className="metric-value"><AnimatedValue value={marketCap} kind="usd" /></div>
            </div>
            <div className="metric-card">
                <div className="metric-label">Revenue</div>
                <div className="metric-value"><AnimatedValue value={totalFeesAccumulatedSol} kind="sol" /></div>
            </div>
            <div className="metric-card">
                <div className="metric-label">Total Gravity</div>
                <div className="metric-value"><AnimatedValue value={totalAccumulatedGravity} kind="gravity" /></div>
            </div>
            <div className="metric-card">
                <div className="metric-label">Epoch</div>
                <div className="metric-value"><AnimatedValue value={epochIndex} kind="int" /></div>
            </div>
        </>
    );
}

function AddressContainers({
    tokenSymbol,
    tokenMint,
    treasuryAddress,
    treasuryBalanceSol,
}: {
    tokenSymbol: string;
    tokenMint: string;
    treasuryAddress: string;
    treasuryBalanceSol: number;
}) {
    const copyToClipboard = (text: string) => {
        void navigator.clipboard.writeText(text);
    };

    return (
        <div className="address-grid">
            <div className="address-card address-tooltip" data-tooltip={`Token mint for ${tokenSymbol} on Solana.`}>
                <div className="address-label">Token Mint</div>
                <div className="address-row">
                    <div className="address-value">{shortAddress(tokenMint)}</div>
                    <button className="copy-btn" onClick={() => copyToClipboard(tokenMint)} title="Copy token mint" type="button">
                        Copy
                    </button>
                </div>
            </div>

            <div className="address-card address-tooltip" data-tooltip="Treasury PDA holding the SOL used for gravity-weighted rewards.">
                <div className="address-label">Treasury PDA</div>
                <div className="address-row">
                    <div className="address-value">{shortAddress(treasuryAddress)}</div>
                    <button className="copy-btn" onClick={() => copyToClipboard(treasuryAddress)} title="Copy treasury PDA" type="button">
                        Copy
                    </button>
                </div>
                <div className="treasury-remaining">
                    <span className="label">Remaining balance</span>
                    <span className="metric-value" style={{ fontSize: '1.25rem', marginTop: 0 }}>
                        <AnimatedValue value={treasuryBalanceSol} kind="sol" />
                    </span>
                </div>
            </div>
        </div>
    );
}

function PositionPanel({
    runtimeConfig,
    connectedAddress,
    walletTotals,
    total,
    connect,
    claim,
    walletError,
}: {
    runtimeConfig: RuntimeConfig;
    connectedAddress: string | null;
    walletTotals: WalletTotals | null;
    total: number;
    connect: () => void;
    claim: () => void;
    walletError: string | null;
}) {
    if (!connectedAddress) {
        return (
            <div className="position-panel">
                <div className="position-head">
                    <span className="position-label">Your Position</span>
                </div>
                <div className="connect-state">
                    <h2 className="connect-title">Connect your wallet</h2>
                    <p className="connect-copy">See your gravity share, accumulated rewards, claimable balance, and treasury payouts.</p>
                    <button onClick={connect} className="primary-button connect-cta" type="button">
                        <span>⬢</span>
                        <span>CONNECT PHANTOM WALLET</span>
                    </button>
                </div>
                {walletError ? <div className="inline-error">{walletError}</div> : null}
            </div>
        );
    }

    const claimableRewards = walletTotals?.claimableSolRewards ?? 0;
    const canClaim = Boolean(walletTotals?.claimEnabled && claimableRewards > 0);
    const disabledReason = walletTotals?.claimDisabledReason
        || (!runtimeConfig.claimEnabled ? 'Backend signer keypair is not configured on the web process.' : 'No claimable rewards yet.');

    return (
        <div className={`position-panel ${walletTotals?.rank ? 'is-ranked' : ''}`}>
            <div className="position-head">
                <span className="position-label">Your Position</span>
                {walletTotals?.rank ? (
                    <div className="rank-display">
                        <span className="rank-num">#{walletTotals.rank}</span>
                        <span className="rank-of">/ {total.toLocaleString()}</span>
                    </div>
                ) : null}
            </div>

            <div className="position-identity">
                <div className="identity-addr">{walletTotals?.addressShort ?? shortAddress(connectedAddress)}</div>
                {walletTotals?.rank ? <span className="rank-pill">RANK #{walletTotals.rank}</span> : null}
            </div>
            <div className="identity-full">{connectedAddress}</div>

            <div className="position-grid">
                <div className="grid-cell">
                    <div className="cell-label">{runtimeConfig.tokenSymbol} Balance</div>
                    <div className="cell-value"><AnimatedValue value={walletTotals?.tokenBalance ?? 0} kind="tokens" /></div>
                </div>
                <div className="grid-cell">
                    <div className="cell-label">USD Value</div>
                    <div className="cell-value"><AnimatedValue value={walletTotals?.tokenValueUsd ?? 0} kind="usd" /></div>
                </div>
                <div className="grid-cell">
                    <div className="cell-label">Gravity</div>
                    <div className="cell-value cell-cyan"><AnimatedValue value={walletTotals?.accumulatedGravity ?? 0} kind="gravity" /></div>
                </div>
                <div className="grid-cell">
                    <div className="cell-label">Ownership</div>
                    <div className="cell-value">{walletTotals?.gravityShareFormatted ?? '0.000%'}</div>
                </div>
                <div className="grid-cell">
                    <div className="cell-label">SOL Earned</div>
                    <div className="cell-value"><AnimatedValue value={walletTotals?.totalSolRewardsEarned ?? 0} kind="sol" /></div>
                </div>
                <div className="grid-cell">
                    <div className="cell-label">SOL Claimed</div>
                    <div className="cell-value"><AnimatedValue value={walletTotals?.totalSolRewardsClaimed ?? 0} kind="sol" /></div>
                </div>
            </div>

            <button className="claim-button" disabled={!canClaim} onClick={claim} title={disabledReason} type="button">
                {canClaim ? `CLAIM ${formatNumber(claimableRewards, 'sol')}` : 'CLAIM UNAVAILABLE'}
            </button>

            {!canClaim ? <div className="inline-note">{disabledReason}</div> : null}
            {walletError ? <div className="inline-error">{walletError}</div> : null}
        </div>
    );
}

function SkeletonRows() {
    return (
        <>
            {[0, 1, 2, 3, 4, 5].map((index) => (
                <tr className="skeleton-row" key={index}>
                    <td><div className="skeleton sk-rank" /></td>
                    <td><div className="skeleton sk-wallet" /></td>
                    <td><div className="skeleton sk-num" /></td>
                    <td><div className="skeleton sk-num" /></td>
                    <td><div className="skeleton sk-num" /></td>
                    <td><div className="skeleton sk-num" /></td>
                </tr>
            ))}
        </>
    );
}

function LeaderboardTable({
    entries,
    loading,
    error,
    connectedAddress,
    tokenSymbol,
}: {
    entries: LeaderboardEntry[];
    loading: boolean;
    error: string | null;
    connectedAddress: string | null;
    tokenSymbol: string;
}) {
    const connectedAddressLower = connectedAddress?.toLowerCase() ?? null;
    const displayEntries = entries.slice(0, 150);

    return (
        <table className="leaderboard-table">
            <thead>
                <tr>
                    <th className="th-rank">#</th>
                    <th>Wallet</th>
                    <th className="th-num">{tokenSymbol}</th>
                    <th className="th-num header-tooltip" data-tooltip="Gravity is the cumulative USD-minutes held by each wallet.">
                        Gravity
                    </th>
                    <th className="th-num header-tooltip" data-tooltip="Ownership is your share of total gravity, not your spot balance at a single snapshot.">
                        Ownership
                    </th>
                    <th className="th-num">SOL Earned</th>
                </tr>
            </thead>
            <tbody>
                {error ? (
                    <tr><td className="state-row error-state" colSpan={6}>{error}</td></tr>
                ) : loading && entries.length === 0 ? (
                    <SkeletonRows />
                ) : entries.length === 0 ? (
                    <tr><td className="state-row" colSpan={6}>No indexed holders found yet.</td></tr>
                ) : (
                    <>
                        {displayEntries.map((entry) => {
                            const isYou = connectedAddressLower === entry.address.toLowerCase();
                            const medalClass = entry.rank <= 3 ? `rank-${entry.rank}` : '';
                            return (
                                <tr className={`leaderboard-row ${isYou ? 'is-you' : ''}`} key={entry.address}>
                                    <td><span className={`rank-cell ${medalClass}`.trim()}>{entry.rank}</span></td>
                                    <td>
                                        <span className="wallet-mono">{entry.addressShort}</span>
                                        {isYou ? <span className="you-tag">YOU</span> : null}
                                        <div className="wallet-sub">Supply {entry.percentSupplyFormatted}</div>
                                    </td>
                                    <td className="td-num">
                                        <div>{formatNumber(entry.tokenBalance, 'tokens')}</div>
                                        <div className="num-sub">{formatNumber(entry.tokenValueUsd, 'usd')}</div>
                                    </td>
                                    <td className="td-num td-cyan">{formatNumber(entry.accumulatedGravity, 'gravity')}</td>
                                    <td className="td-num">{entry.gravityShareFormatted}</td>
                                    <td className="td-num td-emerald">{formatNumber(entry.totalSolRewardsEarned, 'sol')}</td>
                                </tr>
                            );
                        })}
                    </>
                )}
            </tbody>
        </table>
    );
}

function TreasuryTable({
    runtimeConfig,
    events,
    loading,
    error,
    connectedAddress,
}: {
    runtimeConfig: RuntimeConfig;
    events: TreasuryEvent[];
    loading: boolean;
    error: string | null;
    connectedAddress: string | null;
}) {
    return (
        <table className="leaderboard-table">
            <thead>
                <tr>
                    <th>When</th>
                    <th className="th-num">Treasury Added</th>
                    <th className="th-num">You Got</th>
                    <th className="th-num">Total Deposits</th>
                    <th>Transaction</th>
                </tr>
            </thead>
            <tbody>
                {error ? (
                    <tr><td className="state-row error-state" colSpan={5}>{error}</td></tr>
                ) : loading && events.length === 0 ? (
                    <SkeletonRows />
                ) : events.length === 0 ? (
                    <tr><td className="state-row" colSpan={5}>No treasury additions have been indexed yet.</td></tr>
                ) : (
                    events.map((event) => (
                        <tr className="leaderboard-row" key={event.signature}>
                            <td>
                                <div>{formatRelativeTime(event.timestamp)}</div>
                                <div className="wallet-sub">{new Date(event.timestamp).toLocaleString()}</div>
                            </td>
                            <td className="td-num td-emerald">{formatNumber(event.amountSol, 'sol')}</td>
                            <td className="td-num td-cyan">
                                {connectedAddress ? formatNumber(event.payoutAmountSol, 'sol') : 'Connect wallet'}
                            </td>
                            <td className="td-num">{formatNumber(event.observedTotalDepositsSol, 'sol')}</td>
                            <td>
                                <a
                                    className="tx-link"
                                    href={`${runtimeConfig.explorerTxBaseUrl}${event.signature}`}
                                    rel="noreferrer"
                                    target="_blank"
                                >
                                    {shortAddress(event.signature)}
                                </a>
                            </td>
                        </tr>
                    ))
                )}
            </tbody>
        </table>
    );
}

function ActivityPanel({
    runtimeConfig,
    activeTab,
    setActiveTab,
    entries,
    treasuryEvents,
    loading,
    error,
    connectedAddress,
}: {
    runtimeConfig: RuntimeConfig;
    activeTab: ActivityTab;
    setActiveTab: (tab: ActivityTab) => void;
    entries: LeaderboardEntry[];
    treasuryEvents: TreasuryEvent[];
    loading: boolean;
    error: string | null;
    connectedAddress: string | null;
}) {
    return (
        <div className="leaderboard-panel">
            <div className="board-tabs">
                <button
                    className={`board-tab ${activeTab === 'leaderboard' ? 'is-active' : ''}`}
                    onClick={() => setActiveTab('leaderboard')}
                    type="button"
                >
                    Leaderboard
                </button>
                <button
                    className={`board-tab ${activeTab === 'treasury' ? 'is-active' : ''}`}
                    onClick={() => setActiveTab('treasury')}
                    type="button"
                >
                    Treasury Additions
                </button>
            </div>

            {activeTab === 'leaderboard' ? (
                <LeaderboardTable
                    entries={entries}
                    loading={loading}
                    error={error}
                    connectedAddress={connectedAddress}
                    tokenSymbol={runtimeConfig.tokenSymbol}
                />
            ) : (
                <TreasuryTable
                    runtimeConfig={runtimeConfig}
                    events={treasuryEvents}
                    loading={loading}
                    error={error}
                    connectedAddress={connectedAddress}
                />
            )}
        </div>
    );
}

function Toast({ toast, explorerTxBaseUrl }: { toast: ToastState | null; explorerTxBaseUrl: string }) {
    if (!toast) return null;
    return (
        <div className={`toast toast-${toast.kind}`}>
            <div className="toast-message">{toast.message}</div>
            {toast.txSignature ? (
                <a className="toast-link" href={`${explorerTxBaseUrl}${toast.txSignature}`} rel="noreferrer" target="_blank">
                    View transaction
                </a>
            ) : null}
        </div>
    );
}

export default function mount() {
    const runtimeConfig = getRuntimeConfig();
    const leaderboardRoot = document.getElementById('leaderboard-root');
    const positionRoot = document.getElementById('wallet-position-root');
    const metricsRoot = document.getElementById('hero-metrics-root');
    const addressRoot = document.getElementById('address-containers-root');
    const toastRoot = document.getElementById('toast-root');
    const refreshButton = document.getElementById('refresh-button') as HTMLButtonElement | null;
    const summary = document.getElementById('leaderboard-summary');
    const boardTitle = document.querySelector('.board-title');

    if (!leaderboardRoot || !positionRoot || !metricsRoot || !toastRoot || !addressRoot) return;

    let entries: LeaderboardEntry[] = [];
    let treasuryEvents: TreasuryEvent[] = [];
    let total = 0;
    let totalSupply = 0;
    let tokenPriceUsd = 0;
    let epochIndex = 0;
    let totalFeesAccumulatedSol = 0;
    let treasuryBalanceSol = 0;
    let totalAccumulatedGravity = 0;
    let activeTab: ActivityTab = 'leaderboard';
    let loading = true;
    let error: string | null = null;
    let walletError: string | null = null;
    let connectedAddress: string | null = null;
    let walletTotals: WalletTotals | null = null;
    let toast: ToastState | null = null;
    let toastTimeout: ReturnType<typeof setTimeout> | null = null;
    let lastRefreshAt = Date.now();

    const showToast = (nextToast: ToastState) => {
        toast = nextToast;
        if (toastTimeout) clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => {
            toast = null;
            update();
        }, 7000);
        update();
    };

    const update = () => {
        render(
            <HeroMetrics
                total={total}
                totalSupply={totalSupply}
                tokenPriceUsd={tokenPriceUsd}
                totalFeesAccumulatedSol={totalFeesAccumulatedSol}
                totalAccumulatedGravity={totalAccumulatedGravity}
                epochIndex={epochIndex}
            />,
            metricsRoot
        );

        render(
            <AddressContainers
                tokenSymbol={runtimeConfig.tokenSymbol}
                tokenMint={runtimeConfig.tokenMint}
                treasuryAddress={runtimeConfig.treasuryAddress}
                treasuryBalanceSol={treasuryBalanceSol}
            />,
            addressRoot
        );

        render(
            <PositionPanel
                runtimeConfig={runtimeConfig}
                connectedAddress={connectedAddress}
                walletTotals={walletTotals}
                total={total}
                connect={connectWallet}
                claim={claimRewards}
                walletError={walletError}
            />,
            positionRoot
        );

        render(
            <ActivityPanel
                runtimeConfig={runtimeConfig}
                activeTab={activeTab}
                setActiveTab={(tab) => {
                    activeTab = tab;
                    update();
                }}
                entries={entries}
                treasuryEvents={treasuryEvents}
                loading={loading}
                error={error}
                connectedAddress={connectedAddress}
            />,
            leaderboardRoot
        );

        render(<Toast toast={toast} explorerTxBaseUrl={runtimeConfig.explorerTxBaseUrl} />, toastRoot);

        if (boardTitle) {
            boardTitle.textContent = activeTab === 'leaderboard' ? 'Gravity Leaderboard' : 'Recent Treasury Additions';
        }
        if (summary) {
            summary.textContent = activeTab === 'leaderboard'
                ? (total > 0
                    ? `${total.toLocaleString()} holders · ${formatNumber(totalFeesAccumulatedSol, 'sol')} revenue · updated ${formatRelativeTime(lastRefreshAt)}`
                    : 'Waiting for indexer data...')
                : (treasuryEvents.length > 0
                    ? `${treasuryEvents.length.toLocaleString()} recent additions · treasury balance ${formatNumber(treasuryBalanceSol, 'sol')} · updated ${formatRelativeTime(lastRefreshAt)}`
                    : 'Waiting for treasury additions...');
        }

        if (refreshButton) refreshButton.classList.toggle('is-loading', loading);
        animateNumbers(metricsRoot);
        animateNumbers(positionRoot);
        animateNumbers(addressRoot);
    };

    async function loadWalletTotals() {
        if (!connectedAddress) {
            walletTotals = null;
            return;
        }

        const response = await fetch(`/api/wallet?address=${encodeURIComponent(connectedAddress)}`);
        const data: WalletResponse = await response.json();
        walletTotals = data.success ? data.wallet : null;
    }

    async function connectWallet() {
        walletError = null;
        const provider = (window as any).solana;
        if (!provider?.isPhantom || typeof provider.connect !== 'function') {
            walletError = 'Phantom wallet was not found in this browser.';
            update();
            return;
        }

        try {
            const result = await provider.connect({ onlyIfTrusted: false });
            connectedAddress = String(result.publicKey ?? '');
            showToast({ kind: 'success', message: `Connected ${shortAddress(connectedAddress)}` });
            await fetchAll();
            return;
        } catch (connectError: any) {
            walletError = typeof connectError?.message === 'string' ? connectError.message : 'Wallet connection failed.';
        }

        update();
    }

    async function claimRewards() {
        walletError = null;
        let signature: string | undefined;

        try {
            if (!connectedAddress) {
                walletError = 'Connect wallet first.';
                update();
                return;
            }
            if (!runtimeConfig.claimEnabled) {
                walletError = 'Backend signer keypair is not configured on the web process.';
                update();
                return;
            }

            const phantom = (window as any).solana;
            if (!phantom?.isPhantom || typeof phantom.signTransaction !== 'function') {
                walletError = 'Phantom wallet was not found in this browser.';
                update();
                return;
            }

            const response = await fetch('/api/claim', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ address: connectedAddress }),
            });
            const data = await response.json();
            if (!response.ok) {
                walletError = data.error ?? 'Claim is not available yet.';
                update();
                return;
            }

            const { Connection, Transaction } = await import('@solana/web3.js');
            const tx = Transaction.from(Uint8Array.from(atob(data.transaction), (char) => char.charCodeAt(0)));
            const signed = await phantom.signTransaction(tx);
            const conn = new Connection(runtimeConfig.rpcUrl, 'confirmed');
            signature = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
            const confirmation = await conn.confirmTransaction({
                signature,
                blockhash: data.blockhash,
                lastValidBlockHeight: data.lastValidBlockHeight,
            }, 'confirmed');
            if (confirmation.value.err) {
                throw new Error(typeof confirmation.value.err === 'string'
                    ? confirmation.value.err
                    : JSON.stringify(confirmation.value.err));
            }

            await fetch('/api/claim', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ address: connectedAddress, signature }),
            });

            await fetchAll();
            showToast({ kind: 'success', message: 'Rewards claimed successfully.', txSignature: signature });
        } catch (claimError: any) {
            walletError = claimError?.message || 'Claim request failed.';
            showToast({ kind: 'error', message: walletError ?? 'Claim request failed.', txSignature: signature });
        }

        update();
    }

    async function fetchAll() {
        try {
            loading = true;
            update();

            const suffix = connectedAddress ? `?wallet=${encodeURIComponent(connectedAddress)}` : '';
            const [leaderboardResponse, treasuryResponse] = await Promise.all([
                fetch(`/api/leaderboard${suffix}`),
                fetch(`/api/treasury${suffix}`),
            ]);

            const leaderboardData: LeaderboardResponse = await leaderboardResponse.json();
            const treasuryData: TreasuryResponse = await treasuryResponse.json();

            if (leaderboardData.success) {
                entries = leaderboardData.entries
                    .filter((entry) => entry.tokenBalance > 0)
                    .sort((a, b) => {
                        if (b.gravityShare !== a.gravityShare) return b.gravityShare - a.gravityShare;
                        if (b.accumulatedGravity !== a.accumulatedGravity) return b.accumulatedGravity - a.accumulatedGravity;
                        return b.tokenBalance - a.tokenBalance;
                    })
                    .map((entry, index) => ({ ...entry, rank: index + 1 }));
                total = entries.length;
                totalSupply = leaderboardData.totalSupply;
                tokenPriceUsd = leaderboardData.tokenPriceUsd;
                epochIndex = leaderboardData.epochIndex;
                totalFeesAccumulatedSol = leaderboardData.totalFeesAccumulatedSol;
                treasuryBalanceSol = leaderboardData.treasuryBalanceSol;
                totalAccumulatedGravity = leaderboardData.totalAccumulatedGravity;
                lastRefreshAt = Date.now();
                error = null;
            } else {
                error = 'Failed to load indexed leaderboard.';
            }

            if (treasuryData.success) {
                treasuryEvents = treasuryData.events;
            } else if (!error) {
                error = 'Failed to load treasury additions.';
            }

            await loadWalletTotals();
        } catch {
            error = 'Error fetching indexed activity data.';
        } finally {
            loading = false;
            update();
        }
    }

    refreshButton?.addEventListener('click', fetchAll);

    void fetchAll();
    const refreshInterval = setInterval(fetchAll, 30000);
    const relativeTimeInterval = setInterval(update, 5000);

    return () => {
        clearInterval(refreshInterval);
        clearInterval(relativeTimeInterval);
        refreshButton?.removeEventListener('click', fetchAll);
        if (toastTimeout) clearTimeout(toastTimeout);
        render(null, leaderboardRoot);
        render(null, positionRoot);
        render(null, metricsRoot);
        render(null, addressRoot);
        render(null, toastRoot);
    };
}

declare global {
    namespace JSX {
        interface IntrinsicElements {
            a: any;
            aside: any;
            button: any;
            div: any;
            h2: any;
            main: any;
            p: any;
            section: any;
            span: any;
            table: any;
            tbody: any;
            td: any;
            th: any;
            thead: any;
            tr: any;
        }
    }
}
