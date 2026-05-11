import { createMeasure, type MeasureFn, type MeasureSyncFn } from 'measure-fn';
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
    amountUsd: number;
    payoutAmountSol: number;
    payoutAmountUsd: number;
    depositorAddress: string;
    depositorAddressShort: string;
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
    lastFeeDeltaSol: number;
    totalClaimedSol: number;
    treasuryBalanceSol: number;
    totalAccumulatedGravity: number;
    lastGravityDelta: number;
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

const frontendMeasure = createMeasure('frontend');
const { measure: measureFrontend, measureSync: measureFrontendSync } = frontendMeasure;

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
            if (!Number.isFinite(value) || value === 0) return '0 SOL';
            if (Math.abs(value) < 0.000001) {
                return `${Math.round(value * 1_000_000_000).toLocaleString()} lamports`;
            }
            if (Math.abs(value) < 0.01) {
                return `${value.toLocaleString(undefined, { maximumFractionDigits: 8 })} SOL`;
            }
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
        <div className="metrics-row">
            <div className="metric-card header-tooltip" data-tooltip="Current number of indexed wallets holding the token.">
                <div className="metric-label">Holders</div>
                <div className="metric-value"><AnimatedValue value={total} kind="int" /></div>
            </div>
            <div className="metric-card header-tooltip" data-tooltip="Current token market cap based on indexed supply and price.">
                <div className="metric-label">Market Cap</div>
                <div className="metric-value"><AnimatedValue value={marketCap} kind="usd" /></div>
            </div>
            <div className="metric-card header-tooltip" data-tooltip="Total SOL revenue tracked as deposited into the protocol treasury.">
                <div className="metric-label">Total Revenue</div>
                <div className="metric-value"><AnimatedValue value={totalFeesAccumulatedSol} kind="sol" /></div>
                <div className="metric-sub">deposited into treasury</div>
            </div>
            <div className="metric-card header-tooltip" data-tooltip="Total global gravity accumulated across all wallets.">
                <div className="metric-label">Total Gravity</div>
                <div className="metric-value"><AnimatedValue value={totalAccumulatedGravity} kind="gravity" /></div>
            </div>
            <div className="metric-card header-tooltip" data-tooltip="Current indexed epoch for continuous gravity accrual.">
                <div className="metric-label">Epoch</div>
                <div className="metric-value"><AnimatedValue value={epochIndex} kind="int" /></div>
            </div>
        </div>
    );
}

