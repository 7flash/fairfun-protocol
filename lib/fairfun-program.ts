import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import BN from 'bn.js';
import bs58 from 'bs58';
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { GLOBAL_CONFIG_PDA as PUMP_AMM_GLOBAL_CONFIG_PDA, GLOBAL_VOLUME_ACCUMULATOR_PDA as PUMP_AMM_GLOBAL_VOLUME_ACCUMULATOR_PDA, OnlinePumpAmmSdk, PUMP_AMM_EVENT_AUTHORITY_PDA, PUMP_AMM_FEE_CONFIG_PDA, PUMP_AMM_PROGRAM_ID, PUMP_AMM_SDK, PUMP_FEE_PROGRAM_ID, buyQuoteInput as quotePumpAmmBuyQuoteInput, canonicalPumpPoolPda, coinCreatorVaultAuthorityPda, poolV2Pda, userVolumeAccumulatorPda } from '@pump-fun/pump-swap-sdk';
import { Ed25519Program, Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, TransactionInstruction } from '@solana/web3.js';
import { config } from './config';
import { connection } from './solana';

const LAMPORTS_PER_SOL = 1_000_000_000;
const USER_CLAIM_ACCOUNT_SIZE = 8 + 32 + 32 + 8 + 1;
const USER_DELEGATION_SETTINGS_ACCOUNT_SIZE = 8 + 32 + 32 + 1 + 1;
const REWARD_POOL_ACCOUNT_SIZE = 8 + 32 + 8 + 8 + 1 + 1 + 1;
const TOKENIZED_CLAIM_MIN_OUTPUT_BPS = 9_500n;
const TOKENIZED_CLAIM_BPS_DENOMINATOR = 10_000n;
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

export interface PreparedClaimAmounts {
    poolActive: boolean;
    claimedAmount: bigint;
    cumulativeEarned: bigint;
    estimatedClaimableLamports: bigint;
    observedTotalDeposits: bigint;
    onchainTotalReceived: bigint;
    remainingPoolCapacity: bigint;
}

export interface BatchClaimEntry {
    claimant: PublicKey;
    cumulativeEarned: bigint;
    observedTotalDeposits: bigint;
    expiresAt: bigint;
}

