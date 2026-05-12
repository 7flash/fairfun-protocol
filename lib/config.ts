import path from 'path';
import { measureSync } from 'measure-fn';

export interface RuntimeConfig {
    app: {
        port: number;
        siteTitle: string;
        projectName: string;
        heroBadge: string;
        heroTitle: string;
        heroDescription: string;
    };
    chain: {
        rpcUrl: string;
    };
    token: {
        mint: string;
        symbol: string;
    };
    rewards: {
        programId: string;
        treasuryAddress: string;
        backendKeypairPath: string;
        claimExpiresInSeconds: number;
        explorerTxBaseUrl: string;
    };
    indexer: {
        dbPath: string;
        intervalMs: number;
        launchTimestamp: number;
        tokenPriceUsd: number;
    };
}

let cachedConfig: RuntimeConfig | null = null;

function requireString(value: unknown, key: string) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`Missing required config value: ${key}`);
    }
    return value.trim();
}

function getOptionalString(value: unknown, fallback = '') {
    return typeof value === 'string' ? value.trim() : fallback;
}

function getNumber(value: unknown, fallback: number) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return fallback;
}

function env(name: string) {
    return process.env[name];
}

function parseConfig(): RuntimeConfig {
    return {
        app: {
            port: getNumber(env('APP_PORT'), 3000),
            siteTitle: requireString(env('APP_SITE_TITLE'), 'APP_SITE_TITLE'),
            projectName: requireString(env('APP_PROJECT_NAME'), 'APP_PROJECT_NAME'),
            heroBadge: requireString(env('APP_HERO_BADGE'), 'APP_HERO_BADGE'),
            heroTitle: requireString(env('APP_HERO_TITLE'), 'APP_HERO_TITLE'),
            heroDescription: requireString(env('APP_HERO_DESCRIPTION'), 'APP_HERO_DESCRIPTION'),
        },
        chain: {
            rpcUrl: requireString(env('CHAIN_RPC_URL'), 'CHAIN_RPC_URL'),
        },
        token: {
            mint: requireString(env('TOKEN_MINT'), 'TOKEN_MINT'),
            symbol: requireString(env('TOKEN_SYMBOL'), 'TOKEN_SYMBOL'),
        },
        rewards: {
            programId: requireString(env('REWARDS_PROGRAM_ID'), 'REWARDS_PROGRAM_ID'),
            treasuryAddress: requireString(env('REWARDS_TREASURY_ADDRESS'), 'REWARDS_TREASURY_ADDRESS'),
            backendKeypairPath: getOptionalString(env('REWARDS_BACKEND_KEYPAIR_PATH')),
            claimExpiresInSeconds: Math.max(30, getNumber(env('REWARDS_CLAIM_EXPIRES_IN_SECONDS'), 600)),
            explorerTxBaseUrl: getOptionalString(env('REWARDS_EXPLORER_TX_BASE_URL'), 'https://solscan.io/tx/'),
        },
        indexer: {
            dbPath: path.resolve(process.cwd(), requireString(env('INDEXER_DB_PATH'), 'INDEXER_DB_PATH')),
            intervalMs: Math.max(1000, getNumber(env('INDEXER_INTERVAL_MS'), 60000)),
            launchTimestamp: Math.max(0, getNumber(env('INDEXER_LAUNCH_TIMESTAMP'), 0)),
            tokenPriceUsd: Math.max(0, getNumber(env('INDEXER_TOKEN_PRICE_USD'), 0)),
        },
    };
}

export function loadConfig(): RuntimeConfig {
    if (cachedConfig) {
        return cachedConfig;
    }

    const loaded = measureSync('Load runtime config', () => parseConfig());
    if (!loaded) {
        throw new Error('Failed to load runtime config.');
    }
    cachedConfig = loaded;
    return cachedConfig;
}

export const config = loadConfig();
