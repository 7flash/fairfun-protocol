import { Connection, PublicKey } from '@solana/web3.js';
import { config } from './config';

export const TOKEN_MINT = config.token.mint;

export const connection = new Connection(config.chain.rpcUrl, 'confirmed');

export interface TokenBalance {
    address: string;
    balance: number;
    decimals: number;
}

export interface TokenSupply {
    amount: number;
    decimals: number;
    rawAmount: string;
}

// Token program ID for SPL tokens
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
// Token-2022 program ID
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

export async function getTokenHolders(): Promise<TokenBalance[]> {
    try {
        const holders: TokenBalance[] = [];
        const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

        for (const programId of programs) {
            const tokenAccounts = await connection.getParsedProgramAccounts(programId, {
                filters: [
                    { dataSize: 165 },
                    { memcmp: { offset: 0, bytes: TOKEN_MINT } }
                ]
            });

            for (const account of tokenAccounts) {
                try {
                    const data = account.account.data;
                    if ('parsed' in data && data.parsed.type === 'account') {
                        const info = data.parsed.info;
                        const owner = String(info.owner);
                        if (!PublicKey.isOnCurve(owner)) continue;
                        holders.push({
                            address: owner,
                            balance: Number(info.tokenAmount.amount),
                            decimals: info.tokenAmount.decimals
                        });
                    }
                } catch (e) {
                    continue;
                }
            }
        }

        return holders;
    } catch (error) {
        console.error('Error fetching token holders:', error);
        return [];
    }
}

// Alternative approach using getTokenLargestAccounts
export async function getLargestHolders(limit = 100): Promise<TokenBalance[]> {
    try {
        const mintPublicKey = new PublicKey(TOKEN_MINT);

        const largestAccounts = await connection.getTokenLargestAccounts(mintPublicKey);

        const holders: TokenBalance[] = [];

        for (const account of largestAccounts.value) {
            try {
                const accountInfo = await connection.getParsedAccountInfo(account.address);
                if (accountInfo.value && 'parsed' in accountInfo.value.data) {
                    const parsed = accountInfo.value.data.parsed;
                    if (parsed.type === 'account') {
                        const info = parsed.info;
                        const owner = String(info.owner);
                        if (!PublicKey.isOnCurve(owner)) continue;
                        holders.push({
                            address: owner,
                            balance: Number(info.tokenAmount.amount),
                            decimals: info.tokenAmount.decimals
                        });
                    }
                }
            } catch (e) {
                continue;
            }
        }

        return holders.slice(0, limit);
    } catch (error) {
        console.error('Error fetching largest holders:', error);
        return [];
    }
}

export async function getTokenSupply(): Promise<TokenSupply> {
    const mintPublicKey = new PublicKey(TOKEN_MINT);
    const supply = await connection.getTokenSupply(mintPublicKey);

    return {
        amount: supply.value.uiAmount ?? Number(supply.value.amount) / Math.pow(10, supply.value.decimals),
        decimals: supply.value.decimals,
        rawAmount: supply.value.amount
    };
}

// Format address for display
export function formatAddress(address: string, chars = 4): string {
    if (!address) return '';
    return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

// Convert raw balance to human-readable
export function formatBalance(balance: number, decimals: number): string {
    return (Number(balance) / Math.pow(10, decimals)).toFixed(4);
}

export function formatTokenAmount(balance: number): string {
    return balance.toLocaleString(undefined, {
        maximumFractionDigits: 4
    });
}

export function toNumber(balance: number, decimals: number): number {
    return Number(balance) / Math.pow(10, decimals);
}