export interface TokenizedBatchClaimEntry extends BatchClaimEntry {
    estimatedClaimableLamports: bigint;
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

export function buildBatchClaimMessage(
    pool: PublicKey,
    entries: Array<BatchClaimEntry>,
) {
    const message = Buffer.alloc(32 + 4 + entries.length * 56);
    pool.toBuffer().copy(message, 0);
    message.writeUInt32LE(entries.length, 32);

    let offset = 36;
    for (const entry of entries) {
        entry.claimant.toBuffer().copy(message, offset);
        offset += 32;
        message.writeBigUInt64LE(entry.cumulativeEarned, offset);
        offset += 8;
        message.writeBigUInt64LE(entry.observedTotalDeposits, offset);
        offset += 8;
        message.writeBigInt64LE(entry.expiresAt, offset);
        offset += 8;
    }

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

export async function fetchOnchainTotalReceived(poolState?: RewardPoolState) {
    const pool = poolState ?? await fetchRewardPoolState();
    const treasuryBalance = BigInt(await connection.getBalance(deriveTreasuryPda(pool.tokenMint), 'confirmed'));
    return treasuryBalance + pool.totalClaimed;
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

export function parseConfiguredSecretKey(configuredValue: string) {
    const trimmedValue = configuredValue.trim();
    if (trimmedValue.length === 0) {
        throw new Error('Backend keypair is not configured');
    }

    if (trimmedValue.startsWith('[')) {
        const secret = JSON.parse(trimmedValue) as Array<number>;
        return Uint8Array.from(secret);
    }

    if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmedValue)) {
        return bs58.decode(trimmedValue);
    }

    const keypairPath = path.resolve(process.cwd(), trimmedValue);
    if (!existsSync(keypairPath)) {
        throw new Error('Backend keypair is not configured');
    }

    const raw = readFileSync(keypairPath, 'utf8').trim();
    const secret = JSON.parse(raw) as Array<number>;
    return Uint8Array.from(secret);
}

export function claimSigningEnabled() {
    const configuredValue = config.rewards.backendKeypairPath;
    if (!configuredValue) {
        return false;
    }

    try {
        const secretKey = parseConfiguredSecretKey(configuredValue);
        return secretKey.length === 64;
    } catch {
        return false;
    }
}

export function loadBackendKeypair() {
    return Keypair.fromSecretKey(parseConfiguredSecretKey(config.rewards.backendKeypairPath));
}

export function loadKeypairFromConfiguredValue(configuredValue: string) {
    return Keypair.fromSecretKey(parseConfiguredSecretKey(configuredValue));
}

export function solToLamportsBigInt(amount: number) {
    return BigInt(Math.max(0, Math.round(amount * LAMPORTS_PER_SOL)));
}

export function lamportsToSolNumber(amount: bigint) {
    return Number(amount) / LAMPORTS_PER_SOL;
}

export async function prepareClaimAmounts(
    user: PublicKey,
    totalEarnedLamports: bigint,
    observedTotalDepositsLamports: bigint,
): Promise<PreparedClaimAmounts> {
    const pool = await fetchRewardPoolState();
    const claimState = await fetchUserClaimState(user);
    const claimedAmount = claimState?.claimedAmount ?? 0n;
    const onchainTotalReceived = await fetchOnchainTotalReceived(pool);
    const observedTotalDeposits = observedTotalDepositsLamports < onchainTotalReceived
        ? observedTotalDepositsLamports
        : onchainTotalReceived;
    const cappedEarned = totalEarnedLamports < observedTotalDeposits
        ? totalEarnedLamports
        : observedTotalDeposits;
    const remainingPoolCapacity = onchainTotalReceived > pool.totalClaimed
        ? onchainTotalReceived - pool.totalClaimed
        : 0n;
    const maxCumulativeEarned = claimedAmount + remainingPoolCapacity;
    const cumulativeEarned = cappedEarned < maxCumulativeEarned
        ? cappedEarned
        : maxCumulativeEarned;
    const estimatedClaimableLamports = cumulativeEarned > claimedAmount
        ? cumulativeEarned - claimedAmount
        : 0n;

    return {
        poolActive: pool.active,
        claimedAmount,
        cumulativeEarned,
        estimatedClaimableLamports,
        observedTotalDeposits,
        onchainTotalReceived,
        remainingPoolCapacity,
    };
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

export function buildDelegatedClaimManyInstruction(
    delegator: PublicKey,
    entries: Array<BatchClaimEntry>,
) {
    const pool = derivePoolPda();
    const treasury = deriveTreasuryPda();
    const data = Buffer.alloc(8 + 4 + entries.length * 56);
    instructionDiscriminator('delegated_claim_many').copy(data, 0);
    data.writeUInt32LE(entries.length, 8);

    let offset = 12;
    for (const entry of entries) {
        entry.claimant.toBuffer().copy(data, offset);
        offset += 32;
        data.writeBigUInt64LE(entry.cumulativeEarned, offset);
        offset += 8;
        data.writeBigUInt64LE(entry.observedTotalDeposits, offset);
        offset += 8;
        data.writeBigInt64LE(entry.expiresAt, offset);
        offset += 8;
    }

    const keys = [
        { pubkey: delegator, isSigner: true, isWritable: true },
        { pubkey: deriveConfigPda(), isSigner: false, isWritable: false },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: treasury, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    for (const entry of entries) {
        keys.push(
            { pubkey: deriveUserClaimPda(entry.claimant, pool), isSigner: false, isWritable: true },
            { pubkey: deriveUserDelegationSettingsPda(entry.claimant, pool), isSigner: false, isWritable: true },
            { pubkey: entry.claimant, isSigner: false, isWritable: true },
        );
    }

    return new TransactionInstruction({
        programId: getProgramId(),
        keys,
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

export async function buildDelegatedClaimManyTransaction(
    delegator: PublicKey,
    entries: Array<BatchClaimEntry>,
) {
    const message = buildBatchClaimMessage(derivePoolPda(), entries);
    const signer = loadBackendKeypair();
    const ed25519Instruction = Ed25519Program.createInstructionWithPrivateKey({
        privateKey: signer.secretKey,
        message,
    });
    const claimInstruction = buildDelegatedClaimManyInstruction(
        delegator,
        entries,
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
        signerPubkey: signer.publicKey.toBase58(),
        delegatorPubkey: delegator.toBase58(),
        claimants: entries.map((entry) => entry.claimant.toBase58()),
    };
}

export async function buildDelegatedClaimToTokensTransaction(
    delegator: PublicKey,
    claimant: PublicKey,
    cumulativeEarned: bigint,
    observedTotalDeposits: bigint,
    estimatedClaimableLamports: bigint,
) {
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + config.rewards.claimExpiresInSeconds);
    const message = buildClaimMessage(claimant, derivePoolPda(), cumulativeEarned, observedTotalDeposits, expiresAt);
    const signer = loadBackendKeypair();
    const ed25519Instruction = Ed25519Program.createInstructionWithPrivateKey({
        privateKey: signer.secretKey,
        message,
    });

    const treasury = deriveTreasuryPda();
    const pumpAmmSdk = new OnlinePumpAmmSdk(connection);
    const pumpPool = canonicalPumpPoolPda(new PublicKey(config.token.mint));
    const swapState = await pumpAmmSdk.swapSolanaState(pumpPool, treasury);
    const swapAccounts = (PUMP_AMM_SDK as any).swapAccounts(swapState) as {
        protocolFeeRecipient: PublicKey;
        protocolFeeRecipientTokenAccount: PublicKey;
        buybackFeeRecipient: PublicKey;
        buybackFeeRecipientTokenAccount: PublicKey;
        coinCreatorVaultAta: PublicKey;
        coinCreatorVaultAuthority: PublicKey;
        globalVolumeAccumulator: PublicKey;
        userVolumeAccumulator: PublicKey;
        feeConfig: PublicKey;
        feeProgram: PublicKey;
        baseMint: PublicKey;
        quoteMint: PublicKey;
        pool: PublicKey;
        poolBaseTokenAccount: PublicKey;
        poolQuoteTokenAccount: PublicKey;
        baseTokenProgram: PublicKey;
        quoteTokenProgram: PublicKey;
    };

    const quote = quotePumpAmmBuyQuoteInput({
        quote: new BN(estimatedClaimableLamports.toString()),
        slippage: 15,
        baseReserve: swapState.poolBaseAmount,
        quoteReserve: swapState.poolQuoteAmount,
        globalConfig: swapState.globalConfig,
        baseMintAccount: swapState.baseMintAccount,
        baseMint: swapState.baseMint,
        coinCreator: swapState.pool.coinCreator,
        creator: swapState.pool.creator,
        feeConfig: swapState.feeConfig,
    });
    const quotedBaseAmountOut = BigInt(quote.base.toString());
    const minimumTokenAmountOut = quotedBaseAmountOut * TOKENIZED_CLAIM_MIN_OUTPUT_BPS / TOKENIZED_CLAIM_BPS_DENOMINATOR;

    const treasuryTokenAccount = getAssociatedTokenAddressSync(
        new PublicKey(config.token.mint),
        treasury,
        true,
        TOKEN_2022_PROGRAM_ID,
    );
    const treasuryWsolAccount = getAssociatedTokenAddressSync(
        NATIVE_MINT,
        treasury,
        true,
        TOKEN_PROGRAM_ID,
    );
    const claimantTokenAccount = getAssociatedTokenAddressSync(
        new PublicKey(config.token.mint),
        claimant,
        false,
        TOKEN_2022_PROGRAM_ID,
    );
    const delegatorTokenAccount = getAssociatedTokenAddressSync(
        new PublicKey(config.token.mint),
        delegator,
        false,
        TOKEN_2022_PROGRAM_ID,
    );

    const data = Buffer.alloc(8 + 32 + 8 + 8 + 8 + 8);
    instructionDiscriminator('delegated_claim_to_tokens').copy(data, 0);
    claimant.toBuffer().copy(data, 8);
    data.writeBigUInt64LE(cumulativeEarned, 40);
    data.writeBigUInt64LE(observedTotalDeposits, 48);
    data.writeBigInt64LE(expiresAt, 56);
    data.writeBigUInt64LE(minimumTokenAmountOut, 64);

    const instruction = new TransactionInstruction({
        programId: getProgramId(),
        keys: [
            { pubkey: delegator, isSigner: true, isWritable: true },
            { pubkey: deriveUserClaimPda(claimant), isSigner: false, isWritable: true },
            { pubkey: deriveUserDelegationSettingsPda(claimant), isSigner: false, isWritable: true },
            { pubkey: deriveConfigPda(), isSigner: false, isWritable: false },
            { pubkey: derivePoolPda(), isSigner: false, isWritable: true },
            { pubkey: treasury, isSigner: false, isWritable: true },
            { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: claimant, isSigner: false, isWritable: true },
            { pubkey: new PublicKey(PUMP_AMM_PROGRAM_ID.toString()), isSigner: false, isWritable: false },
            { pubkey: new PublicKey(PUMP_AMM_GLOBAL_CONFIG_PDA.toString()), isSigner: false, isWritable: false },
            { pubkey: swapAccounts.baseMint, isSigner: false, isWritable: false },
            { pubkey: swapAccounts.quoteMint, isSigner: false, isWritable: false },
            { pubkey: swapAccounts.pool, isSigner: false, isWritable: true },
            { pubkey: treasuryTokenAccount, isSigner: false, isWritable: true },
            { pubkey: treasuryWsolAccount, isSigner: false, isWritable: true },
            { pubkey: swapAccounts.poolBaseTokenAccount, isSigner: false, isWritable: true },
            { pubkey: swapAccounts.poolQuoteTokenAccount, isSigner: false, isWritable: true },
            { pubkey: swapAccounts.protocolFeeRecipient, isSigner: false, isWritable: false },
            { pubkey: swapAccounts.protocolFeeRecipientTokenAccount, isSigner: false, isWritable: true },
            { pubkey: swapAccounts.baseTokenProgram, isSigner: false, isWritable: false },
            { pubkey: swapAccounts.quoteTokenProgram, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: new PublicKey(PUMP_AMM_EVENT_AUTHORITY_PDA.toString()), isSigner: false, isWritable: false },
            { pubkey: swapAccounts.coinCreatorVaultAta, isSigner: false, isWritable: true },
            { pubkey: coinCreatorVaultAuthorityPda(swapState.pool.coinCreator), isSigner: false, isWritable: false },
            { pubkey: swapState.pool.coinCreator, isSigner: false, isWritable: false },
            { pubkey: new PublicKey(PUMP_AMM_GLOBAL_VOLUME_ACCUMULATOR_PDA.toString()), isSigner: false, isWritable: false },
            { pubkey: userVolumeAccumulatorPda(treasury), isSigner: false, isWritable: true },
            { pubkey: new PublicKey(PUMP_AMM_FEE_CONFIG_PDA.toString()), isSigner: false, isWritable: false },
            { pubkey: new PublicKey(PUMP_FEE_PROGRAM_ID.toString()), isSigner: false, isWritable: false },
            { pubkey: poolV2Pda(new PublicKey(config.token.mint)), isSigner: false, isWritable: false },
            { pubkey: swapAccounts.buybackFeeRecipient, isSigner: false, isWritable: false },
            { pubkey: swapAccounts.buybackFeeRecipientTokenAccount, isSigner: false, isWritable: true },
            { pubkey: claimantTokenAccount, isSigner: false, isWritable: true },
            { pubkey: delegatorTokenAccount, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
    });

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({
        feePayer: delegator,
        blockhash,
        lastValidBlockHeight,
    }).add(ed25519Instruction, instruction);

    return {
        transaction,
        blockhash,
        lastValidBlockHeight,
        expiresAt: Number(expiresAt),
        signerPubkey: signer.publicKey.toBase58(),
        claimantPubkey: claimant.toBase58(),
        delegatorPubkey: delegator.toBase58(),
        minimumTokenAmountOut: minimumTokenAmountOut.toString(),
    };
}

export async function buildDelegatedClaimManyToTokensTransaction(
    delegator: PublicKey,
    entries: Array<TokenizedBatchClaimEntry>,
) {
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + config.rewards.claimExpiresInSeconds);
    const batchEntries: Array<BatchClaimEntry> = entries.map((entry) => ({
        claimant: entry.claimant,
        cumulativeEarned: entry.cumulativeEarned,
        observedTotalDeposits: entry.observedTotalDeposits,
        expiresAt,
    }));
    const message = buildBatchClaimMessage(derivePoolPda(), batchEntries);
    const signer = loadBackendKeypair();
    const ed25519Instruction = Ed25519Program.createInstructionWithPrivateKey({
        privateKey: signer.secretKey,
        message,
    });

    const totalEstimatedClaimableLamports = entries.reduce(
        (sum, entry) => sum + entry.estimatedClaimableLamports,
        0n,
    );
    const treasury = deriveTreasuryPda();
    const pumpAmmSdk = new OnlinePumpAmmSdk(connection);
    const pumpPool = canonicalPumpPoolPda(new PublicKey(config.token.mint));
    const swapState = await pumpAmmSdk.swapSolanaState(pumpPool, treasury);
    const swapAccounts = (PUMP_AMM_SDK as any).swapAccounts(swapState) as {
        protocolFeeRecipient: PublicKey;
        protocolFeeRecipientTokenAccount: PublicKey;
        buybackFeeRecipient: PublicKey;
        buybackFeeRecipientTokenAccount: PublicKey;
        coinCreatorVaultAta: PublicKey;
        coinCreatorVaultAuthority: PublicKey;
        globalVolumeAccumulator: PublicKey;
        userVolumeAccumulator: PublicKey;
        feeConfig: PublicKey;
        feeProgram: PublicKey;
        baseMint: PublicKey;
        quoteMint: PublicKey;
        pool: PublicKey;
        poolBaseTokenAccount: PublicKey;
        poolQuoteTokenAccount: PublicKey;
        baseTokenProgram: PublicKey;
        quoteTokenProgram: PublicKey;
    };

    const quote = quotePumpAmmBuyQuoteInput({
        quote: new BN(totalEstimatedClaimableLamports.toString()),
        slippage: 15,
        baseReserve: swapState.poolBaseAmount,
        quoteReserve: swapState.poolQuoteAmount,
        globalConfig: swapState.globalConfig,
        baseMintAccount: swapState.baseMintAccount,
        baseMint: swapState.baseMint,
        coinCreator: swapState.pool.coinCreator,
        creator: swapState.pool.creator,
        feeConfig: swapState.feeConfig,
    });
    const quotedBaseAmountOut = BigInt(quote.base.toString());
    const minimumTokenAmountOut = quotedBaseAmountOut * TOKENIZED_CLAIM_MIN_OUTPUT_BPS / TOKENIZED_CLAIM_BPS_DENOMINATOR;

    const treasuryTokenAccount = getAssociatedTokenAddressSync(
        new PublicKey(config.token.mint),
        treasury,
        true,
        TOKEN_2022_PROGRAM_ID,
    );
    const treasuryWsolAccount = getAssociatedTokenAddressSync(
        NATIVE_MINT,
        treasury,
        true,
        TOKEN_PROGRAM_ID,
    );
    const delegatorTokenAccount = getAssociatedTokenAddressSync(
        new PublicKey(config.token.mint),
        delegator,
        false,
        TOKEN_2022_PROGRAM_ID,
    );

    const data = Buffer.alloc(8 + 4 + batchEntries.length * 56 + 8);
    instructionDiscriminator('delegated_claim_many_to_tokens').copy(data, 0);
    data.writeUInt32LE(batchEntries.length, 8);

    let offset = 12;
    for (const entry of batchEntries) {
        entry.claimant.toBuffer().copy(data, offset);
        offset += 32;
        data.writeBigUInt64LE(entry.cumulativeEarned, offset);
        offset += 8;
        data.writeBigUInt64LE(entry.observedTotalDeposits, offset);
        offset += 8;
        data.writeBigInt64LE(entry.expiresAt, offset);
        offset += 8;
    }
    data.writeBigUInt64LE(minimumTokenAmountOut, offset);

    const instructionKeys = [
        { pubkey: delegator, isSigner: true, isWritable: true },
        { pubkey: deriveConfigPda(), isSigner: false, isWritable: false },
        { pubkey: derivePoolPda(), isSigner: false, isWritable: true },
        { pubkey: treasury, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: new PublicKey(PUMP_AMM_PROGRAM_ID.toString()), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(PUMP_AMM_GLOBAL_CONFIG_PDA.toString()), isSigner: false, isWritable: false },
        { pubkey: swapAccounts.baseMint, isSigner: false, isWritable: false },
        { pubkey: swapAccounts.quoteMint, isSigner: false, isWritable: false },
        { pubkey: swapAccounts.pool, isSigner: false, isWritable: true },
        { pubkey: treasuryTokenAccount, isSigner: false, isWritable: true },
        { pubkey: treasuryWsolAccount, isSigner: false, isWritable: true },
        { pubkey: swapAccounts.poolBaseTokenAccount, isSigner: false, isWritable: true },
        { pubkey: swapAccounts.poolQuoteTokenAccount, isSigner: false, isWritable: true },
        { pubkey: swapAccounts.protocolFeeRecipient, isSigner: false, isWritable: false },
        { pubkey: swapAccounts.protocolFeeRecipientTokenAccount, isSigner: false, isWritable: true },
        { pubkey: swapAccounts.baseTokenProgram, isSigner: false, isWritable: false },
        { pubkey: swapAccounts.quoteTokenProgram, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: new PublicKey(PUMP_AMM_EVENT_AUTHORITY_PDA.toString()), isSigner: false, isWritable: false },
        { pubkey: swapAccounts.coinCreatorVaultAta, isSigner: false, isWritable: true },
        { pubkey: coinCreatorVaultAuthorityPda(swapState.pool.coinCreator), isSigner: false, isWritable: false },
        { pubkey: swapState.pool.coinCreator, isSigner: false, isWritable: false },
        { pubkey: new PublicKey(PUMP_AMM_GLOBAL_VOLUME_ACCUMULATOR_PDA.toString()), isSigner: false, isWritable: false },
        { pubkey: userVolumeAccumulatorPda(treasury), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(PUMP_AMM_FEE_CONFIG_PDA.toString()), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(PUMP_FEE_PROGRAM_ID.toString()), isSigner: false, isWritable: false },
        { pubkey: poolV2Pda(new PublicKey(config.token.mint)), isSigner: false, isWritable: false },
        { pubkey: swapAccounts.buybackFeeRecipient, isSigner: false, isWritable: false },
        { pubkey: swapAccounts.buybackFeeRecipientTokenAccount, isSigner: false, isWritable: true },
        { pubkey: delegatorTokenAccount, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    for (const entry of batchEntries) {
        instructionKeys.push(
            { pubkey: deriveUserClaimPda(entry.claimant), isSigner: false, isWritable: true },
            { pubkey: deriveUserDelegationSettingsPda(entry.claimant), isSigner: false, isWritable: true },
            { pubkey: entry.claimant, isSigner: false, isWritable: true },
            {
                pubkey: getAssociatedTokenAddressSync(
                    new PublicKey(config.token.mint),
                    entry.claimant,
                    false,
                    TOKEN_2022_PROGRAM_ID,
                ),
                isSigner: false,
                isWritable: true,
            },
        );
    }

    const instruction = new TransactionInstruction({
        programId: getProgramId(),
        keys: instructionKeys,
        data,
    });

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({
        feePayer: delegator,
        blockhash,
        lastValidBlockHeight,
    }).add(ed25519Instruction, instruction);

    return {
        transaction,
        blockhash,
        lastValidBlockHeight,
        expiresAt: Number(expiresAt),
        signerPubkey: signer.publicKey.toBase58(),
        delegatorPubkey: delegator.toBase58(),
        claimants: batchEntries.map((entry) => entry.claimant.toBase58()),
        minimumTokenAmountOut: minimumTokenAmountOut.toString(),
        totalEstimatedClaimableLamports: totalEstimatedClaimableLamports.toString(),
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
