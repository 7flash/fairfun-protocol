import {
    AddressLookupTableProgram,
    ComputeBudgetProgram,
    Keypair,
    PublicKey,
    TransactionInstruction,
    TransactionMessage,
    VersionedTransaction,
} from '@solana/web3.js';
import { getMeta, setMeta } from './database';
import {
    buildDelegatedClaimToTokensTransaction,
} from './fairfun-program';
import { connection } from './solana';

const LOOKUP_TABLE_METADATA_KEY_PREFIX = 'tokenizedClaimLookupTableAddress';
const LOOKUP_TABLE_CHUNK_SIZE = 20;
const LOOKUP_TABLE_FINALIZATION_POLL_MS = 1_000;
const LOOKUP_TABLE_FINALIZATION_RETRIES = 15;
const TOKENIZED_CLAIM_COMPUTE_UNITS = 400_000;
const TOKENIZED_CLAIM_COMPUTE_PRICE_MICROLAMPORTS = 10_000;

function collectLookupTableAddresses(instructions: Array<TransactionInstruction>, feePayer: PublicKey) {
    const addresses = new Map<string, PublicKey>();

    for (const instruction of instructions) {
        if (!instruction.programId.equals(feePayer)) {
            addresses.set(instruction.programId.toBase58(), instruction.programId);
        }

        for (const key of instruction.keys) {
            if (key.isSigner || key.pubkey.equals(feePayer)) {
                continue;
            }
            addresses.set(key.pubkey.toBase58(), key.pubkey);
        }
    }

    return Array.from(addresses.values());
}

