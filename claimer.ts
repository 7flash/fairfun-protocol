import { configure, measure, measureSync } from 'measure-fn';
import { config } from './lib/config';
import { runAutomaticRewardClaimPass } from './lib/auto-claims';

configure({
    timestamps: true,
    maxResultLength: 160,
});

let interval: ReturnType<typeof setInterval> | null = null;

async function runPass() {
    const result = await runAutomaticRewardClaimPass();
    measureSync('Claimer pass complete', () => result);
}

await measure.assert('Start FairFun claimer', async () => {
    await runPass();
    interval = setInterval(() => {
        void runPass().catch((error) => {
            console.error('[Claimer] Pass failed:', error);
        });
    }, config.claimer.intervalMs);
    measureSync('Claimer ready', () => ({
        intervalMs: config.claimer.intervalMs,
        minClaimSol: config.claimer.minClaimSol,
    }));
});

const shutdown = (signal: string) => {
    measureSync(`Stop claimer (${signal})`, () => {
        if (interval) clearInterval(interval);
        interval = null;
        return 'stopped';
    });
    process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
