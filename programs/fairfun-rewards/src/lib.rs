use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::invoke,
    program::invoke_signed,
    program_error::ProgramError,
};
use spl_associated_token_account::{
    get_associated_token_address_with_program_id,
    instruction::create_associated_token_account_idempotent,
};
use spl_token::native_mint::ID as NATIVE_MINT_ID;
use spl_token_2022::{
    extension::StateWithExtensions,
    state::{Account as Token2022Account, Mint as Token2022Mint},
};
use solana_instructions_sysvar::{
    load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_ID,
};

mod errors;
mod introspection;
mod state;

use errors::FairfunRewardsError;
use introspection::verify_ed25519_ix_integrity;
pub use state::{GlobalConfig, RewardPool, UserClaim, UserDelegationSettings};

const DELEGATED_CLAIM_FEE_BPS: u64 = 1_000;
const BASIS_POINTS_DENOMINATOR: u64 = 10_000;
const PUMP_AMM_BUY_DISCRIMINATOR: [u8; 8] = [102, 6, 61, 18, 1, 218, 235, 234];
const PUMP_AMM_PROGRAM_ID: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const PUMP_FEE_PROGRAM_ID: Pubkey = pubkey!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

declare_id!("HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A");

fn calculate_claimable(
    previous_claimed_amount: u64,
    cumulative_earned: u64,
    observed_total_deposits: u64,
    onchain_total_received: u64,
    pool_total_claimed: u64,
) -> Result<u64> {
    require!(
        cumulative_earned >= previous_claimed_amount,
        FairfunRewardsError::CumulativeEarnedDecreased
    );
    require!(
        cumulative_earned <= observed_total_deposits,
        FairfunRewardsError::EarnedExceedsObservedDeposits
    );
    require!(
        observed_total_deposits <= onchain_total_received,
        FairfunRewardsError::ObservedDepositsExceedOnchainTotal
    );

    let claimable = cumulative_earned
        .checked_sub(previous_claimed_amount)
        .unwrap();
    require!(claimable > 0, FairfunRewardsError::NothingToClaim);

    let new_total_claimed = pool_total_claimed.checked_add(claimable).unwrap();
    require!(
        new_total_claimed <= onchain_total_received,
        FairfunRewardsError::ClaimExceedsPoolDeposits
    );

    Ok(claimable)
}

fn calculate_delegated_claim_split(claimable: u64) -> (u64, u64) {
    let delegator_fee = claimable
        .checked_mul(DELEGATED_CLAIM_FEE_BPS)
        .unwrap()
        / BASIS_POINTS_DENOMINATOR;
    let claimant_amount = claimable.checked_sub(delegator_fee).unwrap();
    (claimant_amount, delegator_fee)
}

fn pump_amm_global_config_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"global_config"], &PUMP_AMM_PROGRAM_ID).0
}

fn pump_amm_event_authority_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"__event_authority"], &PUMP_AMM_PROGRAM_ID).0
}

fn pump_amm_global_volume_accumulator_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"global_volume_accumulator"], &PUMP_AMM_PROGRAM_ID).0
}

fn pump_amm_user_volume_accumulator_pda(user: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"user_volume_accumulator", user.as_ref()], &PUMP_AMM_PROGRAM_ID).0
}

fn pump_amm_coin_creator_vault_authority_pda(coin_creator: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"creator_vault", coin_creator.as_ref()], &PUMP_AMM_PROGRAM_ID).0
}

fn pump_amm_pool_v2_pda(base_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"pool-v2", base_mint.as_ref()], &PUMP_AMM_PROGRAM_ID).0
}

fn pump_amm_fee_config_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"fee_config", PUMP_AMM_PROGRAM_ID.as_ref()], &PUMP_FEE_PROGRAM_ID).0
}

fn read_token_2022_amount(account: &AccountInfo) -> Result<u64> {
    let data = account.try_borrow_data()?;
    let state = StateWithExtensions::<Token2022Account>::unpack(&data)
        .map_err(|_| ProgramError::InvalidAccountData)?;
    Ok(state.base.amount)
}

fn read_token_2022_decimals(mint: &AccountInfo) -> Result<u8> {
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<Token2022Mint>::unpack(&data)
        .map_err(|_| ProgramError::InvalidAccountData)?;
    Ok(state.base.decimals)
}

fn create_ata_if_needed<'info>(
    payer: &AccountInfo<'info>,
    ata: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    associated_token_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
) -> Result<()> {
    if !ata.data_is_empty() {
        return Ok(());
    }

    let instruction = create_associated_token_account_idempotent(
        payer.key,
        owner.key,
        mint.key,
        token_program.key,
    );

    invoke(
        &instruction,
        &[
            payer.clone(),
            ata.clone(),
            owner.clone(),
            mint.clone(),
            system_program.clone(),
            token_program.clone(),
            associated_token_program.clone(),
        ],
    )?;
    Ok(())
}

fn build_pump_amm_buy_data(base_amount_out: u64, max_quote_amount_in: u64) -> Vec<u8> {
    let mut data = Vec::with_capacity(25);
    data.extend_from_slice(&PUMP_AMM_BUY_DISCRIMINATOR);
    data.extend_from_slice(&base_amount_out.to_le_bytes());
    data.extend_from_slice(&max_quote_amount_in.to_le_bytes());
    data.push(1);
    data
}

fn invoke_sync_native<'info>(
    token_program: &AccountInfo<'info>,
    native_account: &AccountInfo<'info>,
) -> Result<()> {
    let instruction = spl_token::instruction::sync_native(token_program.key, native_account.key)?;
    invoke(&instruction, &[native_account.clone(), token_program.clone()])?;
    Ok(())
}