async function sendVersionedTransaction(instructions: Array<TransactionInstruction>, signer: Keypair) {
    const latestBlockhash = await connection.getLatestBlockhash('finalized');
    const message = new TransactionMessage({
        payerKey: signer.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions,
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([signer]);
    const signature = await connection.sendTransaction(transaction, {
        skipPreflight: false,
        maxRetries: 5,
    });

    const confirmation = await connection.confirmTransaction({
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    }, 'finalized');
    if (confirmation.value.err) {
        throw new Error(JSON.stringify(confirmation.value.err));
    }

    return signature;
}

async function createLookupTable(authority: Keypair) {
    const recentSlot = await connection.getSlot('finalized');
    const [createInstruction, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
        authority: authority.publicKey,
        payer: authority.publicKey,
        recentSlot,
    });
    await sendVersionedTransaction([createInstruction], authority);
    return lookupTableAddress;
}

async function loadLookupTable(address: PublicKey) {
    return (await connection.getAddressLookupTable(address, { commitment: 'finalized' })).value;
}

async function sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLookupTableAddresses(address: PublicKey, minimumAddressCount: number) {
    for (let attempt = 0; attempt < LOOKUP_TABLE_FINALIZATION_RETRIES; attempt++) {
        const lookupTable = await loadLookupTable(address);
        if (lookupTable && lookupTable.state.addresses.length >= minimumAddressCount) {
            return lookupTable;
        }
        await sleep(LOOKUP_TABLE_FINALIZATION_POLL_MS);
    }

    throw new Error(`Lookup table ${address.toBase58()} did not reach ${minimumAddressCount} addresses`);
}

async function ensureTokenizedClaimLookupTable(
    authority: Keypair,
    instructions: Array<TransactionInstruction>,
) {
    const metadataKey = `${LOOKUP_TABLE_METADATA_KEY_PREFIX}:${authority.publicKey.toBase58()}`;
    const storedAddress = getMeta(metadataKey);
    let lookupTableAddress = storedAddress ? new PublicKey(storedAddress) : null;
    let lookupTable = lookupTableAddress ? await loadLookupTable(lookupTableAddress) : null;

    if (!lookupTableAddress || !lookupTable) {
        lookupTableAddress = await createLookupTable(authority);
        setMeta(metadataKey, lookupTableAddress.toBase58());
        lookupTable = await waitForLookupTableAddresses(lookupTableAddress, 0);
        if (!lookupTable) {
            throw new Error('Lookup table was not found after creation');
        }
    }

    const requiredAddresses = collectLookupTableAddresses(instructions, authority.publicKey);
    const existingAddresses = new Set(lookupTable.state.addresses.map((address) => address.toBase58()));
    const missingAddresses = requiredAddresses.filter((address) => !existingAddresses.has(address.toBase58()));

    for (let index = 0; index < missingAddresses.length; index += LOOKUP_TABLE_CHUNK_SIZE) {
        const extendInstruction = AddressLookupTableProgram.extendLookupTable({
            payer: authority.publicKey,
            authority: authority.publicKey,
            lookupTable: lookupTableAddress,
            addresses: missingAddresses.slice(index, index + LOOKUP_TABLE_CHUNK_SIZE),
        });
        await sendVersionedTransaction([extendInstruction], authority);
    }

    const refreshedLookupTable = await waitForLookupTableAddresses(
        lookupTableAddress,
        existingAddresses.size + missingAddresses.length,
    );
    if (!refreshedLookupTable) {
        throw new Error('Lookup table was not found after extension');
    }

    return {
        lookupTableAddress,
        lookupTable: refreshedLookupTable,
    };
}

export interface VersionedDelegatedTokenClaimResult {
    blockhash: string;
    claimantPubkey: string;
    delegatorPubkey: string;
    lastValidBlockHeight: number;
    lookupTableAddress: string;
    minimumTokenAmountOut: string;
    transaction: VersionedTransaction;
}

export async function buildVersionedDelegatedTokenClaimTransaction(
    lookupTableAuthority: Keypair,
    delegator: PublicKey,
    claimant: PublicKey,
    cumulativeEarned: bigint,
    observedTotalDeposits: bigint,
    estimatedClaimableLamports: bigint,
): Promise<VersionedDelegatedTokenClaimResult> {
    const transactionResult = await buildDelegatedClaimToTokensTransaction(
        delegator,
        claimant,
        cumulativeEarned,
        observedTotalDeposits,
        estimatedClaimableLamports,
    );

    const { lookupTableAddress, lookupTable } = await ensureTokenizedClaimLookupTable(
        lookupTableAuthority,
        transactionResult.transaction.instructions,
    );
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
        payerKey: delegator,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: TOKENIZED_CLAIM_COMPUTE_UNITS }),
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: TOKENIZED_CLAIM_COMPUTE_PRICE_MICROLAMPORTS,
            }),
            ...transactionResult.transaction.instructions,
        ],
    }).compileToV0Message([lookupTable]);
    const transaction = new VersionedTransaction(message);

    return {
        blockhash: latestBlockhash.blockhash,
        claimantPubkey: claimant.toBase58(),
        delegatorPubkey: delegator.toBase58(),
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        lookupTableAddress: lookupTableAddress.toBase58(),
        minimumTokenAmountOut: transactionResult.minimumTokenAmountOut,
        transaction,
    };
}

export async function sendSignedDelegatedTokenClaimTransaction(
    signer: Keypair,
    claimant: PublicKey,
    cumulativeEarned: bigint,
    observedTotalDeposits: bigint,
    estimatedClaimableLamports: bigint,
) {
    const result = await buildVersionedDelegatedTokenClaimTransaction(
        signer,
        signer.publicKey,
        claimant,
        cumulativeEarned,
        observedTotalDeposits,
        estimatedClaimableLamports,
    );
    result.transaction.sign([signer]);
    const signature = await connection.sendTransaction(result.transaction, {
        skipPreflight: false,
        maxRetries: 5,
    });
    const confirmation = await connection.confirmTransaction({
        signature,
        blockhash: result.blockhash,
        lastValidBlockHeight: result.lastValidBlockHeight,
    }, 'confirmed');
    if (confirmation.value.err) {
        throw new Error(JSON.stringify(confirmation.value.err));
    }

    return {
        signature,
        lookupTableAddress: result.lookupTableAddress,
        minimumTokenAmountOut: result.minimumTokenAmountOut,
    };
}
