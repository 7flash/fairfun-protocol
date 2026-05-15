import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { Ed25519Program, Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, TransactionInstruction } from '@solana/web3.js';
import { config } from './config';
import { connection } from './solana';

const LAMPORTS_PER_SOL = 1_000_000_000;
const USER_CLAIM_ACCOUNT_SIZE = 8 + 32 + 32 + 8 + 1;
const USER_DELEGATION_SETTINGS_ACCOUNT_SIZE = 8 + 32 + 32 + 1 + 1;
const REWARD_POOL_ACCOUNT_SIZE = 8 + 32 + 8 + 8 + 1 + 1 + 1;
export const DELEGATED_CLAIM_FEE_BPS = 1_000;
export const BASIS_POINTS_DENOMINATOR = 10_000;

export interface RewardPoolState {
    tokenMint: PublicKey;
    totalDeposited: bigint;
    totalClaimed: bigint;
    active: boolean;
    bump: number;
    treasuryBump: number;
}

export interface UserClaimState {
    user: PublicKey;
    pool: PublicKey;
    claimedAmount: bigint;
    bump: number;
}

export interface UserDelegationSettingsState {
    user: PublicKey;
    pool: PublicKey;
    delegatedClaimsEnabled: boolean;
    bump: number;
}

export function getProgramId() {
    return new PublicKey(config.rewards.programId);
}

export function deriveConfigPda() {
    return PublicKey.findProgramAddressSync([Buffer.from('rewards_config')], getProgramId())[0];
}

export function derivePoolPda(tokenMint = new PublicKey(config.token.mint)) {
    return PublicKey.findProgramAddressSync([Buffer.from('rewards_pool'), tokenMint.toBuffer()], getProgramId())[0];
}

export function deriveTreasuryPda(tokenMint = new PublicKey(config.token.mint)) {
    return PublicKey.findProgramAddressSync([Buffer.from('rewards_treasury'), tokenMint.toBuffer()], getProgramId())[0];
}

export function deriveUserClaimPda(user: PublicKey, pool = derivePoolPda()) {
    return PublicKey.findProgramAddressSync([Buffer.from('rewards_user_claim'), pool.toBuffer(), user.toBuffer()], getProgramId())[0];
}

export function deriveUserDelegationSettingsPda(user: PublicKey, pool = derivePoolPda()) {
    return PublicKey.findProgramAddressSync([Buffer.from('rewards_user_delegation_settings'), pool.toBuffer(), user.toBuffer()], getProgramId())[0];
}

