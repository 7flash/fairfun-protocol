use std::path::PathBuf;

use anchor_lang::{
    prelude::Pubkey,
    system_program,
    AccountDeserialize,
    InstructionData,
    ToAccountMetas,
};
use fairfun_rewards::{accounts, instruction, GlobalConfig, RewardPool, ID};
use litesvm::LiteSVM;
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
    let pool = pool_address(&token_mint);
    let treasury = treasury_address(&token_mint);
    svm.airdrop(&admin.pubkey(), 2_000_000_000).unwrap();
    svm.airdrop(&depositor.pubkey(), 2_000_000_000).unwrap();
    svm.airdrop(&user.pubkey(), 2_000_000_000).unwrap();

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
    let setup_blockhash = svm.latest_blockhash();
    let setup_message = Message::new_with_blockhash(
        &[initialize_instruction, register_instruction],
        Some(&admin.pubkey()),
        &setup_blockhash,
    );
    let setup_transaction = Transaction::new(&[&admin], setup_message, setup_blockhash);
    svm.send_transaction(setup_transaction).unwrap();

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
