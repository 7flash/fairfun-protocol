import { createMeasure, type MeasureFn, type MeasureSyncFn } from "measure-fn";
import { render } from "tradjs/client";

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
  totalSolRewardsClaimed: number;
  claimableSolRewards?: number;
  delegatedClaimsEnabled?: boolean;
}

interface TreasuryEvent {
  signature: string;
  amountSol: number;
  payoutAmountSol: number;
  payoutAmountUsd: number;
  eligibleHolderCount: number;
  depositorAddress: string;
  depositorAddressShort: string;
  timestamp: number;
}

interface ClaimEvent {
  signature: string;
  claimantCount: number;
  claimantAddress: string;
  claimantAddressShort: string;
  delegatorAddress: string;
  delegatorAddressShort: string;
  grossAmountSol: number;
  grossAmountSolFormatted: string;
  claimantAmountSol: number;
  claimantAmountSolFormatted: string;
  projectFeeSol: number;
  projectFeeSolFormatted: string;
  claimantTokenAmount: number;
  claimantTokenAmountFormatted: string;
  mode: string;
  timestamp: number;
  recipients: ClaimRecipient[];
}

interface ClaimRecipient {
  claimantAddress: string;
  claimantAddressShort: string;
  grossAmountSol: number;
  grossAmountSolFormatted: string;
  claimantAmountSol: number;
  claimantAmountSolFormatted: string;
  claimantTokenAmount: number;
  claimantTokenAmountFormatted: string;
}

interface ClaimsSummary {
  totalClaims: number;
  totalGrossSol: number;
  totalClaimantSol: number;
  totalProjectFeeSol: number;
  totalClaimantTokens: number;
  totalDistributedTokens: number;
}

interface TreasurySummary {
  totalDepositedSol: number;
  creatorFeeTopupTotalSol: number;
  externalRevenueSol: number;
  currentUnclaimedCreatorFeeSol: number;
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
  delegatedClaimsEnabled: boolean;
  projectFeeBps: number;
  projectFeePercent: number;
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
  summary: TreasurySummary;
}

interface ClaimsResponse {
  success: boolean;
  events: ClaimEvent[];
  total: number;
  summary: ClaimsSummary;
}

interface WalletResponse {
  success: boolean;
  wallet: WalletTotals;
}

interface ToastState {
  kind: "success" | "error";
  message: string;
  txSignature?: string;
}

interface DelegationPreferenceResponse {
  success: boolean;
  transaction?: string;
  blockhash?: string;
  lastValidBlockHeight?: number;
  delegatedClaimsEnabled?: boolean;
  error?: string;
}

type NumberFormatKind = "tokens" | "usd" | "gravity" | "sol" | "int";
type ActivityTab = "leaderboard" | "treasury" | "claims";
type LeaderboardSortKey = "earned" | "gravity" | "balance" | "ownership";
type SortDirection = "asc" | "desc";

interface RuntimeConfig {
  rpcUrl: string;
  treasuryAddress: string;
  programId: string;
  tokenMint: string;
  tokenSymbol: string;
  projectName: string;
  explorerTxBaseUrl: string;
  claimEnabled: boolean;
}

const frontendMeasure = createMeasure("frontend");
const { measure: measureFrontend, measureSync: measureFrontendSync } =
  frontendMeasure;

