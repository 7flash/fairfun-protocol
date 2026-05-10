import { configure, measure, measureSync } from 'measure-fn';
import { config } from './lib/config';
import { startLeaderboardIndexer, stopLeaderboardIndexer } from './lib/indexer';

configure({
    timestamps: true,
    maxResultLength: 160,
});

await measure.assert('Start FairFun indexer', async () => {
    startLeaderboardIndexer();
    measureSync('Indexer ready', () => ({
        tokenMint: config.token.mint,
        symbol: config.token.symbol,
        treasuryAddress: config.rewards.treasuryAddress,
        intervalMs: config.indexer.intervalMs,
        dbPath: config.indexer.dbPath,
    }));
});

const shutdown = (signal: string) => {
    measureSync(`Stop indexer (${signal})`, () => {
        stopLeaderboardIndexer();
        return 'stopped';
    });
    process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
