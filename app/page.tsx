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
                    <h1 className="page-title">{config.app.heroTitle}</h1>
                    <p className="page-copy">{config.app.heroDescription}</p>
                    <p className="page-subcopy">
                        FairFun turns holding time into a live financial weight. Token state, treasury state, and global gravity are grouped below so the protocol reads from first principles before you drill into wallet or ledger views.
                    </p>
                </section>

                <section className="summary-shell">
                    <div className="summary-header">
                        <div>
                            <div className="summary-kicker">Live Protocol Snapshot</div>
                            <h2 className="summary-title">Three pillars: token, treasury, engine.</h2>
                        </div>
                        <p className="summary-copy">
                            The token block shows who holds and what the token is worth, the treasury block shows all-time deposits versus unclaimed balance, and the engine block shows the real-time gravity state driving payouts.
                        </p>
                    </div>
                    <div id="hero-metrics-root" />
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
