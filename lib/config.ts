import { existsSync, readFileSync } from 'fs';
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

function getConfigPath() {
    return path.resolve(process.cwd(), '.config.toml');
}

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

function parseConfig(): RuntimeConfig {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) {
        throw new Error(`Missing ${configPath}. Copy .config.example.toml to .config.toml and fill in your values.`);
    }

    const source = readFileSync(configPath, 'utf8');
    const parsed = Bun.TOML.parse(source) as Record<string, Record<string, unknown> | undefined>;
    const app = parsed.app ?? {};
    const chain = parsed.chain ?? {};
    const token = parsed.token ?? {};
    const rewards = parsed.rewards ?? {};
    const indexer = parsed.indexer ?? {};

    return {
        app: {
            port: getNumber(app.port, 3000),
            siteTitle: requireString(app.site_title, 'app.site_title'),
            projectName: requireString(app.project_name, 'app.project_name'),
            heroBadge: requireString(app.hero_badge, 'app.hero_badge'),
            heroTitle: requireString(app.hero_title, 'app.hero_title'),
            heroDescription: requireString(app.hero_description, 'app.hero_description'),
        },
        chain: {
            rpcUrl: requireString(chain.rpc_url, 'chain.rpc_url'),
        },
        token: {
            mint: requireString(token.mint, 'token.mint'),
            symbol: requireString(token.symbol, 'token.symbol'),
        },
        rewards: {
            programId: requireString(rewards.program_id, 'rewards.program_id'),
            treasuryAddress: requireString(rewards.treasury_address, 'rewards.treasury_address'),
            backendKeypairPath: getOptionalString(rewards.backend_keypair_path),
            claimExpiresInSeconds: Math.max(30, getNumber(rewards.claim_expires_in_seconds, 600)),
            explorerTxBaseUrl: getOptionalString(rewards.explorer_tx_base_url, 'https://solscan.io/tx/'),
        },
        indexer: {
            dbPath: path.resolve(process.cwd(), requireString(indexer.db_path, 'indexer.db_path')),
            intervalMs: Math.max(1000, getNumber(indexer.interval_ms, 60000)),
            launchTimestamp: Math.max(0, getNumber(indexer.launch_timestamp, 0)),
            tokenPriceUsd: Math.max(0, getNumber(indexer.token_price_usd, 0)),
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