fn invoke_transfer_checked<'info>(
    token_program: &AccountInfo<'info>,
    source: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let instruction = spl_token_2022::instruction::transfer_checked(
        token_program.key,
        source.key,
        mint.key,
        destination.key,
        authority.key,
        &[],
        amount,
        decimals,
    )?;
    invoke_signed(
        &instruction,
        &[
            source.clone(),
            mint.clone(),
            destination.clone(),
            authority.clone(),
            token_program.clone(),
        ],
        signer_seeds,
    )?;
    Ok(())
}

fn invoke_close_account<'info>(
    token_program: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let instruction = spl_token::instruction::close_account(
        token_program.key,
        account.key,
        destination.key,
        authority.key,
        &[],
    )?;
    invoke_signed(
        &instruction,
        &[
            account.clone(),
            destination.clone(),
            authority.clone(),
            token_program.clone(),
        ],
        signer_seeds,
    )?;
    Ok(())
}

struct PumpAmmBuyAccounts<'info> {
    pool: AccountInfo<'info>,
    user: AccountInfo<'info>,
    global_config: AccountInfo<'info>,
    base_mint: AccountInfo<'info>,
    quote_mint: AccountInfo<'info>,
    user_base_token_account: AccountInfo<'info>,
    user_quote_token_account: AccountInfo<'info>,
    pool_base_token_account: AccountInfo<'info>,
    pool_quote_token_account: AccountInfo<'info>,
    protocol_fee_recipient: AccountInfo<'info>,
    protocol_fee_recipient_token_account: AccountInfo<'info>,
    base_token_program: AccountInfo<'info>,
    quote_token_program: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    associated_token_program: AccountInfo<'info>,
    event_authority: AccountInfo<'info>,
    amm_program: AccountInfo<'info>,
    coin_creator_vault_ata: AccountInfo<'info>,
    coin_creator_vault_authority: AccountInfo<'info>,
    global_volume_accumulator: AccountInfo<'info>,
    user_volume_accumulator: AccountInfo<'info>,
    fee_config: AccountInfo<'info>,
    fee_program: AccountInfo<'info>,
    pool_v2: AccountInfo<'info>,
    buyback_fee_recipient: AccountInfo<'info>,
    buyback_fee_recipient_token_account: AccountInfo<'info>,
}