function shortAddress(address: string) {
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function copyWithFeedback(
  button: HTMLButtonElement | null,
  text: string,
  label = "Copy",
  successLabel = "Copied",
) {
  if (!button) return;
  const originalText = button.textContent ?? label;
  void navigator.clipboard
    .writeText(text)
    .then(() => {
      button.textContent = successLabel;
      button.disabled = true;
      setTimeout(() => {
        button.textContent = originalText || label;
        button.disabled = false;
      }, 1200);
    })
    .catch(() => {
      button.textContent = originalText || label;
    });
}

function RankTag({ rank }: { rank: number }) {
  const padded = String(rank).padStart(2, "0");
  const hot = rank <= 3;
  return (
    <span className="rank-tag">
      <span className="rank-bracket">[</span>
      <span className={`rank-digits ${hot ? "rank-digits-hot" : ""}`}>
        {padded}
      </span>
      <span className="rank-bracket">]</span>
    </span>
  );
}

function getRuntimeConfig(): RuntimeConfig {
  const configRoot = document.getElementById("app-config-root");
  return {
    rpcUrl: configRoot?.getAttribute("data-rpc-url") ?? "",
    treasuryAddress: configRoot?.getAttribute("data-treasury-address") ?? "",
    programId: configRoot?.getAttribute("data-program-id") ?? "",
    tokenMint: configRoot?.getAttribute("data-token-mint") ?? "",
    tokenSymbol: configRoot?.getAttribute("data-token-symbol") ?? "TOKEN",
    projectName: configRoot?.getAttribute("data-project-name") ?? "FairFun",
    explorerTxBaseUrl:
      configRoot?.getAttribute("data-explorer-tx-base-url") ??
      "https://solscan.io/tx/",
    claimEnabled: configRoot?.getAttribute("data-claim-enabled") === "true",
  };
}

function formatNumber(value: number, kind: NumberFormatKind) {
  switch (kind) {
    case "usd":
      if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
      if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
      if (value > 0 && value < 0.01) return `$${value.toFixed(6)}`;
      return `$${value.toFixed(2)}`;
    case "gravity":
      if (value >= 1_000_000_000)
        return `${(value / 1_000_000_000).toFixed(2)}B`;
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
      if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
      return value.toFixed(2);
    case "sol":
      if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K SOL`;
      if (!Number.isFinite(value) || value === 0) return "0 SOL";
      if (Math.abs(value) < 0.000001) {
        return `${Math.round(value * 1_000_000_000).toLocaleString()} lamports`;
      }
      if (Math.abs(value) < 0.01) {
        return `${value.toLocaleString(undefined, { maximumFractionDigits: 8 })} SOL`;
      }
      return `${value.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL`;
    case "tokens":
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
      if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
      return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    case "int":
      return Math.round(value).toLocaleString();
  }
}

function formatRelativeTime(timestamp: number) {
  if (!timestamp) return "just now";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatCompactTimestamp(timestamp: number) {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatSignedGravityDelta(value: number) {
  if (value > 0) return `(+${formatNumber(value, "gravity")})`;
  if (value < 0) return `(${formatNumber(value, "gravity")})`;
  return "(0)";
}

function AnimatedValue({
  value,
  kind,
}: {
  value: number;
  kind: NumberFormatKind;
}) {
  return (
    <span
      className="animated-number"
      data-animate-number="true"
      data-target={String(value)}
      data-format={kind}
    >
      {formatNumber(value, kind)}
    </span>
  );
}

function animateNumbers(scope: ParentNode) {
  const nodes = scope.querySelectorAll<HTMLElement>(
    '[data-animate-number="true"]',
  );
  nodes.forEach((node) => {
    const target = Number(node.dataset.target ?? "0");
    const kind = (node.dataset.format ?? "int") as NumberFormatKind;
    const current = Number(node.dataset.current ?? "0");
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
        node.classList.add("value-updated");
        setTimeout(() => node.classList.remove("value-updated"), 900);
      }
    };
    requestAnimationFrame(step);
  });
}

function InfoCards({
  runtimeConfig,
  total,
  totalSupply,
  tokenPriceUsd,
  totalFeesAccumulatedSol,
  treasuryBalanceSol,
  totalAccumulatedGravity,
  lastGravityDelta,
  epochIndex,
}: {
  runtimeConfig: RuntimeConfig;
  total: number;
  totalSupply: number;
  tokenPriceUsd: number;
  totalFeesAccumulatedSol: number;
  treasuryBalanceSol: number;
  totalAccumulatedGravity: number;
  lastGravityDelta: number;
  epochIndex: number;
}) {
  const accountExplorerBaseUrl = runtimeConfig.explorerTxBaseUrl.replace(
    "/tx/",
    "/account/",
  );
  const marketCap = totalSupply * tokenPriceUsd;

  return (
    <div className="info-row">
      <section className="info-card">
        <div className="info-card-head">
          <div className="info-label">Token Pool</div>
          <div className="card-address-row">
            <a
              className="card-address-link"
              href={`${accountExplorerBaseUrl}${runtimeConfig.tokenMint}`}
              rel="noreferrer"
              target="_blank"
            >
              {shortAddress(runtimeConfig.tokenMint)}
            </a>
            <button
              className="copy-btn copy-btn-inline"
              onClick={(event: any) =>
                copyWithFeedback(
                  event.currentTarget as HTMLButtonElement,
                  runtimeConfig.tokenMint,
                )
              }
              title="Copy token mint"
              type="button"
            >
              Copy
            </button>
          </div>
        </div>
        <div className="card-metrics-grid">
          <div className="metric-block">
            <div
              className="small-label header-tooltip"
              data-tooltip="Estimated token market cap from indexed token price and supply."
            >
              Market Cap
            </div>
            <div className="inline-value">
              <AnimatedValue value={marketCap} kind="usd" />
            </div>
          </div>
          <div className="metric-block metric-block-right">
            <span
              className="small-label header-tooltip"
              data-tooltip="Number of wallets currently indexed as holding this token."
            >
              Holders
            </span>
            <span className="inline-value">
              <AnimatedValue value={total} kind="int" />
            </span>
          </div>
        </div>
      </section>

      <section className="info-card">
        <div className="info-card-head">
          <div className="info-label">Treasury</div>
          <div className="card-address-row">
            <a
              className="card-address-link"
              href={`${accountExplorerBaseUrl}${runtimeConfig.treasuryAddress}`}
              rel="noreferrer"
              target="_blank"
            >
              {shortAddress(runtimeConfig.treasuryAddress)}
            </a>
            <button
              className="copy-btn copy-btn-inline"
              onClick={(event: any) =>
                copyWithFeedback(
                  event.currentTarget as HTMLButtonElement,
                  runtimeConfig.treasuryAddress,
                )
              }
              title="Copy treasury PDA"
              type="button"
            >
              Copy
            </button>
          </div>
        </div>
        <div className="card-metrics-grid">
          <div className="metric-block">
            <span
              className="small-label header-tooltip"
              data-tooltip="SOL deposits recorded through the FairFun protocol deposit flow."
            >
              Total Deposited
            </span>
            <span className="inline-value">
              {formatNumber(totalFeesAccumulatedSol, "sol")}
            </span>
          </div>
          <div className="metric-block metric-block-right">
            <span className="small-label">Current Balance</span>
            <span className="inline-value">
              {formatNumber(treasuryBalanceSol, "sol")}
            </span>
          </div>
        </div>
      </section>

      <section className="info-card">
        <div className="info-card-head">
          <div className="info-label">Gravity Program</div>
          <div className="card-address-row">
            <a
              className="card-address-link"
              href={`${accountExplorerBaseUrl}${runtimeConfig.programId}`}
              rel="noreferrer"
              target="_blank"
            >
              {shortAddress(runtimeConfig.programId)}
            </a>
            <button
              className="copy-btn copy-btn-inline"
              onClick={(event: any) =>
                copyWithFeedback(
                  event.currentTarget as HTMLButtonElement,
                  runtimeConfig.programId,
                )
              }
              title="Copy program id"
              type="button"
            >
              Copy
            </button>
          </div>
        </div>
        <div className="card-metrics-grid">
          <div className="metric-block">
            <span
              className="small-label header-tooltip"
              data-tooltip="Total accumulated gravity across all indexed holders."
            >
              Global Gravity
            </span>
            <div className="inline-value-row">
              <AnimatedValue value={totalAccumulatedGravity} kind="gravity" />
              <span
                className={`metric-inline-delta ${lastGravityDelta > 0 ? "metric-inline-delta-positive" : "inline-value-muted"}`}
              >
                {formatSignedGravityDelta(lastGravityDelta)}
              </span>
            </div>
          </div>
          <div className="metric-block metric-block-right">
            <span
              className="small-label header-tooltip"
              data-tooltip="Current accounting update number."
            >
              Epoch
            </span>
            <span className="inline-value">{epochIndex.toLocaleString()}</span>
          </div>
        </div>
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
  setDelegatedClaimsEnabled,
  delegationPreferencePending,
  walletError,
}: {
  runtimeConfig: RuntimeConfig;
  connectedAddress: string | null;
  walletTotals: WalletTotals | null;
  total: number;
  connect: () => void;
  claim: () => void;
  setDelegatedClaimsEnabled: (enabled: boolean) => void;
  delegationPreferencePending: boolean;
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
          <p className="connect-copy">
            Connect your wallet to see your gravity share, accumulated rewards,
            claimable balance, and payout history.
          </p>
          <button
            onClick={connect}
            className="primary-button connect-cta"
            type="button"
          >
            <span>⬢</span>
            <span>Connect Phantom Wallet</span>
          </button>
        </div>
        {walletError ? <div className="inline-error">{walletError}</div> : null}
      </div>
    );
  }

  const claimableRewards = walletTotals?.claimableSolRewards ?? 0;
  const canClaim = Boolean(walletTotals?.claimEnabled && claimableRewards > 0);
  const earnedRewards = walletTotals?.totalSolRewardsEarned ?? 0;
  const claimedRewards = walletTotals?.totalSolRewardsClaimed ?? 0;
  return (
    <div className={`position-panel ${walletTotals?.rank ? "is-ranked" : ""}`}>
      <div className="position-head">
        <span className="position-label">Your Position</span>
        {walletTotals?.rank ? (
          <div className="rank-inline">
            Rank #{walletTotals.rank} of {total.toLocaleString()}
          </div>
        ) : null}
      </div>

      <div className="position-identity">
        <div className="identity-addr">
          {walletTotals?.addressShort ?? shortAddress(connectedAddress)}
        </div>
        <button
          className="copy-btn copy-btn-inline"
          onClick={(event: any) =>
            copyWithFeedback(
              event.currentTarget as HTMLButtonElement,
              connectedAddress,
            )
          }
          title="Copy wallet address"
          type="button"
        >
          Copy
        </button>
      </div>

      <div className="position-groups">
        <div className="position-group">
          <div className="group-label">Holdings</div>
          <div className="position-grid">
            <div className="grid-cell">
              <div className="cell-label">
                {runtimeConfig.tokenSymbol} Balance
              </div>
              <div className="cell-value">
                <AnimatedValue
                  value={walletTotals?.tokenBalance ?? 0}
                  kind="tokens"
                />
              </div>
            </div>
            <div className="grid-cell">
              <div className="cell-label">USD Value</div>
              <div className="cell-value">
                <AnimatedValue
                  value={walletTotals?.tokenValueUsd ?? 0}
                  kind="usd"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="position-group">
          <div className="group-label">Position</div>
          <div className="position-grid">
            <div className="grid-cell">
              <div className="cell-label">Gravity</div>
              <div className="cell-value">
                {formatNumber(walletTotals?.accumulatedGravity ?? 0, "gravity")}
              </div>
              <div className="num-sub">
                {walletTotals?.gravityShareFormatted ?? "0.000%"}
              </div>
            </div>
          </div>
        </div>

        <div className="position-group">
          <div className="group-label">Rewards</div>
          <div className="position-grid">
            <div className="grid-cell">
              <div className="cell-label">SOL Earned</div>
              <div className="cell-value">
                <AnimatedValue value={earnedRewards} kind="sol" />
              </div>
            </div>
            <div className="grid-cell">
              <div className="cell-label">Claimable</div>
              <div className="cell-value cell-value-accent">
                <AnimatedValue value={claimableRewards} kind="sol" />
              </div>
            </div>
            {claimedRewards > 0 ? (
              <div className="grid-cell">
                <div className="cell-label">Claimed</div>
                <div className="cell-value">
                  <AnimatedValue value={claimedRewards} kind="sol" />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {canClaim ? (
        <button className="claim-button" onClick={claim} type="button">
          Claim {formatNumber(claimableRewards, "sol")}
        </button>
      ) : null}

      {walletError ? <div className="inline-error">{walletError}</div> : null}
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <tr className="skeleton-row" key={index}>
          <td>
            <div className="skeleton sk-rank" />
          </td>
          <td>
            <div className="skeleton sk-wallet" />
          </td>
          <td>
            <div className="skeleton sk-num" />
          </td>
          <td>
            <div className="skeleton sk-num" />
          </td>
          <td>
            <div className="skeleton sk-num" />
          </td>
          <td>
            <div className="skeleton sk-num" />
          </td>
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
  sortKey,
  sortDirection,
  onSort,
}: {
  entries: LeaderboardEntry[];
  loading: boolean;
  error: string | null;
  connectedAddress: string | null;
  tokenSymbol: string;
  sortKey: LeaderboardSortKey;
  sortDirection: SortDirection;
  onSort: (key: LeaderboardSortKey) => void;
}) {
  const connectedAddressLower = connectedAddress?.toLowerCase() ?? null;
  const displayEntries = entries.slice(0, 150);
  const sortArrow = (key: LeaderboardSortKey) =>
    sortKey === key ? (sortDirection === "desc" ? " ↓" : " ↑") : "";

  return (
    <table className="leaderboard-table">
      <thead>
        <tr>
          <th className="th-rank">#</th>
          <th>Wallet</th>
          <th className="th-num">
            <button
              className="table-sort-button"
              onClick={() => onSort("balance")}
              type="button"
            >
              {tokenSymbol}
              {sortArrow("balance")}
            </button>
          </th>
          <th
            className="th-num header-tooltip"
            data-tooltip="Your share of total gravity, not your spot balance at a single snapshot."
          >
            <button
              className="table-sort-button"
              onClick={() => onSort("ownership")}
              type="button"
            >
              Gravity %{sortArrow("ownership")}
            </button>
          </th>
          <th className="th-num">
            <button
              className="table-sort-button"
              onClick={() => onSort("earned")}
              type="button"
            >
              Earned{sortArrow("earned")}
            </button>
          </th>
          <th className="th-num">Unclaimed</th>
        </tr>
      </thead>
      <tbody>
        {error ? (
          <tr>
            <td className="state-row error-state" colSpan={6}>
              {error}
            </td>
          </tr>
        ) : loading && entries.length === 0 ? (
          <SkeletonRows />
        ) : entries.length === 0 ? (
          <tr>
            <td className="state-row" colSpan={6}>
              No indexed holders found yet.
            </td>
          </tr>
        ) : (
          <>
            {displayEntries.map((entry) => {
              const isYou =
                connectedAddressLower === entry.address.toLowerCase();
              return (
                <tr
                  className={`leaderboard-row ${isYou ? "is-you" : ""}`}
                  key={entry.address}
                >
                  <td>
                    <RankTag rank={entry.rank} />
                  </td>
                  <td>
                    <span className="wallet-mono">{entry.addressShort}</span>
                    {isYou ? <span className="you-tag">YOU</span> : null}
                    <div className="wallet-sub">
                      Supply share {entry.percentSupplyFormatted}
                    </div>
                  </td>
                  <td className="td-num">
                    <div>{formatNumber(entry.tokenBalance, "tokens")}</div>
                    <div className="num-sub">
                      {formatNumber(entry.tokenValueUsd, "usd")}
                    </div>
                  </td>
                  <td className="td-num">{entry.gravityShareFormatted}</td>
                  <td className="td-num">
                    {formatNumber(entry.totalSolRewardsEarned, "sol")}
                  </td>
                  <td className="td-num">
                    {formatNumber(
                      entry.totalSolRewardsEarned -
                        entry.totalSolRewardsClaimed,
                      "sol",
                    )}
                  </td>
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
  summary,
  loading,
  error,
  connectedAddress,
}: {
  runtimeConfig: RuntimeConfig;
  events: TreasuryEvent[];
  summary: TreasurySummary | null;
  loading: boolean;
  error: string | null;
  connectedAddress: string | null;
}) {
  return (
    <>
      {summary ? (
        <div className="activity-stats-grid">
          <div className="activity-stat-card">
            <div className="small-label">External Revenue</div>
            <div className="inline-value">
              {formatNumber(summary.externalRevenueSol, "sol")}
            </div>
          </div>
          <div className="activity-stat-card">
            <div className="small-label">Creator Fees Routed</div>
            <div className="inline-value">
              {formatNumber(summary.creatorFeeTopupTotalSol, "sol")}
            </div>
          </div>
          <div className="activity-stat-card">
            <div className="small-label">Unclaimed Creator Fees</div>
            <div className="inline-value">
              {formatNumber(summary.currentUnclaimedCreatorFeeSol, "sol")}
            </div>
          </div>
        </div>
      ) : null}
      <table className="leaderboard-table">
        <thead>
          <tr>
            <th>When</th>
            <th className="th-num">Treasury Added</th>
            <th className="th-num">Eligible Holders</th>
            <th>Deposited By</th>
            <th className="th-num">You Got</th>
            <th>Transaction</th>
          </tr>
        </thead>
        <tbody>
          {error ? (
            <tr>
              <td className="state-row error-state" colSpan={6}>
                {error}
              </td>
            </tr>
          ) : loading && events.length === 0 ? (
            <SkeletonRows />
          ) : events.length === 0 ? (
            <tr>
              <td className="state-row" colSpan={6}>
                No treasury additions have been indexed yet.
              </td>
            </tr>
          ) : (
            events.map((event) => (
              <tr className="leaderboard-row" key={event.signature}>
                <td>
                  <div>{formatRelativeTime(event.timestamp)}</div>
                  <div className="wallet-sub">{formatCompactTimestamp(event.timestamp)}</div>
                </td>
                <td className="td-num">
                  <div>{formatNumber(event.amountSol, "sol")}</div>
                </td>
                <td className="td-num">
                  {formatNumber(event.eligibleHolderCount, "int")}
                </td>
                <td>
                  {event.depositorAddress ? (
                    <span className="wallet-mono">
                      {event.depositorAddressShort}
                    </span>
                  ) : (
                    "Unknown"
                  )}
                </td>
                <td className="td-num">
                  {connectedAddress ? (
                    <>
                      <div>{formatNumber(event.payoutAmountSol, "sol")}</div>
                      <div className="num-sub">
                        {formatNumber(event.payoutAmountUsd, "usd")}
                      </div>
                    </>
                  ) : (
                    "—"
                  )}
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
    </>
  );
}

function ClaimsTable({
  runtimeConfig,
  events,
  summary,
  loading,
  error,
  connectedAddress,
}: {
  runtimeConfig: RuntimeConfig;
  events: ClaimEvent[];
  summary: ClaimsSummary | null;
  loading: boolean;
  error: string | null;
  connectedAddress: string | null;
}) {
  return (
    <>
      {summary ? (
        <div className="activity-stats-grid">
          <div className="activity-stat-card">
            <div className="small-label">Claims</div>
            <div className="inline-value">
              {formatNumber(summary.totalClaims, "int")}
            </div>
          </div>
          <div className="activity-stat-card">
            <div className="small-label">Holder Payouts</div>
            <div className="inline-value">
              {formatNumber(summary.totalClaimantTokens, "tokens")} FAIRFUN
            </div>
            <div className="num-sub">
              {formatNumber(summary.totalClaimantSol, "sol")}
            </div>
          </div>
          <div className="activity-stat-card">
            <div className="small-label">Project Treasury</div>
            <div className="inline-value">
              {formatNumber(summary.totalProjectFeeSol, "sol")}
            </div>
            <div className="num-sub">
              retained before payout or swap
            </div>
          </div>
          <div className="activity-stat-card">
            <div className="small-label">Total Distributed</div>
            <div className="inline-value">
              {formatNumber(summary.totalDistributedTokens, "tokens")} FAIRFUN
            </div>
            <div className="num-sub">
              {formatNumber(summary.totalGrossSol, "sol")} gross
            </div>
          </div>
        </div>
      ) : null}
      <table className="leaderboard-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Claim</th>
            <th>Executed By</th>
            <th className="th-num">Holder Gets</th>
            <th className="th-num">Project Fee</th>
            <th>Transaction</th>
          </tr>
        </thead>
        <tbody>
          {error ? (
            <tr>
              <td className="state-row error-state" colSpan={6}>
                {error}
              </td>
            </tr>
          ) : loading && events.length === 0 ? (
            <SkeletonRows />
          ) : events.length === 0 ? (
            <tr>
              <td className="state-row" colSpan={6}>
                No claims have been indexed yet.
              </td>
            </tr>
          ) : (
            events.map((event) => {
              const isExecutor =
                connectedAddress?.toLowerCase() ===
                event.delegatorAddress.toLowerCase();
              const isTokenized = event.mode !== "direct";
              const isBatch = event.claimantCount > 1;
              const primaryRecipient = event.recipients[0];

              return (
                <tr className="leaderboard-row" key={event.signature}>
                  <td>
                    <div>{formatRelativeTime(event.timestamp)}</div>
                    <div className="wallet-sub">
                      {new Date(event.timestamp).toLocaleString()}
                    </div>
                  </td>
                  <td>
                    {isBatch ? (
                      <details className="claim-details">
                        <summary className="claim-details-summary">
                          <span className="wallet-mono">
                            {event.claimantCount} holders
                          </span>
                          <span className="claim-mode-tag">
                            {isTokenized ? "$FAIRFUN round" : "batch"}
                          </span>
                        </summary>
                        <div className="claim-recipient-list">
                          {event.recipients.map((recipient, index) => (
                            <div className="claim-recipient-row" key={`${event.signature}:${recipient.claimantAddress}`}>
                              <div className="claim-recipient-rank">
                                {index + 1}.
                              </div>
                              <div className="claim-recipient-wallet">
                                <span className="wallet-mono">
                                  {recipient.claimantAddressShort}
                                </span>
                                {connectedAddress?.toLowerCase() ===
                                recipient.claimantAddress.toLowerCase() ? (
                                  <span className="you-tag">YOU</span>
                                ) : null}
                              </div>
                              <div className="claim-recipient-amounts">
                                {isTokenized ? (
                                  <>
                                    <div>
                                      {recipient.claimantTokenAmountFormatted} FAIRFUN
                                    </div>
                                    <div className="num-sub">
                                      {recipient.claimantAmountSolFormatted}
                                    </div>
                                  </>
                                ) : (
                                  <div>{recipient.claimantAmountSolFormatted}</div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </details>
                    ) : (
                      <>
                        <span className="wallet-mono">
                          {event.claimantAddressShort}
                        </span>
                        {connectedAddress?.toLowerCase() ===
                        event.claimantAddress.toLowerCase() ? (
                          <span className="you-tag">YOU</span>
                        ) : null}
                      </>
                    )}
                    {!isBatch && primaryRecipient?.claimantTokenAmount ? (
                      <div className="wallet-sub">
                        {primaryRecipient.claimantTokenAmountFormatted} FAIRFUN
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {event.mode !== "direct" ? (
                      <>
                        <span className="wallet-mono">
                          {event.delegatorAddressShort}
                        </span>
                        {isExecutor ? (
                          <span className="you-tag">YOU</span>
                        ) : null}
                      </>
                    ) : (
                      "Self"
                    )}
                    {isTokenized ? (
                      <div className="wallet-sub">Auto-converted</div>
                    ) : null}
                  </td>
                  <td className="td-num">
                    {isTokenized ? (
                      <>
                        <div>{event.claimantTokenAmountFormatted} FAIRFUN</div>
                        <div className="num-sub">
                          {event.claimantAmountSolFormatted}
                        </div>
                      </>
                    ) : (
                      <>{event.claimantAmountSolFormatted}</>
                    )}
                  </td>
                  <td className="td-num">
                    {event.mode !== "direct" ? (
                      <>
                        <>{event.projectFeeSolFormatted}</>
                      </>
                    ) : (
                      <>{event.projectFeeSolFormatted}</>
                    )}
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
              );
            })
          )}
        </tbody>
      </table>
    </>
  );
}

function ActivityPanel({
  runtimeConfig,
  activeTab,
  setActiveTab,
  showOnlyMineActivity,
  setShowOnlyMineActivity,
  entries,
  treasuryEvents,
  claimEvents,
  treasurySummary,
  claimsSummary,
  loading,
  error,
  connectedAddress,
  liveText,
  sortKey,
  sortDirection,
  onSort,
}: {
  runtimeConfig: RuntimeConfig;
  activeTab: ActivityTab;
  setActiveTab: (tab: ActivityTab) => void;
  showOnlyMineActivity: boolean;
  setShowOnlyMineActivity: (value: boolean) => void;
  entries: LeaderboardEntry[];
  treasuryEvents: TreasuryEvent[];
  claimEvents: ClaimEvent[];
  treasurySummary: TreasurySummary | null;
  claimsSummary: ClaimsSummary | null;
  loading: boolean;
  error: string | null;
  connectedAddress: string | null;
  liveText: string;
  sortKey: LeaderboardSortKey;
  sortDirection: SortDirection;
  onSort: (key: LeaderboardSortKey) => void;
}) {
  return (
    <div className="activity-shell">
      <div className="ledger-header">
        <div className="ledger-copy">
          <h2 className="ledger-title">Reward Ledger</h2>
        </div>
      </div>

      <div className="ledger-toolbar">
        <div className="board-tabs">
          <button
            className={`board-tab ${activeTab === "leaderboard" ? "is-active" : ""}`}
            onClick={() => setActiveTab("leaderboard")}
            type="button"
          >
            Leaderboard
          </button>
          <button
            className={`board-tab ${activeTab === "treasury" ? "is-active" : ""}`}
            onClick={() => setActiveTab("treasury")}
            type="button"
          >
            Treasury Additions
          </button>
          <button
            className={`board-tab ${activeTab === "claims" ? "is-active" : ""}`}
            onClick={() => setActiveTab("claims")}
            type="button"
          >
            Claimed Rewards
          </button>
        </div>
        <div className="ledger-live">
          {connectedAddress ? (
            <button
              className={`board-tab board-tab-compact ${showOnlyMineActivity ? "is-active" : ""}`}
              onClick={() => setShowOnlyMineActivity(!showOnlyMineActivity)}
              type="button"
            >
              {showOnlyMineActivity ? "Only mine" : "All wallets"}
            </button>
          ) : null}
          <span className="live-dot">LIVE</span>
          <span className="ledger-meta-text">{liveText}</span>
        </div>
      </div>

      <div className="leaderboard-panel">
        {activeTab === "leaderboard" ? (
          <LeaderboardTable
            entries={entries}
            loading={loading}
            error={error}
            connectedAddress={connectedAddress}
            tokenSymbol={runtimeConfig.tokenSymbol}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSort={onSort}
          />
        ) : activeTab === "treasury" ? (
          <TreasuryTable
            runtimeConfig={runtimeConfig}
            events={treasuryEvents}
            summary={treasurySummary}
            loading={loading}
            error={error}
            connectedAddress={connectedAddress}
          />
        ) : (
          <ClaimsTable
            runtimeConfig={runtimeConfig}
            events={claimEvents}
            summary={claimsSummary}
            loading={loading}
            error={error}
            connectedAddress={connectedAddress}
          />
        )}
      </div>
    </div>
  );
}

function Toast({
  toast,
  explorerTxBaseUrl,
}: {
  toast: ToastState | null;
  explorerTxBaseUrl: string;
}) {
  if (!toast) return null;
  return (
    <div className={`toast toast-${toast.kind}`}>
      <div className="toast-message">{toast.message}</div>
      {toast.txSignature ? (
        <a
          className="toast-link"
          href={`${explorerTxBaseUrl}${toast.txSignature}`}
          rel="noreferrer"
          target="_blank"
        >
          View transaction
        </a>
      ) : null}
    </div>
  );
}

export default function mount() {
  return measureFrontendSync("mount page client", () => {
    const runtimeConfig = getRuntimeConfig();
    const leaderboardRoot = document.getElementById("leaderboard-root");
    const positionRoot = document.getElementById("wallet-position-root");
    const infoRoot = document.getElementById("hero-info-root");
    const toastRoot = document.getElementById("toast-root");

    if (!leaderboardRoot || !positionRoot || !infoRoot || !toastRoot) return;

    let entries: LeaderboardEntry[] = [];
    let treasuryEvents: TreasuryEvent[] = [];
    let claimEvents: ClaimEvent[] = [];
    let treasurySummary: TreasurySummary | null = null;
    let claimsSummary: ClaimsSummary | null = null;
    let total = 0;
    let totalSupply = 0;
    let tokenPriceUsd = 0;
    let epochIndex = 0;
    let totalFeesAccumulatedSol = 0;
    let totalClaimedSol = 0;
    let treasuryBalanceSol = 0;
    let totalAccumulatedGravity = 0;
    let lastGravityDelta = 0;
    let activeTab: ActivityTab = "leaderboard";
    let loading = true;
    let error: string | null = null;
    let walletError: string | null = null;
    let connectedAddress: string | null = null;
    let walletTotals: WalletTotals | null = null;
    let toast: ToastState | null = null;
    let toastTimeout: ReturnType<typeof setTimeout> | null = null;
    let lastRefreshAt = Date.now();
    let sortKey: LeaderboardSortKey = "earned";
    let sortDirection: SortDirection = "desc";
    let delegationPreferencePending = false;
    let showOnlyMineActivity = false;

    const getLedgerMeta = () => {
      if (totalAccumulatedGravity <= 0 && treasuryBalanceSol <= 0)
        return "Waiting for indexer data...";
      return `updated ${formatRelativeTime(lastRefreshAt)}`;
    };

    const renderInfoCards = () =>
      measureFrontendSync("render info row", () => {
        render(
          <InfoCards
            runtimeConfig={runtimeConfig}
            total={total}
            totalSupply={totalSupply}
            tokenPriceUsd={tokenPriceUsd}
            totalFeesAccumulatedSol={totalFeesAccumulatedSol}
            treasuryBalanceSol={treasuryBalanceSol}
            totalAccumulatedGravity={totalAccumulatedGravity}
            lastGravityDelta={lastGravityDelta}
            epochIndex={epochIndex}
          />,
          infoRoot,
        );
        animateNumbers(infoRoot);
        return { treasuryBalanceSol, totalAccumulatedGravity };
      });

    const renderWalletPanel = () =>
      measureFrontendSync("render wallet panel", () => {
        render(
          <PositionPanel
            runtimeConfig={runtimeConfig}
            connectedAddress={connectedAddress}
            walletTotals={walletTotals}
            total={total}
            connect={connectWallet}
            claim={claimRewards}
            setDelegatedClaimsEnabled={setDelegatedClaimsEnabled}
            delegationPreferencePending={delegationPreferencePending}
            walletError={walletError}
          />,
          positionRoot,
        );
        animateNumbers(positionRoot);
        return {
          connected: Boolean(connectedAddress),
          ranked: Boolean(walletTotals?.rank),
          walletError: Boolean(walletError),
        };
      });

    const renderActivityPanel = () =>
      measureFrontendSync("render activity panel", () => {
        render(
          <ActivityPanel
            runtimeConfig={runtimeConfig}
            activeTab={activeTab}
            setActiveTab={(tab) => {
              activeTab = tab;
              update("tab-switch");
            }}
            showOnlyMineActivity={showOnlyMineActivity}
            setShowOnlyMineActivity={(value) => {
              showOnlyMineActivity = value;
              void fetchAll("activity-filter-change");
            }}
            entries={entries}
            treasuryEvents={treasuryEvents}
            claimEvents={claimEvents}
            treasurySummary={treasurySummary}
            claimsSummary={claimsSummary}
            loading={loading}
            error={error}
            connectedAddress={connectedAddress}
            liveText={getLedgerMeta()}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSort={(key) => {
              if (sortKey === key) {
                sortDirection = sortDirection === "desc" ? "asc" : "desc";
              } else {
                sortKey = key;
                sortDirection = "desc";
              }
              update("sort-change");
            }}
          />,
          leaderboardRoot,
        );
        return {
          activeTab,
          entries: entries.length,
          treasuryEvents: treasuryEvents.length,
          claimEvents: claimEvents.length,
          loading,
        };
      });

    const renderToast = () =>
      measureFrontendSync("render toast", () => {
        render(
          <Toast
            toast={toast}
            explorerTxBaseUrl={runtimeConfig.explorerTxBaseUrl}
          />,
          toastRoot,
        );
        return { visible: Boolean(toast) };
      });

    const updateRelativeTimeOnly = () =>
      measureFrontendSync("update relative time only", () => {
        renderActivityPanel();
        return { activeTab, total, treasuryEvents: treasuryEvents.length };
      });

    const update = (reason = "unknown") =>
      measureFrontendSync(`update ui (${reason})`, (ms) => {
        ms("render info row", () => {
          return renderInfoCards();
        });

        ms("render wallet panel", () => {
          return renderWalletPanel();
        });

        ms("render activity panel", () => {
          return renderActivityPanel();
        });

        ms("render toast", () => {
          return renderToast();
        });

        return {
          reason,
          total,
          treasuryEvents: treasuryEvents.length,
          claimEvents: claimEvents.length,
          connected: Boolean(connectedAddress),
        };
      });

    const showToast = (nextToast: ToastState) => {
      toast = nextToast;
      if (toastTimeout) clearTimeout(toastTimeout);
      toastTimeout = setTimeout(() => {
        toast = null;
        update("toast-timeout");
      }, 7000);
      update("show-toast");
    };

    async function loadWalletTotals() {
      return await measureFrontend("load wallet totals", async () => {
        if (!connectedAddress) {
          walletTotals = null;
          return { connected: false };
        }

        const response = await fetch(
          `/api/wallet?address=${encodeURIComponent(connectedAddress)}`,
        );
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
      return await measureFrontend("connect wallet", async (m: MeasureFn) => {
        walletError = null;
        const provider = (window as any).solana;
        if (!provider?.isPhantom || typeof provider.connect !== "function") {
          walletError = "Phantom wallet was not found in this browser.";
          update("connect-missing-provider");
          return { success: false, reason: "missing-provider" };
        }

        try {
          const result = await m("phantom connect request", () =>
            provider.connect({ onlyIfTrusted: false }),
          );
          connectedAddress = String(
            (result as { publicKey?: { toString(): string } } | null)
              ?.publicKey ?? "",
          );
          showToast({
            kind: "success",
            message: `Connected ${shortAddress(connectedAddress)}`,
          });
          await m("refresh after wallet connect", () =>
            fetchAll("wallet-connect"),
          );
          return { success: true, connectedAddress };
        } catch (connectError: any) {
          walletError =
            typeof connectError?.message === "string"
              ? connectError.message
              : "Wallet connection failed.";
        }

        update("connect-error");
        return { success: false, reason: "connect-error" };
      });
    }

    async function claimRewards() {
      return await measureFrontend("claim rewards", async (m: MeasureFn) => {
        walletError = null;
        let signature: string | undefined;

        try {
          if (!connectedAddress) {
            walletError = "Connect wallet first.";
            update("claim-no-wallet");
            return { success: false, reason: "no-wallet" };
          }
          if (!runtimeConfig.claimEnabled) {
            walletError =
              "Backend signer keypair is not configured on the web process.";
            update("claim-disabled");
            return { success: false, reason: "claim-disabled" };
          }

          const phantom = (window as any).solana;
          if (
            !phantom?.isPhantom ||
            typeof phantom.signTransaction !== "function"
          ) {
            walletError = "Phantom wallet was not found in this browser.";
            update("claim-missing-provider");
            return { success: false, reason: "missing-provider" };
          }

          const response = await m("request claim transaction", () =>
            fetch("/api/claim", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ address: connectedAddress }),
            }),
          );
          if (!response) {
            throw new Error("Unable to prepare claim transaction.");
          }
          const data = await m(
            "parse claim transaction payload",
            () => response.json() as Promise<any>,
          );
          if (!data) {
            throw new Error("Unable to parse claim transaction.");
          }
          if (!response.ok) {
            walletError = data.error ?? "Claim is not available yet.";
            update("claim-request-error");
            return { success: false, reason: "claim-request-error" };
          }

          const web3 = await m(
            "load web3 claim dependencies",
            () => import("@solana/web3.js"),
          );
          if (!web3) {
            throw new Error("Unable to load web3 claim dependencies.");
          }
          const { Connection, Transaction } =
            web3 as typeof import("@solana/web3.js");
          const tx = measureFrontendSync("decode claim transaction", () =>
            Transaction.from(
              Uint8Array.from(atob(data.transaction), (char) =>
                char.charCodeAt(0),
              ),
            ),
          );
          if (!tx) {
            throw new Error("Unable to decode claim transaction.");
          }
          const signed = await m("sign claim transaction", () =>
            phantom.signTransaction(tx),
          );
          if (!signed) {
            throw new Error("Unable to sign claim transaction.");
          }
          const conn = new Connection(runtimeConfig.rpcUrl, "confirmed");
          signature =
            (await m("submit signed transaction", () =>
              conn.sendRawTransaction((signed as any).serialize(), {
                skipPreflight: false,
              }),
            )) ?? undefined;
          if (!signature) {
            throw new Error("Claim transaction submission failed.");
          }
          const confirmedSignature = signature;
          const confirmation = (await m("confirm claim transaction", () =>
            conn.confirmTransaction(
              {
                signature: confirmedSignature,
                blockhash: data.blockhash,
                lastValidBlockHeight: data.lastValidBlockHeight,
              },
              "confirmed",
            ),
          )) as Awaited<ReturnType<typeof conn.confirmTransaction>> | null;
          if (!confirmation) {
            throw new Error("Claim transaction confirmation failed.");
          }
          if (confirmation.value.err) {
            throw new Error(
              typeof confirmation.value.err === "string"
                ? confirmation.value.err
                : JSON.stringify(confirmation.value.err),
            );
          }

          await m("report claim confirmation", () =>
            fetch("/api/claim", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ address: connectedAddress, signature }),
            }),
          );

          await m("refresh after claim", () => fetchAll("claim-success"));
          showToast({
            kind: "success",
            message: "Rewards claimed successfully.",
            txSignature: signature,
          });
          return { success: true, signature };
        } catch (claimError: any) {
          walletError = claimError?.message || "Claim request failed.";
          showToast({
            kind: "error",
            message: walletError ?? "Claim request failed.",
            txSignature: signature,
          });
        }

        update("claim-error");
        return { success: false, reason: "claim-error" };
      });
    }

    async function delegatedClaim(claimantAddress: string) {
      return await measureFrontend("delegated claim", async (m: MeasureFn) => {
        walletError = null;
        let signature: string | undefined;

        try {
          if (!connectedAddress) {
            walletError = "Connect wallet first.";
            update("delegated-claim-no-wallet");
            return { success: false, reason: "no-wallet" };
          }
          if (!runtimeConfig.claimEnabled) {
            walletError =
              "Backend signer keypair is not configured on the web process.";
            update("delegated-claim-disabled");
            return { success: false, reason: "claim-disabled" };
          }

          const phantom = (window as any).solana;
          if (
            !phantom?.isPhantom ||
            typeof phantom.signTransaction !== "function"
          ) {
            walletError = "Phantom wallet was not found in this browser.";
            update("delegated-claim-missing-provider");
            return { success: false, reason: "missing-provider" };
          }

          const response = await m("request delegated claim transaction", () =>
            fetch("/api/claim/delegated", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                delegatorAddress: connectedAddress,
                claimantAddress: claimantAddress,
              }),
            }),
          );
          if (!response) {
            throw new Error("Unable to prepare delegated claim transaction.");
          }
          const data = await m(
            "parse delegated claim transaction payload",
            () => response.json() as Promise<any>,
          );
          if (!data) {
            throw new Error("Unable to parse delegated claim transaction.");
          }
          if (!response.ok) {
            walletError = data.error ?? "Delegated claim is not available yet.";
            update("delegated-claim-request-error");
            return { success: false, reason: "delegated-claim-request-error" };
          }

          const web3 = await m(
            "load web3 claim dependencies",
            () => import("@solana/web3.js"),
          );
          if (!web3) {
            throw new Error("Unable to load web3 claim dependencies.");
          }
          const { Connection, Transaction, VersionedTransaction } =
            web3 as typeof import("@solana/web3.js");
          const tx = measureFrontendSync(
            "decode delegated claim transaction",
            () => {
              const bytes = Uint8Array.from(atob(data.transaction), (char) =>
                char.charCodeAt(0),
              );
              if (data.version === 0) {
                return VersionedTransaction.deserialize(bytes);
              }
              return Transaction.from(bytes);
            },
          );
          if (!tx) {
            throw new Error("Unable to decode delegated claim transaction.");
          }
          const signed = await m("sign delegated claim transaction", () =>
            phantom.signTransaction(tx),
          );
          if (!signed) {
            throw new Error("Unable to sign delegated claim transaction.");
          }
          const conn = new Connection(runtimeConfig.rpcUrl, "confirmed");
          signature =
            (await m("submit signed delegated claim transaction", () =>
              conn.sendRawTransaction((signed as any).serialize(), {
                skipPreflight: false,
              }),
            )) ?? undefined;
          if (!signature) {
            throw new Error("Delegated claim transaction submission failed.");
          }
          const confirmedSignature = signature;
          const confirmation = (await m(
            "confirm delegated claim transaction",
            () =>
              conn.confirmTransaction(
                {
                  signature: confirmedSignature,
                  blockhash: data.blockhash,
                  lastValidBlockHeight: data.lastValidBlockHeight,
                },
                "confirmed",
              ),
          )) as Awaited<ReturnType<typeof conn.confirmTransaction>> | null;
          if (!confirmation) {
            throw new Error("Delegated claim transaction confirmation failed.");
          }
          if (confirmation.value.err) {
            throw new Error(
              typeof confirmation.value.err === "string"
                ? confirmation.value.err
                : JSON.stringify(confirmation.value.err),
            );
          }

          await m("report delegated claim confirmation", () =>
            fetch("/api/claim/delegated/finalize", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                claimantAddress: claimantAddress,
                delegatorAddress: connectedAddress,
                claimantAmountSol: Number(data.claimantPayout ?? 0) / 1e9,
                projectFeeSol: Number(data.projectFee ?? 0) / 1e9,
                signature: signature,
              }),
            }),
          );

          await m("refresh after delegated claim", () =>
            fetchAll("delegated-claim-success"),
          );
          showToast({
            kind: "success",
            message: `Claimed ${formatNumber(Number(data.claimantPayout ?? 0) / 1e9, "sol")} for ${shortAddress(claimantAddress)}. Project contribution: ${formatNumber(Number(data.projectFee ?? 0) / 1e9, "sol")}.`,
            txSignature: signature,
          });
          return { success: true, signature, claimant: claimantAddress };
        } catch (claimError: any) {
          walletError =
            claimError?.message || "Delegated claim request failed.";
          showToast({
            kind: "error",
            message: walletError ?? "Delegated claim request failed.",
            txSignature: signature,
          });
        }

        update("delegated-claim-error");
        return { success: false, reason: "delegated-claim-error" };
      });
    }

    async function setDelegatedClaimsEnabled(enabled: boolean) {
      return await measureFrontend(
        "set delegated claims enabled",
        async (m: MeasureFn) => {
          walletError = null;
          let signature: string | undefined;

          try {
            if (!connectedAddress) {
              walletError = "Connect wallet first.";
              update("delegation-preference-no-wallet");
              return { success: false, reason: "no-wallet" };
            }

            const phantom = (window as any).solana;
            if (
              !phantom?.isPhantom ||
              typeof phantom.signTransaction !== "function"
            ) {
              walletError = "Phantom wallet was not found in this browser.";
              update("delegation-preference-missing-provider");
              return { success: false, reason: "missing-provider" };
            }

            delegationPreferencePending = true;
            update("delegation-preference-pending");

            const response = await m(
              "request delegation preference transaction",
              () =>
                fetch("/api/claim/delegation", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ address: connectedAddress, enabled }),
                }),
            );
            if (!response) {
              throw new Error(
                "Unable to prepare delegated claim preference transaction.",
              );
            }

            const data = await m(
              "parse delegation preference payload",
              () => response.json() as Promise<DelegationPreferenceResponse>,
            );
            if (!data) {
              throw new Error(
                "Unable to parse delegated claim preference transaction.",
              );
            }
            if (
              !response.ok ||
              !data.transaction ||
              !data.blockhash ||
              typeof data.lastValidBlockHeight !== "number"
            ) {
              walletError =
                data.error ?? "Unable to update delegated claim preference.";
              update("delegation-preference-request-error");
              return {
                success: false,
                reason: "delegation-preference-request-error",
              };
            }

            const web3 = await m(
              "load web3 delegation preference dependencies",
              () => import("@solana/web3.js"),
            );
            if (!web3) {
              throw new Error(
                "Unable to load web3 delegation preference dependencies.",
              );
            }
            const { Connection, Transaction } =
              web3 as typeof import("@solana/web3.js");
            const transaction = measureFrontendSync(
              "decode delegation preference transaction",
              () =>
                Transaction.from(
                  Uint8Array.from(atob(data.transaction as string), (char) =>
                    char.charCodeAt(0),
                  ),
                ),
            );
            if (!transaction) {
              throw new Error(
                "Unable to decode delegated claim preference transaction.",
              );
            }
            const signed = await m(
              "sign delegation preference transaction",
              () => phantom.signTransaction(transaction),
            );
            if (!signed) {
              throw new Error(
                "Unable to sign delegated claim preference transaction.",
              );
            }

            const connection = new Connection(
              runtimeConfig.rpcUrl,
              "confirmed",
            );
            signature =
              (await m("submit signed delegation preference transaction", () =>
                connection.sendRawTransaction((signed as any).serialize(), {
                  skipPreflight: false,
                }),
              )) ?? undefined;
            if (!signature) {
              throw new Error(
                "Delegation preference transaction submission failed.",
              );
            }
            const confirmedSignature = signature;

            const confirmation = (await m(
              "confirm delegation preference transaction",
              () =>
                connection.confirmTransaction(
                  {
                    signature: confirmedSignature,
                    blockhash: data.blockhash as string,
                    lastValidBlockHeight: data.lastValidBlockHeight as number,
                  },
                  "confirmed",
                ),
            )) as Awaited<
              ReturnType<typeof connection.confirmTransaction>
            > | null;
            if (!confirmation) {
              throw new Error(
                "Delegation preference transaction confirmation failed.",
              );
            }
            if (confirmation.value.err) {
              throw new Error(
                typeof confirmation.value.err === "string"
                  ? confirmation.value.err
                  : JSON.stringify(confirmation.value.err),
              );
            }

            await m("report delegation preference confirmation", () =>
              fetch("/api/claim/delegation", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ address: connectedAddress, signature }),
              }),
            );

            await m("refresh after delegation preference update", () =>
              fetchAll("delegation-preference-success"),
            );
            showToast({
              kind: "success",
              message: enabled
                ? "Delegated claims enabled. Community claimers can earn 10%."
                : "Delegated claims disabled for your wallet.",
              txSignature: signature,
            });
            return { success: true, signature, enabled };
          } catch (delegationError: any) {
            walletError =
              delegationError?.message ||
              "Delegated claim preference update failed.";
            showToast({
              kind: "error",
              message:
                walletError ?? "Delegated claim preference update failed.",
              txSignature: signature,
            });
          } finally {
            delegationPreferencePending = false;
            update("delegation-preference-finish");
          }

          update("delegation-preference-error");
          return { success: false, reason: "delegation-preference-error" };
        },
      );
    }

    async function fetchAll(reason = "manual-refresh") {
      return await measureFrontend(
        `fetch all (${reason})`,
        async (m: MeasureFn, ms: MeasureSyncFn) => {
          try {
            loading = true;
            ms("mark loading and render", () =>
              update(`fetch-start:${reason}`),
            );

            const activitySuffix =
              showOnlyMineActivity && connectedAddress
                ? `?wallet=${encodeURIComponent(connectedAddress)}&mine=1`
                : "";
            const [leaderboardResponse, treasuryResponse, claimsResponse] =
              await Promise.all([
                m("fetch leaderboard api", () => fetch(`/api/leaderboard`)),
                m("fetch treasury api", () =>
                  fetch(`/api/treasury${activitySuffix}`),
                ),
                m("fetch claims api", () =>
                  fetch(`/api/claims${activitySuffix}`),
                ),
              ]);
            if (!leaderboardResponse || !treasuryResponse || !claimsResponse) {
              throw new Error("Activity API request failed.");
            }

            const [leaderboardData, treasuryData, claimsData] =
              await Promise.all([
                m(
                  "parse leaderboard payload",
                  () =>
                    leaderboardResponse.json() as Promise<LeaderboardResponse>,
                ),
                m(
                  "parse treasury payload",
                  () => treasuryResponse.json() as Promise<TreasuryResponse>,
                ),
                m(
                  "parse claims payload",
                  () => claimsResponse.json() as Promise<ClaimsResponse>,
                ),
              ]);
            if (!leaderboardData || !treasuryData || !claimsData) {
              throw new Error("Activity API payload parsing failed.");
            }

            if (leaderboardData.success) {
              entries =
                ms("normalize leaderboard entries", () =>
                  leaderboardData.entries
                    .filter((entry) => entry.tokenBalance > 0)
                    .sort((a, b) => {
                      const compare = (left: number, right: number) =>
                        sortDirection === "desc" ? right - left : left - right;
                      if (sortKey === "earned") {
                        const byEarned = compare(
                          a.totalSolRewardsEarned,
                          b.totalSolRewardsEarned,
                        );
                        if (byEarned !== 0) return byEarned;
                      }
                      if (sortKey === "gravity") {
                        const byGravity = compare(
                          a.accumulatedGravity,
                          b.accumulatedGravity,
                        );
                        if (byGravity !== 0) return byGravity;
                      }
                      if (sortKey === "balance") {
                        const byBalance = compare(
                          a.tokenBalance,
                          b.tokenBalance,
                        );
                        if (byBalance !== 0) return byBalance;
                      }
                      if (sortKey === "ownership") {
                        const byOwnership = compare(
                          a.gravityShare,
                          b.gravityShare,
                        );
                        if (byOwnership !== 0) return byOwnership;
                      }
                      if (b.totalSolRewardsEarned !== a.totalSolRewardsEarned)
                        return (
                          b.totalSolRewardsEarned - a.totalSolRewardsEarned
                        );
                      if (b.gravityShare !== a.gravityShare)
                        return b.gravityShare - a.gravityShare;
                      if (b.accumulatedGravity !== a.accumulatedGravity)
                        return b.accumulatedGravity - a.accumulatedGravity;
                      return b.tokenBalance - a.tokenBalance;
                    })
                    .map((entry, index) => ({ ...entry, rank: index + 1 })),
                ) ?? [];
              total = entries.length;
              totalSupply = leaderboardData.totalSupply;
              tokenPriceUsd = leaderboardData.tokenPriceUsd;
              epochIndex = leaderboardData.epochIndex;
              totalFeesAccumulatedSol = leaderboardData.totalFeesAccumulatedSol;
              totalClaimedSol = leaderboardData.totalClaimedSol;
              treasuryBalanceSol = leaderboardData.treasuryBalanceSol;
              totalAccumulatedGravity = leaderboardData.totalAccumulatedGravity;
              lastGravityDelta = leaderboardData.lastGravityDelta;
              lastRefreshAt = Date.now();
              error = null;
            } else {
              error = "Failed to load indexed leaderboard.";
            }

            if (treasuryData.success) {
              treasuryEvents = treasuryData.events;
              treasurySummary = treasuryData.summary ?? null;
            } else if (!error) {
              error = "Failed to load treasury additions.";
            }
            if (claimsData.success) {
              claimEvents = claimsData.events;
              claimsSummary = claimsData.summary ?? null;
            } else if (!error) {
              error = "Failed to load claim history.";
            }

            await m("refresh wallet totals", () => loadWalletTotals());
          } catch {
            error = "Error fetching indexed activity data.";
          } finally {
            loading = false;
            ms("final render after fetch", () =>
              update(`fetch-finish:${reason}`),
            );
          }

          return {
            reason,
            entries: entries.length,
            treasuryEvents: treasuryEvents.length,
            connected: Boolean(connectedAddress),
          };
        },
      );
    }

    void fetchAll("initial-load");
    const refreshInterval = setInterval(() => {
      void fetchAll("interval-refresh");
    }, 30000);
    const relativeTimeInterval = setInterval(() => {
      measureFrontendSync("relative-time tick", () => {
        updateRelativeTimeOnly();
        return { activeTab };
      });
    }, 5000);

    return () => {
      measureFrontendSync("unmount page client", (ms) => {
        clearInterval(refreshInterval);
        clearInterval(relativeTimeInterval);
        if (toastTimeout) clearTimeout(toastTimeout);
        ms("clear rendered roots", () => {
          render(null, leaderboardRoot);
          render(null, positionRoot);
          render(null, infoRoot);
          render(null, toastRoot);
          return { cleared: 4 };
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
      details: any;
      div: any;
      h2: any;
      main: any;
      p: any;
      section: any;
      span: any;
      summary: any;
      table: any;
      tbody: any;
      td: any;
      th: any;
      thead: any;
      tr: any;
    }
  }
}
