use std::path::PathBuf;

use anchor_lang::{
    prelude::Pubkey,
    system_program,
    AccountDeserialize,
    InstructionData,
    ToAccountMetas,
};
use fairfun_rewards::{accounts, instruction, BatchClaimEntry, GlobalConfig, RewardPool, UserClaim, ID};
use litesvm::LiteSVM;
use solana_ed25519_program::new_ed25519_instruction_with_signature;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

fn program_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/fairfun_rewards.so")
}

fn create_svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(ID, program_path()).unwrap();
    svm
}

fn config_address() -> Pubkey {
    Pubkey::find_program_address(&[b"rewards_config"], &ID).0
}

fn pool_address(token_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"rewards_pool", token_mint.as_ref()], &ID).0
}

fn treasury_address(token_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"rewards_treasury", token_mint.as_ref()], &ID).0
}

fn user_claim_address(pool: &Pubkey, user: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"rewards_user_claim", pool.as_ref(), user.as_ref()], &ID).0
}

fn delegation_settings_address(pool: &Pubkey, user: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"rewards_user_delegation_settings", pool.as_ref(), user.as_ref()],
        &ID,
    )
    .0
}

fn build_batch_claim_message(pool: &Pubkey, entries: &Vec<BatchClaimEntry>) -> Vec<u8> {
    let mut message = Vec::with_capacity(36 + entries.len() * 56);
    message.extend_from_slice(pool.as_ref());
    message.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for entry in entries {
        message.extend_from_slice(entry.claimant.as_ref());
        message.extend_from_slice(&entry.cumulative_earned.to_le_bytes());
        message.extend_from_slice(&entry.observed_total_deposits.to_le_bytes());
        message.extend_from_slice(&entry.expires_at.to_le_bytes());
    }
    message
}