fn invoke_pump_amm_buy<'info>(
    accounts: PumpAmmBuyAccounts<'info>,
    base_amount_out: u64,
    max_quote_amount_in: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let instruction = anchor_lang::solana_program::instruction::Instruction {
        program_id: PUMP_AMM_PROGRAM_ID,
        accounts: vec![
            anchor_lang::solana_program::instruction::AccountMeta::new(accounts.pool.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new(accounts.user.key(), true),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(accounts.global_config.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(accounts.base_mint.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(accounts.quote_mint.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new(accounts.user_base_token_account.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new(accounts.user_quote_token_account.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new(accounts.pool_base_token_account.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new(accounts.pool_quote_token_account.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(accounts.protocol_fee_recipient.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new(accounts.protocol_fee_recipient_token_account.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(accounts.base_token_program.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(accounts.quote_token_program.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(accounts.system_program.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(accounts.associated_token_program.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(accounts.event_authority.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(accounts.amm_program.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new(accounts.coin_creator_vault_ata.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(accounts.coin_creator_vault_authority.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(accounts.global_volume_accumulator.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new(accounts.user_volume_accumulator.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(accounts.fee_config.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(accounts.fee_program.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(accounts.pool_v2.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(accounts.buyback_fee_recipient.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new(accounts.buyback_fee_recipient_token_account.key(), false),
        ],
        data: build_pump_amm_buy_data(base_amount_out, max_quote_amount_in),
    };
    invoke_signed(
        &instruction,
        &[
            accounts.pool,
            accounts.user,
            accounts.global_config,
            accounts.base_mint,
            accounts.quote_mint,
            accounts.user_base_token_account,
            accounts.user_quote_token_account,
            accounts.pool_base_token_account,
            accounts.pool_quote_token_account,
            accounts.protocol_fee_recipient,
            accounts.protocol_fee_recipient_token_account,
            accounts.base_token_program,
            accounts.quote_token_program,
            accounts.system_program,
            accounts.associated_token_program,
            accounts.event_authority,
            accounts.amm_program,
            accounts.coin_creator_vault_ata,
            accounts.coin_creator_vault_authority,
            accounts.global_volume_accumulator,
            accounts.user_volume_accumulator,
            accounts.fee_config,
            accounts.fee_program,
            accounts.pool_v2,
            accounts.buyback_fee_recipient,
            accounts.buyback_fee_recipient_token_account,
        ],
        signer_seeds,
    )?;
    Ok(())
}

fn initialize_delegation_settings_if_empty(
    settings: &mut Account<UserDelegationSettings>,
    user: Pubkey,
    pool: Pubkey,
    bump: u8,
) {
    if settings.user == Pubkey::default() && settings.pool == Pubkey::default() {
        settings.user = user;
        settings.pool = pool;
        settings.delegated_claims_enabled = true;
        settings.bump = bump;
    }
}

#[program]
pub mod fairfun_rewards {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, backend_authority: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.backend_authority = backend_authority;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn register_pool(ctx: Context<RegisterPool>, token_mint: Pubkey) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.token_mint = token_mint;
        pool.total_deposited = 0;
        pool.total_claimed = 0;
        pool.active = true;
        pool.bump = ctx.bumps.pool;
        pool.treasury_bump = ctx.bumps.treasury;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        let transfer_instruction = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.depositor.key(),
            &ctx.accounts.treasury.key(),
            amount,
        );

        anchor_lang::solana_program::program::invoke(
            &transfer_instruction,
            &[
                ctx.accounts.depositor.to_account_info(),
                ctx.accounts.treasury.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        ctx.accounts.pool.total_deposited = ctx
            .accounts
            .pool
            .total_deposited
            .checked_add(amount)
            .unwrap();

        emit!(TreasuryDeposited {
            pool: ctx.accounts.pool.key(),
            token_mint: ctx.accounts.pool.token_mint,
            depositor: ctx.accounts.depositor.key(),
            amount,
            total_deposited: ctx.accounts.pool.total_deposited,
        });

        Ok(())
    }

    pub fn claim(
        ctx: Context<Claim>,
        cumulative_earned: u64,
        observed_total_deposits: u64,
        expires_at: i64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp <= expires_at,
            FairfunRewardsError::SignatureExpired
        );

        require!(ctx.accounts.pool.active, FairfunRewardsError::PoolInactive);

        let instruction_index = load_current_index_checked(&ctx.accounts.instructions)?;
        require!(
            instruction_index > 0,
            FairfunRewardsError::MissingSignatureInstruction
        );
        let signature_instruction =
            load_instruction_at_checked((instruction_index - 1) as usize, &ctx.accounts.instructions)?;

        let expected_message = build_claim_message(
            &ctx.accounts.user.key(),
            &ctx.accounts.pool.key(),
            cumulative_earned,
            observed_total_deposits,
            expires_at,
        );
        verify_ed25519_ix_integrity(
            &signature_instruction,
            &ctx.accounts.config.backend_authority.to_bytes(),
            &expected_message,
        )?;

        let onchain_total_received = ctx
            .accounts
            .treasury
            .lamports()
            .checked_add(ctx.accounts.pool.total_claimed)
            .unwrap();

        let user_claim = &mut ctx.accounts.user_claim;
        let claimable = calculate_claimable(
            user_claim.claimed_amount,
            cumulative_earned,
            observed_total_deposits,
            onchain_total_received,
            ctx.accounts.pool.total_claimed,
        )?;
        let new_total_claimed = ctx.accounts.pool.total_claimed.checked_add(claimable).unwrap();
        require!(
            ctx.accounts.treasury.lamports() >= claimable,
            FairfunRewardsError::InsufficientTreasury
        );

        let treasury_bump = ctx.accounts.pool.treasury_bump;
        let token_mint = ctx.accounts.pool.token_mint;
        let signer_seeds: &[&[u8]] = &[b"rewards_treasury", token_mint.as_ref(), &[treasury_bump]];
        let transfer_instruction = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.treasury.key(),
            &ctx.accounts.user.key(),
            claimable,
        );

        anchor_lang::solana_program::program::invoke_signed(
            &transfer_instruction,
            &[
                ctx.accounts.treasury.to_account_info(),
                ctx.accounts.user.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[signer_seeds],
        )?;

        user_claim.user = ctx.accounts.user.key();
        user_claim.pool = ctx.accounts.pool.key();
        user_claim.claimed_amount = cumulative_earned;
        user_claim.bump = ctx.bumps.user_claim;

        ctx.accounts.pool.total_claimed = new_total_claimed;
        if ctx.accounts.pool.total_deposited < onchain_total_received {
            ctx.accounts.pool.total_deposited = onchain_total_received;
        }

        emit!(RewardsClaimed {
            pool: ctx.accounts.pool.key(),
            token_mint: ctx.accounts.pool.token_mint,
            user: ctx.accounts.user.key(),
            claimable,
            cumulative_earned,
            observed_total_deposits,
            total_claimed: ctx.accounts.pool.total_claimed,
        });

        Ok(())
    }

    pub fn set_backend_authority(
        ctx: Context<AdminAction>,
        backend_authority: Pubkey,
    ) -> Result<()> {
        ctx.accounts.config.backend_authority = backend_authority;
        Ok(())
    }

    pub fn set_pool_active(ctx: Context<SetPoolActive>, active: bool) -> Result<()> {
        ctx.accounts.pool.active = active;
        Ok(())
    }

    pub fn set_delegated_claims_enabled(
        ctx: Context<SetDelegatedClaimsEnabled>,
        enabled: bool,
    ) -> Result<()> {
        let settings = &mut ctx.accounts.settings;
        initialize_delegation_settings_if_empty(
            settings,
            ctx.accounts.user.key(),
            ctx.accounts.pool.key(),
            ctx.bumps.settings,
        );
        settings.user = ctx.accounts.user.key();
        settings.pool = ctx.accounts.pool.key();
        settings.delegated_claims_enabled = enabled;
        settings.bump = ctx.bumps.settings;
        Ok(())
    }

    pub fn delegated_claim(
        ctx: Context<DelegatedClaim>,
        claimant: Pubkey,
        cumulative_earned: u64,
        observed_total_deposits: u64,
        expires_at: i64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp <= expires_at,
            FairfunRewardsError::SignatureExpired
        );

        require!(ctx.accounts.pool.active, FairfunRewardsError::PoolInactive);
        require_keys_neq!(
            ctx.accounts.delegator.key(),
            claimant,
            FairfunRewardsError::InvalidDelegatedClaimTarget
        );
        initialize_delegation_settings_if_empty(
            &mut ctx.accounts.claimant_settings,
            claimant,
            ctx.accounts.pool.key(),
            ctx.bumps.claimant_settings,
        );
        require!(
            ctx.accounts.claimant_settings.delegated_claims_enabled,
            FairfunRewardsError::DelegatedClaimsDisabled
        );

        // Anyone can claim for anyone else - no approval needed

        let instruction_index = load_current_index_checked(&ctx.accounts.instructions)?;
        require!(
            instruction_index > 0,
            FairfunRewardsError::MissingSignatureInstruction
        );
        let signature_instruction =
            load_instruction_at_checked((instruction_index - 1) as usize, &ctx.accounts.instructions)?;

        let expected_message = build_claim_message(
            &claimant,
            &ctx.accounts.pool.key(),
            cumulative_earned,
            observed_total_deposits,
            expires_at,
        );
        verify_ed25519_ix_integrity(
            &signature_instruction,
            &ctx.accounts.config.backend_authority.to_bytes(),
            &expected_message,
        )?;

        let onchain_total_received = ctx
            .accounts
            .treasury
            .lamports()
            .checked_add(ctx.accounts.pool.total_claimed)
            .unwrap();

        let user_claim = &mut ctx.accounts.user_claim;
        let claimable = calculate_claimable(
            user_claim.claimed_amount,
            cumulative_earned,
            observed_total_deposits,
            onchain_total_received,
            ctx.accounts.pool.total_claimed,
        )?;
        let new_total_claimed = ctx.accounts.pool.total_claimed.checked_add(claimable).unwrap();
        let (claimant_amount, delegator_fee) = calculate_delegated_claim_split(claimable);
        require!(
            ctx.accounts.treasury.lamports() >= claimable,
            FairfunRewardsError::InsufficientTreasury
        );

        let treasury_bump = ctx.accounts.pool.treasury_bump;
        let token_mint = ctx.accounts.pool.token_mint;
        let signer_seeds: &[&[u8]] = &[b"rewards_treasury", token_mint.as_ref(), &[treasury_bump]];
        let claimant_transfer_instruction = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.treasury.key(),
            &claimant,
            claimant_amount,
        );

        anchor_lang::solana_program::program::invoke_signed(
            &claimant_transfer_instruction,
            &[
                ctx.accounts.treasury.to_account_info(),
                ctx.accounts.claimant.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[signer_seeds],
        )?;

        if delegator_fee > 0 {
            let delegator_transfer_instruction = anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.treasury.key(),
                &ctx.accounts.delegator.key(),
                delegator_fee,
            );

            anchor_lang::solana_program::program::invoke_signed(
                &delegator_transfer_instruction,
                &[
                    ctx.accounts.treasury.to_account_info(),
                    ctx.accounts.delegator.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[signer_seeds],
            )?;
        }

        user_claim.user = claimant;
        user_claim.pool = ctx.accounts.pool.key();
        user_claim.claimed_amount = cumulative_earned;
        user_claim.bump = ctx.bumps.user_claim;

        ctx.accounts.pool.total_claimed = new_total_claimed;
        if ctx.accounts.pool.total_deposited < onchain_total_received {
            ctx.accounts.pool.total_deposited = onchain_total_received;
        }

        emit!(RewardsClaimed {
            pool: ctx.accounts.pool.key(),
            token_mint: ctx.accounts.pool.token_mint,
            user: claimant,
            claimable,
            cumulative_earned,
            observed_total_deposits,
            total_claimed: ctx.accounts.pool.total_claimed,
        });

        Ok(())
    }

    pub fn delegated_claim_to_tokens(
        ctx: Context<DelegatedClaimToTokens>,
        claimant: Pubkey,
        cumulative_earned: u64,
        observed_total_deposits: u64,
        expires_at: i64,
        min_base_amount_out: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp <= expires_at,
            FairfunRewardsError::SignatureExpired
        );
        require!(ctx.accounts.pool.active, FairfunRewardsError::PoolInactive);
        require_keys_neq!(
            ctx.accounts.delegator.key(),
            claimant,
            FairfunRewardsError::InvalidDelegatedClaimTarget
        );
        initialize_delegation_settings_if_empty(
            &mut ctx.accounts.claimant_settings,
            claimant,
            ctx.accounts.pool.key(),
            ctx.bumps.claimant_settings,
        );
        require!(
            ctx.accounts.claimant_settings.delegated_claims_enabled,
            FairfunRewardsError::DelegatedClaimsDisabled
        );

        let instruction_index = load_current_index_checked(&ctx.accounts.instructions)?;
        require!(
            instruction_index > 0,
            FairfunRewardsError::MissingSignatureInstruction
        );
        let signature_instruction =
            load_instruction_at_checked((instruction_index - 1) as usize, &ctx.accounts.instructions)?;

        let expected_message = build_claim_message(
            &claimant,
            &ctx.accounts.pool.key(),
            cumulative_earned,
            observed_total_deposits,
            expires_at,
        );
        verify_ed25519_ix_integrity(
            &signature_instruction,
            &ctx.accounts.config.backend_authority.to_bytes(),
            &expected_message,
        )?;

        require_keys_eq!(
            ctx.accounts.pump_amm_program.key(),
            PUMP_AMM_PROGRAM_ID,
            FairfunRewardsError::InvalidProgramId
        );
        require_keys_eq!(
            ctx.accounts.pump_fee_program.key(),
            PUMP_FEE_PROGRAM_ID,
            FairfunRewardsError::InvalidProgramId
        );
        require_keys_eq!(
            ctx.accounts.associated_token_program.key(),
            ASSOCIATED_TOKEN_PROGRAM_ID,
            FairfunRewardsError::InvalidProgramId
        );
        require_keys_eq!(
            ctx.accounts.pump_quote_mint.key(),
            NATIVE_MINT_ID,
            FairfunRewardsError::InvalidMessageContent
        );
        require_keys_eq!(
            ctx.accounts.pump_base_mint.key(),
            ctx.accounts.pool.token_mint,
            FairfunRewardsError::InvalidMessageContent
        );
        require_keys_eq!(
            ctx.accounts.pump_amm_global_config.key(),
            pump_amm_global_config_pda(),
            FairfunRewardsError::InvalidMessageContent
        );
        require_keys_eq!(
            ctx.accounts.pump_amm_event_authority.key(),
            pump_amm_event_authority_pda(),
            FairfunRewardsError::InvalidMessageContent
        );
        require_keys_eq!(
            ctx.accounts.pump_global_volume_accumulator.key(),
            pump_amm_global_volume_accumulator_pda(),
            FairfunRewardsError::InvalidMessageContent
        );
        require_keys_eq!(
            ctx.accounts.pump_user_volume_accumulator.key(),
            pump_amm_user_volume_accumulator_pda(&ctx.accounts.treasury.key()),
            FairfunRewardsError::InvalidMessageContent
        );
        require_keys_eq!(
            ctx.accounts.pump_fee_config.key(),
            pump_amm_fee_config_pda(),
            FairfunRewardsError::InvalidMessageContent
        );
        require_keys_eq!(
            ctx.accounts.pump_coin_creator_vault_authority.key(),
            pump_amm_coin_creator_vault_authority_pda(ctx.accounts.pump_coin_creator.key),
            FairfunRewardsError::InvalidMessageContent
        );
        require_keys_eq!(
            ctx.accounts.pump_pool_v2.key(),
            pump_amm_pool_v2_pda(&ctx.accounts.pool.token_mint),
            FairfunRewardsError::InvalidMessageContent
        );
        require_keys_eq!(
            ctx.accounts.treasury_wsol_account.key(),
            get_associated_token_address_with_program_id(
                &ctx.accounts.treasury.key(),
                &NATIVE_MINT_ID,
                &spl_token::id(),
            ),
            FairfunRewardsError::InvalidMessageContent
        );
        require_keys_eq!(
            ctx.accounts.treasury_token_account.key(),
            get_associated_token_address_with_program_id(
                &ctx.accounts.treasury.key(),
                &ctx.accounts.pool.token_mint,
                &spl_token_2022::id(),
            ),
            FairfunRewardsError::InvalidMessageContent
        );
        require_keys_eq!(
            ctx.accounts.claimant_token_account.key(),
            get_associated_token_address_with_program_id(
                &claimant,
                &ctx.accounts.pool.token_mint,
                &spl_token_2022::id(),
            ),
            FairfunRewardsError::InvalidMessageContent
        );
        require_keys_eq!(
            ctx.accounts.delegator_token_account.key(),
            get_associated_token_address_with_program_id(
                &ctx.accounts.delegator.key(),
                &ctx.accounts.pool.token_mint,
                &spl_token_2022::id(),
            ),
            FairfunRewardsError::InvalidMessageContent
        );

        let onchain_total_received = ctx
            .accounts
            .treasury
            .lamports()
            .checked_add(ctx.accounts.pool.total_claimed)
            .unwrap();

        let user_claim = &mut ctx.accounts.user_claim;
        let claimable = calculate_claimable(
            user_claim.claimed_amount,
            cumulative_earned,
            observed_total_deposits,
            onchain_total_received,
            ctx.accounts.pool.total_claimed,
        )?;
        let new_total_claimed = ctx.accounts.pool.total_claimed.checked_add(claimable).unwrap();
        require!(
            ctx.accounts.treasury.lamports() >= claimable,
            FairfunRewardsError::InsufficientTreasury
        );

        create_ata_if_needed(
            &ctx.accounts.delegator.to_account_info(),
            &ctx.accounts.treasury_wsol_account.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            &ctx.accounts.pump_quote_mint.to_account_info(),
            &ctx.accounts.pump_quote_token_program.to_account_info(),
            &ctx.accounts.associated_token_program.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
        )?;
        create_ata_if_needed(
            &ctx.accounts.delegator.to_account_info(),
            &ctx.accounts.treasury_token_account.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            &ctx.accounts.pump_base_mint.to_account_info(),
            &ctx.accounts.pump_base_token_program.to_account_info(),
            &ctx.accounts.associated_token_program.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
        )?;
        create_ata_if_needed(
            &ctx.accounts.delegator.to_account_info(),
            &ctx.accounts.claimant_token_account.to_account_info(),
            &ctx.accounts.claimant.to_account_info(),
            &ctx.accounts.pump_base_mint.to_account_info(),
            &ctx.accounts.pump_base_token_program.to_account_info(),
            &ctx.accounts.associated_token_program.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
        )?;
        create_ata_if_needed(
            &ctx.accounts.delegator.to_account_info(),
            &ctx.accounts.delegator_token_account.to_account_info(),
            &ctx.accounts.delegator.to_account_info(),
            &ctx.accounts.pump_base_mint.to_account_info(),
            &ctx.accounts.pump_base_token_program.to_account_info(),
            &ctx.accounts.associated_token_program.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
        )?;

        let treasury_bump = ctx.accounts.pool.treasury_bump;
        let token_mint = ctx.accounts.pool.token_mint;
        let signer_seeds: &[&[u8]] = &[b"rewards_treasury", token_mint.as_ref(), &[treasury_bump]];

        let treasury_token_balance_before = read_token_2022_amount(&ctx.accounts.treasury_token_account.to_account_info())?;
        let wrap_transfer_instruction = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.treasury.key(),
            &ctx.accounts.treasury_wsol_account.key(),
            claimable,
        );
        invoke_signed(
            &wrap_transfer_instruction,
            &[
                ctx.accounts.treasury.to_account_info(),
                ctx.accounts.treasury_wsol_account.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[signer_seeds],
        )?;

        invoke_sync_native(
            &ctx.accounts.pump_quote_token_program.to_account_info(),
            &ctx.accounts.treasury_wsol_account.to_account_info(),
        )?;

        invoke_pump_amm_buy(
            PumpAmmBuyAccounts {
                pool: ctx.accounts.pump_pool.to_account_info(),
                user: ctx.accounts.treasury.to_account_info(),
                global_config: ctx.accounts.pump_amm_global_config.to_account_info(),
                base_mint: ctx.accounts.pump_base_mint.to_account_info(),
                quote_mint: ctx.accounts.pump_quote_mint.to_account_info(),
                user_base_token_account: ctx.accounts.treasury_token_account.to_account_info(),
                user_quote_token_account: ctx.accounts.treasury_wsol_account.to_account_info(),
                pool_base_token_account: ctx.accounts.pump_pool_base_token_account.to_account_info(),
                pool_quote_token_account: ctx.accounts.pump_pool_quote_token_account.to_account_info(),
                protocol_fee_recipient: ctx.accounts.pump_protocol_fee_recipient.to_account_info(),
                protocol_fee_recipient_token_account: ctx.accounts.pump_protocol_fee_recipient_token_account.to_account_info(),
                base_token_program: ctx.accounts.pump_base_token_program.to_account_info(),
                quote_token_program: ctx.accounts.pump_quote_token_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
                event_authority: ctx.accounts.pump_amm_event_authority.to_account_info(),
                amm_program: ctx.accounts.pump_amm_program.to_account_info(),
                coin_creator_vault_ata: ctx.accounts.pump_coin_creator_vault_ata.to_account_info(),
                coin_creator_vault_authority: ctx.accounts.pump_coin_creator_vault_authority.to_account_info(),
                global_volume_accumulator: ctx.accounts.pump_global_volume_accumulator.to_account_info(),
                user_volume_accumulator: ctx.accounts.pump_user_volume_accumulator.to_account_info(),
                fee_config: ctx.accounts.pump_fee_config.to_account_info(),
                fee_program: ctx.accounts.pump_fee_program.to_account_info(),
                pool_v2: ctx.accounts.pump_pool_v2.to_account_info(),
                buyback_fee_recipient: ctx.accounts.pump_buyback_fee_recipient.to_account_info(),
                buyback_fee_recipient_token_account: ctx.accounts.pump_buyback_fee_recipient_token_account.to_account_info(),
            },
            min_base_amount_out,
            claimable,
            &[signer_seeds],
        )?;

        let treasury_token_balance_after = read_token_2022_amount(&ctx.accounts.treasury_token_account.to_account_info())?;
        let purchased_amount = treasury_token_balance_after
            .checked_sub(treasury_token_balance_before)
            .unwrap();
        require!(purchased_amount > 0, FairfunRewardsError::NothingToClaim);
        let (claimant_token_amount, delegator_token_fee) = calculate_delegated_claim_split(purchased_amount);
        let token_decimals = read_token_2022_decimals(&ctx.accounts.pump_base_mint.to_account_info())?;

        invoke_transfer_checked(
            &ctx.accounts.pump_base_token_program.to_account_info(),
            &ctx.accounts.treasury_token_account.to_account_info(),
            &ctx.accounts.pump_base_mint.to_account_info(),
            &ctx.accounts.claimant_token_account.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            claimant_token_amount,
            token_decimals,
            &[signer_seeds],
        )?;

        if delegator_token_fee > 0 {
            invoke_transfer_checked(
                &ctx.accounts.pump_base_token_program.to_account_info(),
                &ctx.accounts.treasury_token_account.to_account_info(),
                &ctx.accounts.pump_base_mint.to_account_info(),
                &ctx.accounts.delegator_token_account.to_account_info(),
                &ctx.accounts.treasury.to_account_info(),
                delegator_token_fee,
                token_decimals,
                &[signer_seeds],
            )?;
        }

        invoke_close_account(
            &ctx.accounts.pump_quote_token_program.to_account_info(),
            &ctx.accounts.treasury_wsol_account.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            &[signer_seeds],
        )?;

        user_claim.user = claimant;
        user_claim.pool = ctx.accounts.pool.key();
        user_claim.claimed_amount = cumulative_earned;
        user_claim.bump = ctx.bumps.user_claim;

        ctx.accounts.pool.total_claimed = new_total_claimed;
        if ctx.accounts.pool.total_deposited < onchain_total_received {
            ctx.accounts.pool.total_deposited = onchain_total_received;
        }

        emit!(RewardsClaimed {
            pool: ctx.accounts.pool.key(),
            token_mint: ctx.accounts.pool.token_mint,
            user: claimant,
            claimable,
            cumulative_earned,
            observed_total_deposits,
            total_claimed: ctx.accounts.pool.total_claimed,
        });

        Ok(())
    }
}

fn build_claim_message(
    user: &Pubkey,
    pool: &Pubkey,
    cumulative_earned: u64,
    observed_total_deposits: u64,
    expires_at: i64,
) -> Vec<u8> {
    let mut message = Vec::with_capacity(88);
    message.extend_from_slice(user.as_ref());
    message.extend_from_slice(pool.as_ref());
    message.extend_from_slice(&cumulative_earned.to_le_bytes());
    message.extend_from_slice(&observed_total_deposits.to_le_bytes());
    message.extend_from_slice(&expires_at.to_le_bytes());
    message
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = GlobalConfig::DISCRIMINATOR.len() + GlobalConfig::INIT_SPACE,
        seeds = [b"rewards_config"],
        bump,
    )]
    pub config: Account<'info, GlobalConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(token_mint: Pubkey)]
pub struct RegisterPool<'info> {
    #[account(
        mut,
        constraint = admin.key() == config.admin @ FairfunRewardsError::NotAdmin,
    )]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"rewards_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        init,
        payer = admin,
        space = RewardPool::DISCRIMINATOR.len() + RewardPool::INIT_SPACE,
        seeds = [b"rewards_pool", token_mint.as_ref()],
        bump,
    )]
    pub pool: Account<'info, RewardPool>,

    #[account(
        init,
        payer = admin,
        space = 0,
        owner = system_program::ID,
        seeds = [b"rewards_treasury", token_mint.as_ref()],
        bump,
    )]
    /// CHECK: zero-data system-owned SOL treasury PDA
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        seeds = [b"rewards_pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, RewardPool>,

    #[account(
        mut,
        seeds = [b"rewards_treasury", pool.token_mint.as_ref()],
        bump = pool.treasury_bump,
    )]
    /// CHECK: zero-data system-owned SOL treasury PDA
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = UserClaim::DISCRIMINATOR.len() + UserClaim::INIT_SPACE,
        seeds = [b"rewards_user_claim", pool.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub user_claim: Account<'info, UserClaim>,

    #[account(
        seeds = [b"rewards_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [b"rewards_pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, RewardPool>,

    #[account(
        mut,
        seeds = [b"rewards_treasury", pool.token_mint.as_ref()],
        bump = pool.treasury_bump,
    )]
    /// CHECK: zero-data system-owned SOL treasury PDA
    pub treasury: UncheckedAccount<'info>,

    #[account(address = INSTRUCTIONS_ID)]
    /// CHECK: instructions sysvar is validated by address
    pub instructions: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    #[account(
        mut,
        constraint = admin.key() == config.admin @ FairfunRewardsError::NotAdmin,
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"rewards_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, GlobalConfig>,
}

#[derive(Accounts)]
pub struct SetPoolActive<'info> {
    #[account(
        constraint = admin.key() == config.admin @ FairfunRewardsError::NotAdmin,
    )]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"rewards_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [b"rewards_pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, RewardPool>,
}

#[derive(Accounts)]
pub struct SetDelegatedClaimsEnabled<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"rewards_pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, RewardPool>,

    #[account(
        init_if_needed,
        payer = user,
        space = UserDelegationSettings::DISCRIMINATOR.len() + UserDelegationSettings::INIT_SPACE,
        seeds = [b"rewards_user_delegation_settings", pool.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub settings: Account<'info, UserDelegationSettings>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(claimant: Pubkey)]
pub struct DelegatedClaim<'info> {
    #[account(mut)]
    pub delegator: Signer<'info>,

    #[account(
        init_if_needed,
        payer = delegator,
        space = UserClaim::DISCRIMINATOR.len() + UserClaim::INIT_SPACE,
        seeds = [b"rewards_user_claim", pool.key().as_ref(), claimant.key().as_ref()],
        bump,
    )]
    pub user_claim: Account<'info, UserClaim>,

    #[account(
        init_if_needed,
        payer = delegator,
        space = UserDelegationSettings::DISCRIMINATOR.len() + UserDelegationSettings::INIT_SPACE,
        seeds = [b"rewards_user_delegation_settings", pool.key().as_ref(), claimant.key().as_ref()],
        bump,
    )]
    pub claimant_settings: Account<'info, UserDelegationSettings>,

    #[account(
        seeds = [b"rewards_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [b"rewards_pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, RewardPool>,

    #[account(
        mut,
        seeds = [b"rewards_treasury", pool.token_mint.as_ref()],
        bump = pool.treasury_bump,
    )]
    /// CHECK: zero-data system-owned SOL treasury PDA
    pub treasury: UncheckedAccount<'info>,

    #[account(address = INSTRUCTIONS_ID)]
    /// CHECK: instructions sysvar is validated by address
    pub instructions: UncheckedAccount<'info>,

    /// CHECK: the claimant receiving rewards
    #[account(mut)]
    pub claimant: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(claimant: Pubkey)]
pub struct DelegatedClaimToTokens<'info> {
    #[account(mut)]
    pub delegator: Signer<'info>,

    #[account(
        init_if_needed,
        payer = delegator,
        space = UserClaim::DISCRIMINATOR.len() + UserClaim::INIT_SPACE,
        seeds = [b"rewards_user_claim", pool.key().as_ref(), claimant.key().as_ref()],
        bump,
    )]
    pub user_claim: Account<'info, UserClaim>,

    #[account(
        init_if_needed,
        payer = delegator,
        space = UserDelegationSettings::DISCRIMINATOR.len() + UserDelegationSettings::INIT_SPACE,
        seeds = [b"rewards_user_delegation_settings", pool.key().as_ref(), claimant.key().as_ref()],
        bump,
    )]
    pub claimant_settings: Account<'info, UserDelegationSettings>,

    #[account(
        seeds = [b"rewards_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [b"rewards_pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, RewardPool>,

    #[account(
        mut,
        seeds = [b"rewards_treasury", pool.token_mint.as_ref()],
        bump = pool.treasury_bump,
    )]
    /// CHECK: zero-data system-owned SOL treasury PDA
    pub treasury: UncheckedAccount<'info>,

    #[account(address = INSTRUCTIONS_ID)]
    /// CHECK: instructions sysvar is validated by address
    pub instructions: UncheckedAccount<'info>,

    /// CHECK: the claimant receiving rewards
    #[account(mut)]
    pub claimant: UncheckedAccount<'info>,

    /// CHECK: Pump AMM program
    pub pump_amm_program: UncheckedAccount<'info>,
    /// CHECK: Pump AMM global config PDA
    pub pump_amm_global_config: UncheckedAccount<'info>,
    /// CHECK: FAIRFUN token mint
    pub pump_base_mint: UncheckedAccount<'info>,
    /// CHECK: WSOL mint
    pub pump_quote_mint: UncheckedAccount<'info>,
    /// CHECK: Pump AMM pool
    #[account(mut)]
    pub pump_pool: UncheckedAccount<'info>,
    /// CHECK: treasury-owned FAIRFUN ATA
    #[account(mut)]
    pub treasury_token_account: UncheckedAccount<'info>,
    /// CHECK: treasury-owned WSOL ATA
    #[account(mut)]
    pub treasury_wsol_account: UncheckedAccount<'info>,
    /// CHECK: Pump pool FAIRFUN vault
    #[account(mut)]
    pub pump_pool_base_token_account: UncheckedAccount<'info>,
    /// CHECK: Pump pool WSOL vault
    #[account(mut)]
    pub pump_pool_quote_token_account: UncheckedAccount<'info>,
    /// CHECK: protocol fee recipient
    pub pump_protocol_fee_recipient: UncheckedAccount<'info>,
    /// CHECK: protocol fee recipient token account
    #[account(mut)]
    pub pump_protocol_fee_recipient_token_account: UncheckedAccount<'info>,
    /// CHECK: Token-2022 program
    pub pump_base_token_program: UncheckedAccount<'info>,
    /// CHECK: SPL Token program
    pub pump_quote_token_program: UncheckedAccount<'info>,
    /// CHECK: associated token program
    pub associated_token_program: UncheckedAccount<'info>,
    /// CHECK: Pump AMM event authority PDA
    pub pump_amm_event_authority: UncheckedAccount<'info>,
    /// CHECK: coin creator vault ATA
    #[account(mut)]
    pub pump_coin_creator_vault_ata: UncheckedAccount<'info>,
    /// CHECK: coin creator vault authority PDA
    pub pump_coin_creator_vault_authority: UncheckedAccount<'info>,
    /// CHECK: coin creator account for PDA derivation
    pub pump_coin_creator: UncheckedAccount<'info>,
    /// CHECK: Pump AMM global volume accumulator PDA
    pub pump_global_volume_accumulator: UncheckedAccount<'info>,
    /// CHECK: Pump AMM treasury user volume accumulator PDA
    #[account(mut)]
    pub pump_user_volume_accumulator: UncheckedAccount<'info>,
    /// CHECK: Pump fee config PDA
    pub pump_fee_config: UncheckedAccount<'info>,
    /// CHECK: Pump fee program
    pub pump_fee_program: UncheckedAccount<'info>,
    /// CHECK: Pump pool-v2 PDA for creator coins
    pub pump_pool_v2: UncheckedAccount<'info>,
    /// CHECK: buyback fee recipient
    pub pump_buyback_fee_recipient: UncheckedAccount<'info>,
    /// CHECK: buyback fee recipient token account
    #[account(mut)]
    pub pump_buyback_fee_recipient_token_account: UncheckedAccount<'info>,
    /// CHECK: claimant FAIRFUN ATA
    #[account(mut)]
    pub claimant_token_account: UncheckedAccount<'info>,
    /// CHECK: delegator FAIRFUN ATA
    #[account(mut)]
    pub delegator_token_account: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[event]
