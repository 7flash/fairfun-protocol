import { config } from '../lib/config';

export default function HomePage() {
    return (
        <div className="app-shell">
            <div
                id="app-config-root"
                data-token-mint={config.token.mint}
                data-token-symbol={config.token.symbol}
                data-project-name={config.app.projectName}
                data-treasury-address={config.rewards.treasuryAddress}
                data-rpc-url={config.chain.rpcUrl}
                data-explorer-tx-base-url={config.rewards.explorerTxBaseUrl}
                data-claim-enabled={config.rewards.backendKeypairPath ? 'true' : 'false'}
                hidden
            />

            <main className="page-main">
                <section className="page-intro">
                    <div className="intro-pill">{config.app.heroBadge}</div>
                    <h1 className="page-title">{config.token.symbol} Gravity Rewards Dashboard</h1>
                    <p className="page-copy">
                        FairFun tracks holder gravity in USD-minutes and distributes project revenue by accumulated gravity share.
                    </p>
                    <p className="page-subcopy">
                        This dashboard shows how revenue enters the treasury, how much has already been claimed, and how holder gravity is accumulating right now.
                    </p>
                </section>

                <section className="summary-shell">
                    <div id="hero-metrics-root" />
                    <div id="hero-info-root" />
                </section>

                <div className="hero-grid">
                    <div className="left-column">
                        <aside id="wallet-position-root" />
                    </div>

                    <section className="leaderboard-col">
                        <div className="board-header">
                            <h2 className="board-title">Gravity Leaderboard</h2>
                            <button className="refresh-button" id="refresh-button" type="button">
                                <span className="refresh-icon">↻</span>
                                <span>Refresh</span>
                            </button>
                        </div>

                        <div className="board-status">
                            <span className="live-dot">LIVE</span>
                            <span className="board-status-text" id="leaderboard-summary">Refreshing leaderboard...</span>
                        </div>

                        <div id="leaderboard-root" />
                    </section>
                </div>
            </main>

            <div id="toast-root" />
        </div>
    );
}
