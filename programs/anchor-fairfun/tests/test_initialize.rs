use std::path::PathBuf;

use anchor_fairfun::{accounts, instruction, Config, ID};
use anchor_lang::{prelude::Pubkey, system_program, AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

fn program_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/anchor_fairfun.so")
}

fn create_svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(ID, program_path()).unwrap();
    svm
}

fn config_address() -> Pubkey {
    Pubkey::find_program_address(&[b"config"], &ID).0
}

#[test]
fn initialize_config_creates_protocol_config() {
    let mut svm = create_svm();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 1_000_000_000).unwrap();

    let config = config_address();
    let fee_bps = 250u16;
    let instruction = Instruction {
        program_id: ID,
        accounts: accounts::InitializeConfig {
            admin: admin.pubkey(),
            config,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::InitializeConfig { fee_bps }.data(),
    };

    let blockhash = svm.latest_blockhash();
    let message = Message::new_with_blockhash(&[instruction], Some(&admin.pubkey()), &blockhash);
    let transaction = Transaction::new(&[&admin], message, blockhash);

    let result = svm.send_transaction(transaction).unwrap();
    let config_account = svm.get_account(&config).unwrap();
    let config_state = Config::try_deserialize(&mut config_account.data.as_slice()).unwrap();

    assert_eq!(config_state.admin, admin.pubkey());
    assert_eq!(config_state.fee_bps, fee_bps);
    assert!(!config_state.paused);
    assert_eq!(config_state.total_deals, 0);
    assert!(result.compute_units_consumed > 0);
}

#[test]
fn initialize_config_rejects_fee_over_ten_percent() {
    let mut svm = create_svm();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 1_000_000_000).unwrap();

    let instruction = Instruction {
        program_id: ID,
        accounts: accounts::InitializeConfig {
            admin: admin.pubkey(),
            config: config_address(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::InitializeConfig { fee_bps: 1001 }.data(),
    };

    let blockhash = svm.latest_blockhash();
    let message = Message::new_with_blockhash(&[instruction], Some(&admin.pubkey()), &blockhash);
    let transaction = Transaction::new(&[&admin], message, blockhash);

    let result = svm.send_transaction(transaction);
    assert!(result.is_err());
    assert!(svm.get_account(&config_address()).is_none());
}

#[test]
fn initialize_config_cannot_run_twice_for_same_pda() {
    let mut svm = create_svm();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 2_000_000_000).unwrap();

    let config = config_address();
    let first_instruction = Instruction {
        program_id: ID,
        accounts: accounts::InitializeConfig {
            admin: admin.pubkey(),
            config,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::InitializeConfig { fee_bps: 250 }.data(),
    };
    let first_blockhash = svm.latest_blockhash();
    let first_message = Message::new_with_blockhash(
        &[first_instruction],
        Some(&admin.pubkey()),
        &first_blockhash,
    );
    let first_transaction = Transaction::new(&[&admin], first_message, first_blockhash);
    svm.send_transaction(first_transaction).unwrap();

    let second_instruction = Instruction {
        program_id: ID,
        accounts: accounts::InitializeConfig {
            admin: admin.pubkey(),
            config,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::InitializeConfig { fee_bps: 100 }.data(),
    };
    let second_blockhash = svm.latest_blockhash();
    let second_message = Message::new_with_blockhash(
        &[second_instruction],
        Some(&admin.pubkey()),
        &second_blockhash,
    );
    let second_transaction = Transaction::new(&[&admin], second_message, second_blockhash);

    let second_result = svm.send_transaction(second_transaction);
    assert!(second_result.is_err());

    let config_account = svm.get_account(&config).unwrap();
    let config_state = Config::try_deserialize(&mut config_account.data.as_slice()).unwrap();
    assert_eq!(config_state.fee_bps, 250);
}
