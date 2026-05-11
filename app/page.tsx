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
                </section>

                <section className="metrics-grid" id="hero-metrics-root" />

                <div className="hero-grid">
                    <div className="left-column">
                        <div id="address-containers-root" />
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
                            <span id="leaderboard-summary">Refreshing leaderboard...</span>
                        </div>

                        <div id="leaderboard-root" />
                    </section>
                </div>
            </main>

            <div id="toast-root" />
        </div>
    );
}