pub struct TreasuryDeposited {
    pub pool: Pubkey,
    pub token_mint: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub total_deposited: u64,
}

#[event]
pub struct RewardsClaimed {
    pub pool: Pubkey,
    pub token_mint: Pubkey,
    pub user: Pubkey,
    pub claimable: u64,
    pub cumulative_earned: u64,
    pub observed_total_deposits: u64,
    pub total_claimed: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_ed25519_program::new_ed25519_instruction_with_signature;
    use solana_keypair::Keypair;
    use solana_signer::Signer;

    #[test]
    fn calculate_claimable_returns_delta() {
        let claimable = calculate_claimable(100, 250, 500, 500, 100).unwrap();
        assert_eq!(claimable, 150);
    }

    #[test]
    fn calculate_claimable_rejects_decrease() {
        let result = calculate_claimable(300, 200, 500, 500, 300);
        assert!(result.is_err());
    }

    #[test]
    fn calculate_claimable_rejects_snapshot_above_pool() {
        let result = calculate_claimable(100, 250, 600, 500, 100);
        assert!(result.is_err());
    }

    #[test]
    fn delegated_claim_split_keeps_ten_percent_fee() {
        let (claimant_amount, delegator_fee) = calculate_delegated_claim_split(1_000);
        assert_eq!(claimant_amount, 900);
        assert_eq!(delegator_fee, 100);
    }

    #[test]
    fn claim_message_matches_ed25519_instruction_payload() {
        let backend = Keypair::new();
        let user = Pubkey::new_unique();
        let pool = Pubkey::new_unique();
        let message = build_claim_message(&user, &pool, 250, 500, i64::MAX);
        let signature = backend.sign_message(&message);
        let backend_pubkey_bytes = backend.pubkey().to_bytes();
        let instruction = new_ed25519_instruction_with_signature(
            &message,
            signature.as_array(),
            &backend_pubkey_bytes,
        );

        verify_ed25519_ix_integrity(
            &instruction,
            &backend.pubkey().to_bytes(),
            &message,
        )
        .unwrap();
    }
}