function accountDiscriminator(name: string) {
    return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

function instructionDiscriminator(name: string) {
    return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function assertDiscriminator(buffer: Buffer, expected: Buffer, name: string) {
    const actual = buffer.subarray(0, 8);
    if (!actual.equals(expected)) {
        throw new Error(`Invalid ${name} discriminator`);
    }
}

export function buildClaimMessage(
    user: PublicKey,
    pool: PublicKey,
    cumulativeEarned: bigint,
    observedTotalDeposits: bigint,
    expiresAt: bigint,
) {
    const message = Buffer.alloc(88);
    user.toBuffer().copy(message, 0);
    pool.toBuffer().copy(message, 32);
    message.writeBigUInt64LE(cumulativeEarned, 64);
    message.writeBigUInt64LE(observedTotalDeposits, 72);
    message.writeBigInt64LE(expiresAt, 80);
    return message;
}

export function decodeRewardPool(buffer: Buffer): RewardPoolState {
    assertDiscriminator(buffer, accountDiscriminator('RewardPool'), 'RewardPool');
    if (buffer.length < REWARD_POOL_ACCOUNT_SIZE) {
        throw new Error('RewardPool account data is too short');
    }

    return {
        tokenMint: new PublicKey(buffer.subarray(8, 40)),
        totalDeposited: buffer.readBigUInt64LE(40),
        totalClaimed: buffer.readBigUInt64LE(48),
        active: buffer.readUInt8(56) === 1,
        bump: buffer.readUInt8(57),
        treasuryBump: buffer.readUInt8(58),
    };
}

export function decodeUserClaim(buffer: Buffer): UserClaimState {
    assertDiscriminator(buffer, accountDiscriminator('UserClaim'), 'UserClaim');
    if (buffer.length < USER_CLAIM_ACCOUNT_SIZE) {
        throw new Error('UserClaim account data is too short');
    }

    return {
        user: new PublicKey(buffer.subarray(8, 40)),
        pool: new PublicKey(buffer.subarray(40, 72)),
        claimedAmount: buffer.readBigUInt64LE(72),
        bump: buffer.readUInt8(80),
    };
}

export function decodeUserDelegationSettings(buffer: Buffer): UserDelegationSettingsState {
    assertDiscriminator(buffer, accountDiscriminator('UserDelegationSettings'), 'UserDelegationSettings');
    if (buffer.length < USER_DELEGATION_SETTINGS_ACCOUNT_SIZE) {
        throw new Error('UserDelegationSettings account data is too short');
    }

    return {
        user: new PublicKey(buffer.subarray(8, 40)),
        pool: new PublicKey(buffer.subarray(40, 72)),
        delegatedClaimsEnabled: buffer.readUInt8(72) === 1,
        bump: buffer.readUInt8(73),
    };
}

export async function fetchRewardPoolState() {
    const pool = derivePoolPda();
    const account = await connection.getAccountInfo(pool, 'confirmed');
    if (!account) {
        throw new Error(`Reward pool ${pool.toBase58()} was not found`);
    }
    return decodeRewardPool(Buffer.from(account.data));
}

export async function fetchUserClaimState(user: PublicKey) {
    const userClaim = deriveUserClaimPda(user);
    const account = await connection.getAccountInfo(userClaim, 'confirmed');
    if (!account) {
        return null;
    }
    return decodeUserClaim(Buffer.from(account.data));
}

export async function fetchUserDelegationSettingsState(user: PublicKey) {
    const settings = deriveUserDelegationSettingsPda(user);
    const account = await connection.getAccountInfo(settings, 'confirmed');
    if (!account) {
        return null;
    }
    return decodeUserDelegationSettings(Buffer.from(account.data));
}

function resolveKeypairPath() {
    const keypairPath = config.rewards.backendKeypairPath;
    if (!keypairPath) {
        return null;
    }
    return path.resolve(process.cwd(), keypairPath);
}

export function claimSigningEnabled() {
    const keypairPath = resolveKeypairPath();
    return Boolean(keypairPath && existsSync(keypairPath));
}

export function loadBackendKeypair() {
    const keypairPath = resolveKeypairPath();
    if (!keypairPath || !existsSync(keypairPath)) {
        throw new Error('Backend keypair is not configured');
    }

    const raw = readFileSync(keypairPath, 'utf8').trim();
    const secret = JSON.parse(raw) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export function solToLamportsBigInt(amount: number) {
    return BigInt(Math.max(0, Math.round(amount * LAMPORTS_PER_SOL)));
}

export function lamportsToSolNumber(amount: bigint) {
    return Number(amount) / LAMPORTS_PER_SOL;
}

export function buildClaimInstruction(
    user: PublicKey,
    cumulativeEarned: bigint,
    observedTotalDeposits: bigint,
    expiresAt: bigint,
) {
    const pool = derivePoolPda();
    const treasury = deriveTreasuryPda();
    const userClaim = deriveUserClaimPda(user, pool);
    const data = Buffer.alloc(8 + 8 + 8 + 8);
    instructionDiscriminator('claim').copy(data, 0);
    data.writeBigUInt64LE(cumulativeEarned, 8);
    data.writeBigUInt64LE(observedTotalDeposits, 16);
    data.writeBigInt64LE(expiresAt, 24);

    return new TransactionInstruction({
        programId: getProgramId(),
        keys: [
            { pubkey: user, isSigner: true, isWritable: true },
            { pubkey: userClaim, isSigner: false, isWritable: true },
            { pubkey: deriveConfigPda(), isSigner: false, isWritable: false },
            { pubkey: pool, isSigner: false, isWritable: true },
            { pubkey: treasury, isSigner: false, isWritable: true },
            { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
    });
}

export async function buildClaimTransaction(user: PublicKey, cumulativeEarned: bigint, observedTotalDeposits: bigint) {
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + config.rewards.claimExpiresInSeconds);
    const message = buildClaimMessage(user, derivePoolPda(), cumulativeEarned, observedTotalDeposits, expiresAt);
    const signer = loadBackendKeypair();
    const ed25519Instruction = Ed25519Program.createInstructionWithPrivateKey({
        privateKey: signer.secretKey,
        message,
    });
    const claimInstruction = buildClaimInstruction(user, cumulativeEarned, observedTotalDeposits, expiresAt);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

    const transaction = new Transaction({
        feePayer: user,
        blockhash,
        lastValidBlockHeight,
    }).add(ed25519Instruction, claimInstruction);

    return {
        transaction,
        blockhash,
        lastValidBlockHeight,
        expiresAt: Number(expiresAt),
        signerPubkey: signer.publicKey.toBase58(),
    };
}

export function buildDelegatedClaimInstruction(
    delegator: PublicKey,
    claimant: PublicKey,
    cumulativeEarned: bigint,
    observedTotalDeposits: bigint,
    expiresAt: bigint,
) {
    const pool = derivePoolPda();
    const treasury = deriveTreasuryPda();
    const userClaim = deriveUserClaimPda(claimant, pool);
    const data = Buffer.alloc(8 + 32 + 8 + 8 + 8);
    instructionDiscriminator('delegated_claim').copy(data, 0);
    claimant.toBuffer().copy(data, 8);
    data.writeBigUInt64LE(cumulativeEarned, 40);
    data.writeBigUInt64LE(observedTotalDeposits, 48);
    data.writeBigInt64LE(expiresAt, 56);

    return new TransactionInstruction({
        programId: getProgramId(),
        keys: [
            { pubkey: delegator, isSigner: true, isWritable: true },
            { pubkey: userClaim, isSigner: false, isWritable: true },
            { pubkey: deriveConfigPda(), isSigner: false, isWritable: false },
            { pubkey: pool, isSigner: false, isWritable: true },
            { pubkey: treasury, isSigner: false, isWritable: true },
            { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: claimant, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
    });
}

export async function buildDelegatedClaimTransaction(
    delegator: PublicKey,
    claimant: PublicKey,
    cumulativeEarned: bigint,
    observedTotalDeposits: bigint,
) {
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + config.rewards.claimExpiresInSeconds);
    const message = buildClaimMessage(claimant, derivePoolPda(), cumulativeEarned, observedTotalDeposits, expiresAt);
    const signer = loadBackendKeypair();
    const ed25519Instruction = Ed25519Program.createInstructionWithPrivateKey({
        privateKey: signer.secretKey,
        message,
    });
    const claimInstruction = buildDelegatedClaimInstruction(
        delegator,
        claimant,
        cumulativeEarned,
        observedTotalDeposits,
        expiresAt,
    );
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

    const transaction = new Transaction({
        feePayer: delegator,
        blockhash,
        lastValidBlockHeight,
    }).add(ed25519Instruction, claimInstruction);

    return {
        transaction,
        blockhash,
        lastValidBlockHeight,
        expiresAt: Number(expiresAt),
        signerPubkey: signer.publicKey.toBase58(),
        claimantPubkey: claimant.toBase58(),
        delegatorPubkey: delegator.toBase58(),
    };
}

export function buildSetDelegatedClaimsEnabledInstruction(
    user: PublicKey,
    enabled: boolean,
) {
    const pool = derivePoolPda();
    const settings = deriveUserDelegationSettingsPda(user, pool);
    const data = Buffer.alloc(8 + 1);
    instructionDiscriminator('set_delegated_claims_enabled').copy(data, 0);
    data.writeUInt8(enabled ? 1 : 0, 8);

    return new TransactionInstruction({
        programId: getProgramId(),
        keys: [
            { pubkey: user, isSigner: true, isWritable: true },
            { pubkey: pool, isSigner: false, isWritable: true },
            { pubkey: settings, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
    });
}

export async function buildSetDelegatedClaimsEnabledTransaction(
    user: PublicKey,
    enabled: boolean,
) {
    const instruction = buildSetDelegatedClaimsEnabledInstruction(user, enabled);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

    const transaction = new Transaction({
        feePayer: user,
        blockhash,
        lastValidBlockHeight,
    }).add(instruction);

    return {
        transaction,
        blockhash,
        lastValidBlockHeight,
        enabled,
    };
}