function InfoCards({
    runtimeConfig,
    totalFeesAccumulatedSol,
    totalClaimedSol,
    treasuryBalanceSol,
    totalAccumulatedGravity,
    lastGravityDelta,
}: {
    runtimeConfig: RuntimeConfig;
    totalFeesAccumulatedSol: number;
    totalClaimedSol: number;
    treasuryBalanceSol: number;
    totalAccumulatedGravity: number;
    lastGravityDelta: number;
}) {
    const accountExplorerBaseUrl = runtimeConfig.explorerTxBaseUrl.replace('/tx/', '/account/');
    const copyToClipboard = (text: string) => {
        void navigator.clipboard.writeText(text);
    };
    const balanceMatchesTrackedFlow = treasuryBalanceSol <= totalFeesAccumulatedSol + 0.0000001;
    const treasuryBalanceLabel = balanceMatchesTrackedFlow ? 'Current Balance' : 'On-chain Balance';
    const treasuryBalanceTooltip = balanceMatchesTrackedFlow
        ? 'Current treasury balance remaining after holder claims.'
        : 'On-chain balance can include direct transfers or deposits not represented in tracked protocol revenue.';

    return (
        <div className="info-row">
            <section className="info-card address-tooltip" data-tooltip={`Current circulating supply metrics for the integrated ${runtimeConfig.tokenSymbol} token.`}>
                <div className="info-card-head">
                    <div>
                        <div className="info-label">Token Mint</div>
                        <div className="info-title">{runtimeConfig.tokenSymbol} mint</div>
                    </div>
                    <button className="copy-btn" onClick={() => copyToClipboard(runtimeConfig.tokenMint)} title="Copy token mint" type="button">
                        Copy
                    </button>
                </div>
                <div className="info-value-row">
                    <div className="info-value">{shortAddress(runtimeConfig.tokenMint)}</div>
                </div>
                <a className="info-link" href={`${accountExplorerBaseUrl}${runtimeConfig.tokenMint}`} rel="noreferrer" target="_blank">
                    View on Solscan
                </a>
            </section>

            <section className="info-card address-tooltip" data-tooltip="Total SOL routed through the protocol versus SOL currently awaiting claim in the treasury.">
                <div className="info-card-head">
                    <div>
                        <div className="info-label">Treasury PDA</div>
                        <div className="info-title">Protocol treasury</div>
                    </div>
                    <button className="copy-btn" onClick={() => copyToClipboard(runtimeConfig.treasuryAddress)} title="Copy treasury PDA" type="button">
                        Copy
                    </button>
                </div>
                <div className="info-value-row">
                    <div className="info-value">{shortAddress(runtimeConfig.treasuryAddress)}</div>
                </div>
                <a className="info-link" href={`${accountExplorerBaseUrl}${runtimeConfig.treasuryAddress}`} rel="noreferrer" target="_blank">
                    View on Solscan
                </a>
                <div className="treasury-stats">
                    <div className="treasury-stat">
                        <span className="small-label">Total Revenue</span>
                        <span className="treasury-stat-value">{formatNumber(totalFeesAccumulatedSol, 'sol')}</span>
                    </div>
                    <div className="treasury-stat">
                        <span className="small-label">Claimed</span>
                        <span className="treasury-stat-value">{formatNumber(totalClaimedSol, 'sol')}</span>
                    </div>
                    <div className="treasury-stat">
                        <span className="small-label">{treasuryBalanceLabel}</span>
                        <span className="treasury-stat-value">{formatNumber(treasuryBalanceSol, 'sol')}</span>
                        <span className="treasury-note">{treasuryBalanceTooltip}</span>
                    </div>
                </div>
            </section>

            <section className="info-card address-tooltip" data-tooltip="The real-time state of the continuous accrual algorithm.">
                <div className="info-card-head">
                    <div>
                        <div className="info-label">Gravity Engine</div>
                        <div className="info-title">Global gravity</div>
                    </div>
                </div>
                <div className="info-value-row">
                    <div className="info-value">{formatNumber(totalAccumulatedGravity, 'gravity')}</div>
                </div>
                <div className="small-label">+{formatNumber(lastGravityDelta, 'gravity')} last epoch</div>
            </section>
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
                    <p className="connect-copy">Connect your wallet to see your gravity share, accumulated rewards, claimable balance, and payout history.</p>
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
                <div className="grid-cell">
                    <div className="cell-label">Claimable</div>
                    <div className="cell-value"><AnimatedValue value={walletTotals?.claimableSolRewards ?? 0} kind="sol" /></div>
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
                    <th>Deposited By</th>
                    <th className="th-num">You Got</th>
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
                            <td className="td-num td-emerald">
                                <div>{formatNumber(event.amountSol, 'sol')}</div>
                                <div className="num-sub">{formatNumber(event.amountUsd, 'usd')}</div>
                            </td>
                            <td>
                                {event.depositorAddress ? (
                                    <>
                                        <span className="wallet-mono">{event.depositorAddressShort}</span>
                                        <div className="wallet-sub">{event.depositorAddress}</div>
                                    </>
                                ) : 'Unknown'}
                            </td>
                            <td className="td-num td-cyan">
                                {connectedAddress ? (
                                    <>
                                        <div>{formatNumber(event.payoutAmountSol, 'sol')}</div>
                                        <div className="num-sub">{formatNumber(event.payoutAmountUsd, 'usd')}</div>
                                    </>
                                ) : 'Connect wallet'}
                            </td>
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
        <div className="activity-shell">
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

            <div className="leaderboard-panel">
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
    return measureFrontendSync('mount page client', () => {
        const runtimeConfig = getRuntimeConfig();
        const leaderboardRoot = document.getElementById('leaderboard-root');
        const positionRoot = document.getElementById('wallet-position-root');
        const metricsRoot = document.getElementById('hero-metrics-root');
        const infoRoot = document.getElementById('hero-info-root');
        const toastRoot = document.getElementById('toast-root');
        const refreshButton = document.getElementById('refresh-button') as HTMLButtonElement | null;
        const summary = document.getElementById('leaderboard-summary');
        const boardTitle = document.querySelector('.board-title');

        if (!leaderboardRoot || !positionRoot || !metricsRoot || !infoRoot || !toastRoot) return;

        let entries: LeaderboardEntry[] = [];
        let treasuryEvents: TreasuryEvent[] = [];
        let total = 0;
        let totalSupply = 0;
        let tokenPriceUsd = 0;
        let epochIndex = 0;
        let totalFeesAccumulatedSol = 0;
        let lastFeeDeltaSol = 0;
        let totalClaimedSol = 0;
        let treasuryBalanceSol = 0;
        let totalAccumulatedGravity = 0;
        let lastGravityDelta = 0;
        let activeTab: ActivityTab = 'leaderboard';
        let loading = true;
        let error: string | null = null;
        let walletError: string | null = null;
        let connectedAddress: string | null = null;
        let walletTotals: WalletTotals | null = null;
        let toast: ToastState | null = null;
        let toastTimeout: ReturnType<typeof setTimeout> | null = null;
        let lastRefreshAt = Date.now();

        const renderMetrics = () => measureFrontendSync('render metrics row', () => {
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
            animateNumbers(metricsRoot);
            return { total, epochIndex, totalFeesAccumulatedSol };
        });

        const renderInfoCards = () => measureFrontendSync('render info row', () => {
            render(
                <InfoCards
                    runtimeConfig={runtimeConfig}
                    totalFeesAccumulatedSol={totalFeesAccumulatedSol}
                    totalClaimedSol={totalClaimedSol}
                    treasuryBalanceSol={treasuryBalanceSol}
                    totalAccumulatedGravity={totalAccumulatedGravity}
                    lastGravityDelta={lastGravityDelta}
                />,
                infoRoot
            );
            return { treasuryBalanceSol, totalAccumulatedGravity };
        });

        const renderWalletPanel = () => measureFrontendSync('render wallet panel', () => {
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
            animateNumbers(positionRoot);
            return {
                connected: Boolean(connectedAddress),
                ranked: Boolean(walletTotals?.rank),
                walletError: Boolean(walletError),
            };
        });

        const renderActivityPanel = () => measureFrontendSync('render activity panel', () => {
            render(
                <ActivityPanel
                    runtimeConfig={runtimeConfig}
                    activeTab={activeTab}
                    setActiveTab={(tab) => {
                        activeTab = tab;
                        update('tab-switch');
                    }}
                    entries={entries}
                    treasuryEvents={treasuryEvents}
                    loading={loading}
                    error={error}
                    connectedAddress={connectedAddress}
                />,
                leaderboardRoot
            );
            return {
                activeTab,
                entries: entries.length,
                treasuryEvents: treasuryEvents.length,
                loading,
            };
        });

        const renderToast = () => measureFrontendSync('render toast', () => {
            render(<Toast toast={toast} explorerTxBaseUrl={runtimeConfig.explorerTxBaseUrl} />, toastRoot);
            return { visible: Boolean(toast) };
        });

        const updateBoardChrome = () => measureFrontendSync('update board chrome', () => {
            if (boardTitle) {
                boardTitle.textContent = activeTab === 'leaderboard' ? 'Holder Gravity Leaderboard' : 'Treasury Additions';
            }
            if (summary) {
                summary.textContent = activeTab === 'leaderboard'
                    ? (total > 0
                        ? `Holders ranked by accumulated gravity share and earned SOL rewards · updated ${formatRelativeTime(lastRefreshAt)}`
                        : 'Waiting for indexer data...')
                    : (treasuryEvents.length > 0
                        ? `Revenue deposits recorded for this reward pool · updated ${formatRelativeTime(lastRefreshAt)}`
                        : 'Waiting for treasury additions...');
            }

            if (refreshButton) refreshButton.classList.toggle('is-loading', loading);
            return { loading, activeTab };
        });

        const updateRelativeTimeOnly = () => measureFrontendSync('update relative time only', () => {
            if (summary) {
                summary.textContent = activeTab === 'leaderboard'
                    ? (total > 0
                        ? `${total.toLocaleString()} holders · ${formatNumber(totalFeesAccumulatedSol, 'sol')} revenue · updated ${formatRelativeTime(lastRefreshAt)}`
                        : 'Waiting for indexer data...')
                    : (treasuryEvents.length > 0
                        ? `${treasuryEvents.length.toLocaleString()} recent additions · treasury balance ${formatNumber(treasuryBalanceSol, 'sol')} · updated ${formatRelativeTime(lastRefreshAt)}`
                        : 'Waiting for treasury additions...');
            }
            return { activeTab, total, treasuryEvents: treasuryEvents.length };
        });

        const update = (reason = 'unknown') => measureFrontendSync(`update ui (${reason})`, (ms) => {
            ms('render metrics row', () => {
                return renderMetrics();
            });

            ms('render info row', () => {
                return renderInfoCards();
            });

            ms('render wallet panel', () => {
                return renderWalletPanel();
            });

            ms('render activity panel', () => {
                return renderActivityPanel();
            });

            ms('render toast', () => {
                return renderToast();
            });

            ms('update board chrome', () => {
                return updateBoardChrome();
            });

            return {
                reason,
                total,
                treasuryEvents: treasuryEvents.length,
                connected: Boolean(connectedAddress),
            };
        });

        const showToast = (nextToast: ToastState) => {
            toast = nextToast;
            if (toastTimeout) clearTimeout(toastTimeout);
            toastTimeout = setTimeout(() => {
                toast = null;
                update('toast-timeout');
            }, 7000);
            update('show-toast');
        };

        async function loadWalletTotals() {
            return await measureFrontend('load wallet totals', async () => {
                if (!connectedAddress) {
                    walletTotals = null;
                    return { connected: false };
                }

                const response = await fetch(`/api/wallet?address=${encodeURIComponent(connectedAddress)}`);
                const data: WalletResponse = await response.json();
                walletTotals = data.success ? data.wallet : null;
                return {
                    connected: true,
                    success: data.success,
                    ranked: Boolean(walletTotals?.rank),
                };
            });
        }

        async function connectWallet() {
            return await measureFrontend('connect wallet', async (m: MeasureFn) => {
                walletError = null;
                const provider = (window as any).solana;
                if (!provider?.isPhantom || typeof provider.connect !== 'function') {
                    walletError = 'Phantom wallet was not found in this browser.';
                    update('connect-missing-provider');
                    return { success: false, reason: 'missing-provider' };
                }

                try {
                    const result = await m('phantom connect request', () => provider.connect({ onlyIfTrusted: false }));
                    connectedAddress = String((result as { publicKey?: { toString(): string } } | null)?.publicKey ?? '');
                    showToast({ kind: 'success', message: `Connected ${shortAddress(connectedAddress)}` });
                    await m('refresh after wallet connect', () => fetchAll('wallet-connect'));
                    return { success: true, connectedAddress };
                } catch (connectError: any) {
                    walletError = typeof connectError?.message === 'string' ? connectError.message : 'Wallet connection failed.';
                }

                update('connect-error');
                return { success: false, reason: 'connect-error' };
            });
        }

        async function claimRewards() {
            return await measureFrontend('claim rewards', async (m: MeasureFn) => {
                walletError = null;
                let signature: string | undefined;

                try {
                    if (!connectedAddress) {
                        walletError = 'Connect wallet first.';
                        update('claim-no-wallet');
                        return { success: false, reason: 'no-wallet' };
                    }
                    if (!runtimeConfig.claimEnabled) {
                        walletError = 'Backend signer keypair is not configured on the web process.';
                        update('claim-disabled');
                        return { success: false, reason: 'claim-disabled' };
                    }

                    const phantom = (window as any).solana;
                    if (!phantom?.isPhantom || typeof phantom.signTransaction !== 'function') {
                        walletError = 'Phantom wallet was not found in this browser.';
                        update('claim-missing-provider');
                        return { success: false, reason: 'missing-provider' };
                    }

                    const response = await m('request claim transaction', () => fetch('/api/claim', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ address: connectedAddress }),
                    }));
                    if (!response) {
                        throw new Error('Unable to prepare claim transaction.');
                    }
                    const data = await m('parse claim transaction payload', () => response.json() as Promise<any>);
                    if (!data) {
                        throw new Error('Unable to parse claim transaction.');
                    }
                    if (!response.ok) {
                        walletError = data.error ?? 'Claim is not available yet.';
                        update('claim-request-error');
                        return { success: false, reason: 'claim-request-error' };
                    }

                    const web3 = await m('load web3 claim dependencies', () => import('@solana/web3.js'));
                    if (!web3) {
                        throw new Error('Unable to load web3 claim dependencies.');
                    }
                    const { Connection, Transaction } = web3 as typeof import('@solana/web3.js');
                    const tx = measureFrontendSync('decode claim transaction', () =>
                        Transaction.from(Uint8Array.from(atob(data.transaction), (char) => char.charCodeAt(0)))
                    );
                    if (!tx) {
                        throw new Error('Unable to decode claim transaction.');
                    }
                    const signed = await m('sign claim transaction', () => phantom.signTransaction(tx));
                    if (!signed) {
                        throw new Error('Unable to sign claim transaction.');
                    }
                    const conn = new Connection(runtimeConfig.rpcUrl, 'confirmed');
                    signature = (await m('submit signed transaction', () =>
                        conn.sendRawTransaction((signed as any).serialize(), { skipPreflight: false })
                    )) ?? undefined;
                    if (!signature) {
                        throw new Error('Claim transaction submission failed.');
                    }
                    const confirmedSignature = signature;
                    const confirmation = await m('confirm claim transaction', () => conn.confirmTransaction({
                        signature: confirmedSignature,
                        blockhash: data.blockhash,
                        lastValidBlockHeight: data.lastValidBlockHeight,
                    }, 'confirmed')) as Awaited<ReturnType<typeof conn.confirmTransaction>> | null;
                    if (!confirmation) {
                        throw new Error('Claim transaction confirmation failed.');
                    }
                    if (confirmation.value.err) {
                        throw new Error(typeof confirmation.value.err === 'string'
                            ? confirmation.value.err
                            : JSON.stringify(confirmation.value.err));
                    }

                    await m('report claim confirmation', () => fetch('/api/claim', {
                        method: 'PUT',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ address: connectedAddress, signature }),
                    }));

                    await m('refresh after claim', () => fetchAll('claim-success'));
                    showToast({ kind: 'success', message: 'Rewards claimed successfully.', txSignature: signature });
                    return { success: true, signature };
                } catch (claimError: any) {
                    walletError = claimError?.message || 'Claim request failed.';
                    showToast({ kind: 'error', message: walletError ?? 'Claim request failed.', txSignature: signature });
                }

                update('claim-error');
                return { success: false, reason: 'claim-error' };
            });
        }

        async function fetchAll(reason = 'manual-refresh') {
            return await measureFrontend(`fetch all (${reason})`, async (m: MeasureFn, ms: MeasureSyncFn) => {
                try {
                    loading = true;
                    ms('mark loading and render', () => update(`fetch-start:${reason}`));

                    const suffix = connectedAddress ? `?wallet=${encodeURIComponent(connectedAddress)}` : '';
                    const [leaderboardResponse, treasuryResponse] = await Promise.all([
                        m('fetch leaderboard api', () => fetch(`/api/leaderboard${suffix}`)),
                        m('fetch treasury api', () => fetch(`/api/treasury${suffix}`)),
                    ]);
                    if (!leaderboardResponse || !treasuryResponse) {
                        throw new Error('Activity API request failed.');
                    }

                    const [leaderboardData, treasuryData] = await Promise.all([
                        m('parse leaderboard payload', () => leaderboardResponse.json() as Promise<LeaderboardResponse>),
                        m('parse treasury payload', () => treasuryResponse.json() as Promise<TreasuryResponse>),
                    ]);
                    if (!leaderboardData || !treasuryData) {
                        throw new Error('Activity API payload parsing failed.');
                    }

                    if (leaderboardData.success) {
                        entries = ms('normalize leaderboard entries', () => leaderboardData.entries
                            .filter((entry) => entry.tokenBalance > 0)
                            .sort((a, b) => {
                                if (b.gravityShare !== a.gravityShare) return b.gravityShare - a.gravityShare;
                                if (b.accumulatedGravity !== a.accumulatedGravity) return b.accumulatedGravity - a.accumulatedGravity;
                                return b.tokenBalance - a.tokenBalance;
                            })
                            .map((entry, index) => ({ ...entry, rank: index + 1 }))
                        ) ?? [];
                        total = entries.length;
                        totalSupply = leaderboardData.totalSupply;
                        tokenPriceUsd = leaderboardData.tokenPriceUsd;
                        epochIndex = leaderboardData.epochIndex;
                        totalFeesAccumulatedSol = leaderboardData.totalFeesAccumulatedSol;
                        lastFeeDeltaSol = leaderboardData.lastFeeDeltaSol;
                        totalClaimedSol = leaderboardData.totalClaimedSol;
                        treasuryBalanceSol = leaderboardData.treasuryBalanceSol;
                        totalAccumulatedGravity = leaderboardData.totalAccumulatedGravity;
                        lastGravityDelta = leaderboardData.lastGravityDelta;
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

                    await m('refresh wallet totals', () => loadWalletTotals());
                } catch {
                    error = 'Error fetching indexed activity data.';
                } finally {
                    loading = false;
                    ms('final render after fetch', () => update(`fetch-finish:${reason}`));
                }

                return {
                    reason,
                    entries: entries.length,
                    treasuryEvents: treasuryEvents.length,
                    connected: Boolean(connectedAddress),
                };
            });
        }

        const handleRefreshClick = () => {
            void fetchAll('refresh-button');
        };
        refreshButton?.addEventListener('click', handleRefreshClick);

        void fetchAll('initial-load');
        const refreshInterval = setInterval(() => {
            void fetchAll('interval-refresh');
        }, 30000);
        const relativeTimeInterval = setInterval(() => {
            measureFrontendSync('relative-time tick', () => {
                updateRelativeTimeOnly();
                return { activeTab };
            });
        }, 5000);

        return () => {
            measureFrontendSync('unmount page client', (ms) => {
                clearInterval(refreshInterval);
                clearInterval(relativeTimeInterval);
                refreshButton?.removeEventListener('click', handleRefreshClick);
                if (toastTimeout) clearTimeout(toastTimeout);
                ms('clear rendered roots', () => {
                    render(null, leaderboardRoot);
                    render(null, positionRoot);
                    render(null, metricsRoot);
                    render(null, infoRoot);
                    render(null, toastRoot);
                    return { cleared: 5 };
                });
                return { activeTab, connected: Boolean(connectedAddress) };
            });
        };
    });
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
