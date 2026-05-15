import { configure, measure, measureSync } from 'measure-fn';
import { config } from './lib/config';
import { runCreatorFeeClaimPass } from './lib/creator-fees';

configure({
    timestamps: true,
    maxResultLength: 160,
});

let interval: ReturnType<typeof setInterval> | null = null;

async function runPass() {
    const result = await runCreatorFeeClaimPass();
    measureSync('Creator fee pass complete', () => result);
}

await measure.assert('Start FairFun creator fee worker', async () => {
    await runPass();
    interval = setInterval(() => {
        void runPass().catch((error) => {
            console.error('[CreatorFees] Pass failed:', error);
        });
    }, config.creatorFees.intervalMs);
    measureSync('Creator fee worker ready', () => ({
        enabled: config.creatorFees.enabled,
        mint: config.creatorFees.mint,
        intervalMs: config.creatorFees.intervalMs,
        minClaimLamports: config.creatorFees.minClaimLamports.toString(),
    }));
});

const shutdown = (signal: string) => {
    measureSync(`Stop creator fee worker (${signal})`, () => {
        if (interval) clearInterval(interval);
        interval = null;
        return 'stopped';
    });
    process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
