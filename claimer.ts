import { configure, measure, measureSync } from 'measure-fn';
import { config } from './lib/config';
import { getRecommendedClaimerIntervalMs, runAutomaticRewardClaimPass } from './lib/auto-claims';

configure({
    timestamps: true,
    maxResultLength: 160,
});

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

async function runPass() {
    const result = await runAutomaticRewardClaimPass();
    measureSync('Claimer pass complete', () => result);
    return result;
}

function scheduleNext() {
    if (stopped) return;
    const next = getRecommendedClaimerIntervalMs();
    measureSync('Schedule next claimer pass', () => next);
    timer = setTimeout(() => {
        void runLoop().catch((error) => {
            console.error('[Claimer] Pass failed:', error);
        });
    }, next.intervalMs);
}

async function runLoop() {
    await runPass();
    scheduleNext();
}

await measure.assert('Start FairFun claimer', async () => {
    await runLoop();
    measureSync('Claimer ready', () => ({
        baseIntervalMs: config.claimer.intervalMs,
        minClaimSol: config.claimer.minClaimSol,
    }));
});

const shutdown = (signal: string) => {
    measureSync(`Stop claimer (${signal})`, () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = null;
        return 'stopped';
    });
    process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
