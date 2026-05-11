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
                </section>

                <section className="summary-shell">
                    <div id="hero-info-root" />
                </section>

                <div className="hero-grid">
                    <div className="left-column">
                        <aside id="wallet-position-root" />
                    </div>

                    <section className="leaderboard-col">
                        <div id="leaderboard-root" />
                    </section>
                </div>
            </main>

            <div id="toast-root" />
        </div>
    );
}