fn initialize_pool(
    svm: &mut LiteSVM,
    admin: &Keypair,
    backend: &Keypair,
    token_mint: Pubkey,
) -> (Pubkey, Pubkey) {
    let pool = pool_address(&token_mint);
    let treasury = treasury_address(&token_mint);
    let initialize_instruction = Instruction {
        program_id: ID,
        accounts: accounts::Initialize {
            admin: admin.pubkey(),
            config: config_address(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::Initialize {
            backend_authority: backend.pubkey(),
        }
        .data(),
    };
    let register_instruction = Instruction {
        program_id: ID,
        accounts: accounts::RegisterPool {
            admin: admin.pubkey(),
            config: config_address(),
            pool,
            treasury,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::RegisterPool { token_mint }.data(),
    };
    let blockhash = svm.latest_blockhash();
    let message = Message::new_with_blockhash(
        &[initialize_instruction, register_instruction],
        Some(&admin.pubkey()),
        &blockhash,
    );
    let transaction = Transaction::new(&[admin], message, blockhash);
    svm.send_transaction(transaction).unwrap();
    (pool, treasury)
}

#[test]
fn initialize_and_register_pool() {
    let mut svm = create_svm();
    let admin = Keypair::new();
    let backend = Keypair::new();
    let token_mint = Pubkey::new_unique();

    svm.airdrop(&admin.pubkey(), 2_000_000_000).unwrap();

    let initialize_instruction = Instruction {
        program_id: ID,
        accounts: accounts::Initialize {
            admin: admin.pubkey(),
            config: config_address(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::Initialize {
            backend_authority: backend.pubkey(),
        }
        .data(),
    };

    let register_instruction = Instruction {
        program_id: ID,
        accounts: accounts::RegisterPool {
            admin: admin.pubkey(),
            config: config_address(),
            pool: pool_address(&token_mint),
            treasury: treasury_address(&token_mint),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::RegisterPool { token_mint }.data(),
    };

    let blockhash = svm.latest_blockhash();
    let message = Message::new_with_blockhash(
        &[initialize_instruction, register_instruction],
        Some(&admin.pubkey()),
        &blockhash,
    );
    let transaction = Transaction::new(&[&admin], message, blockhash);
    svm.send_transaction(transaction).unwrap();

    let config_account = svm.get_account(&config_address()).unwrap();
    let config_state = GlobalConfig::try_deserialize(&mut config_account.data.as_slice()).unwrap();
    assert_eq!(config_state.admin, admin.pubkey());
    assert_eq!(config_state.backend_authority, backend.pubkey());

    let pool_account = svm.get_account(&pool_address(&token_mint)).unwrap();
    let pool_state = RewardPool::try_deserialize(&mut pool_account.data.as_slice()).unwrap();
    assert_eq!(pool_state.token_mint, token_mint);
    assert_eq!(pool_state.total_deposited, 0);
    assert!(pool_state.active);
}

#[test]
fn deposit_updates_treasury_and_pool_total() {
    let mut svm = create_svm();
    let admin = Keypair::new();
    let backend = Keypair::new();
    let depositor = Keypair::new();
    let user = Keypair::new();
    let token_mint = Pubkey::new_unique();
    svm.airdrop(&admin.pubkey(), 2_000_000_000).unwrap();
    svm.airdrop(&depositor.pubkey(), 2_000_000_000).unwrap();
    svm.airdrop(&user.pubkey(), 2_000_000_000).unwrap();
    let (pool, treasury) = initialize_pool(&mut svm, &admin, &backend, token_mint);

    let deposit_amount = 1_000_000u64;
    let deposit_instruction = Instruction {
        program_id: ID,
        accounts: accounts::Deposit {
            depositor: depositor.pubkey(),
            pool,
            treasury,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::Deposit {
            amount: deposit_amount,
        }
        .data(),
    };
    let deposit_blockhash = svm.latest_blockhash();
    let deposit_message =
        Message::new_with_blockhash(&[deposit_instruction], Some(&depositor.pubkey()), &deposit_blockhash);
    let deposit_transaction = Transaction::new(&[&depositor], deposit_message, deposit_blockhash);
    let treasury_before = svm.get_account(&treasury).unwrap().lamports;
    svm.send_transaction(deposit_transaction).unwrap();

    let treasury_account = svm.get_account(&treasury).unwrap();
    let pool_account = svm.get_account(&pool).unwrap();
    let pool_state = RewardPool::try_deserialize(&mut pool_account.data.as_slice()).unwrap();

    assert_eq!(treasury_account.lamports - treasury_before, deposit_amount);
    assert_eq!(pool_state.total_deposited, deposit_amount);
    assert_eq!(pool_state.total_claimed, 0);
}

#[test]
#[ignore = "LiteSVM on this Windows toolchain cannot execute the ed25519 precompile path required by delegated_claim_many"]
fn delegated_claim_many_claims_multiple_users() {
    let mut svm = create_svm();
    let admin = Keypair::new();
    let backend = Keypair::new();
    let depositor = Keypair::new();
    let delegator = Keypair::new();
    let claimant_one = Keypair::new();
    let claimant_two = Keypair::new();
    let token_mint = Pubkey::new_unique();

    svm.airdrop(&admin.pubkey(), 2_000_000_000).unwrap();
    svm.airdrop(&depositor.pubkey(), 2_000_000_000).unwrap();
    svm.airdrop(&delegator.pubkey(), 2_000_000_000).unwrap();
    svm.airdrop(&claimant_one.pubkey(), 1_000_000).unwrap();
    svm.airdrop(&claimant_two.pubkey(), 1_000_000).unwrap();

    let (pool, treasury) = initialize_pool(&mut svm, &admin, &backend, token_mint);

    let deposit_instruction = Instruction {
        program_id: ID,
        accounts: accounts::Deposit {
            depositor: depositor.pubkey(),
            pool,
            treasury,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::Deposit {
            amount: 5_000_000,
        }
        .data(),
    };
    let deposit_blockhash = svm.latest_blockhash();
    let deposit_message =
        Message::new_with_blockhash(&[deposit_instruction], Some(&depositor.pubkey()), &deposit_blockhash);
    let deposit_transaction = Transaction::new(&[&depositor], deposit_message, deposit_blockhash);
    svm.send_transaction(deposit_transaction).unwrap();

    let entries = vec![
        BatchClaimEntry {
            claimant: claimant_one.pubkey(),
            cumulative_earned: 1_500_000,
            observed_total_deposits: 5_000_000,
            expires_at: i64::MAX,
        },
        BatchClaimEntry {
            claimant: claimant_two.pubkey(),
            cumulative_earned: 2_000_000,
            observed_total_deposits: 5_000_000,
            expires_at: i64::MAX,
        },
    ];
    let batch_message = build_batch_claim_message(&pool, &entries);
    let signature = backend.sign_message(&batch_message);
    let ed25519_instruction = new_ed25519_instruction_with_signature(
        &batch_message,
        signature.as_array(),
        &backend.pubkey().to_bytes(),
    );

    let mut claim_instruction = Instruction {
        program_id: ID,
        accounts: accounts::DelegatedClaimMany {
            delegator: delegator.pubkey(),
            config: config_address(),
            pool,
            treasury,
            instructions: solana_sdk_ids::sysvar::instructions::id(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::DelegatedClaimMany {
            entries: entries.clone(),
        }
        .data(),
    };
    for entry in &entries {
        claim_instruction.accounts.push(solana_instruction::AccountMeta::new(
            user_claim_address(&pool, &entry.claimant),
            false,
        ));
        claim_instruction.accounts.push(solana_instruction::AccountMeta::new(
            delegation_settings_address(&pool, &entry.claimant),
            false,
        ));
        claim_instruction.accounts.push(solana_instruction::AccountMeta::new(entry.claimant, false));
    }

    let claimant_one_before = svm.get_account(&claimant_one.pubkey()).unwrap().lamports;
    let claimant_two_before = svm.get_account(&claimant_two.pubkey()).unwrap().lamports;
    let delegator_before = svm.get_account(&delegator.pubkey()).unwrap().lamports;

    let claim_blockhash = svm.latest_blockhash();
    let claim_message = Message::new_with_blockhash(
        &[ed25519_instruction, claim_instruction],
        Some(&delegator.pubkey()),
        &claim_blockhash,
    );
    let claim_transaction = Transaction::new(&[&delegator], claim_message, claim_blockhash);
    svm.send_transaction(claim_transaction).unwrap();

    let claimant_one_after = svm.get_account(&claimant_one.pubkey()).unwrap().lamports;
    let claimant_two_after = svm.get_account(&claimant_two.pubkey()).unwrap().lamports;
    let delegator_after = svm.get_account(&delegator.pubkey()).unwrap().lamports;
    let treasury_after = svm.get_account(&treasury).unwrap().lamports;
    let pool_account = svm.get_account(&pool).unwrap();
    let pool_state = RewardPool::try_deserialize(&mut pool_account.data.as_slice()).unwrap();
    let user_claim_one_account = svm
        .get_account(&user_claim_address(&pool, &claimant_one.pubkey()))
        .unwrap();
    let user_claim_two_account = svm
        .get_account(&user_claim_address(&pool, &claimant_two.pubkey()))
        .unwrap();
    let user_claim_one = UserClaim::try_deserialize(&mut user_claim_one_account.data.as_slice()).unwrap();
    let user_claim_two = UserClaim::try_deserialize(&mut user_claim_two_account.data.as_slice()).unwrap();

    assert_eq!(claimant_one_after - claimant_one_before, 1_350_000);
    assert_eq!(claimant_two_after - claimant_two_before, 1_800_000);
    assert_eq!(delegator_after - delegator_before, 350_000 - 5_000);
    assert_eq!(treasury_after, 1_500_000);
    assert_eq!(pool_state.total_claimed, 3_500_000);
    assert_eq!(user_claim_one.claimed_amount, 1_500_000);
    assert_eq!(user_claim_two.claimed_amount, 2_000_000);
}
