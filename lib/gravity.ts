import { TOKEN_MINT } from './solana';
import { config } from './config';

let tokenPriceUSD = 0;
let lastPriceUpdate = 0;
const PRICE_CACHE_TTL = 60000;

async function fetchDexScreenerPrice(): Promise<number> {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`, {
        headers: { accept: 'application/json' }
    });

    if (!response.ok) return 0;

    const data = await response.json() as {
        pairs?: Array<{ chainId?: string; priceUsd?: string; liquidity?: { usd?: number } }>;
    };

    const solanaPairs = (data.pairs ?? [])
        .filter((pair) => pair.chainId === 'solana' && pair.priceUsd)
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

    const price = Number(solanaPairs[0]?.priceUsd ?? 0);
    return Number.isFinite(price) ? price : 0;
}

export async function getCurrentTokenPrice(): Promise<number> {
    if (config.indexer.tokenPriceUsd > 0) return config.indexer.tokenPriceUsd;

    const now = Date.now();
    if (now - lastPriceUpdate < PRICE_CACHE_TTL && tokenPriceUSD > 0) {
        return tokenPriceUSD;
    }

    try {
        const price = await fetchDexScreenerPrice();
        if (price > 0) {
            tokenPriceUSD = price;
            lastPriceUpdate = now;
        }
    } catch (error) {
        console.error('[Price] Unable to fetch token price:', error);
    }

    return tokenPriceUSD;
}

export function formatGravity(gravity: number): string {
    if (gravity >= 1000000000) return `${(gravity / 1000000000).toFixed(2)}B`;
    if (gravity >= 1000000) return `${(gravity / 1000000).toFixed(2)}M`;
    if (gravity >= 1000) return `${(gravity / 1000).toFixed(2)}K`;
    return gravity.toFixed(2);
}

export function formatUSD(value: number): string {
    if (value >= 1000000) return `$${(value / 1000000).toFixed(2)}M`;
    if (value >= 1000) return `$${(value / 1000).toFixed(2)}K`;
    if (value > 0 && value < 0.01) return `$${value.toFixed(6)}`;
    return `$${value.toFixed(2)}`;
}

export function formatSOL(value: number): string {
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL`;
}
