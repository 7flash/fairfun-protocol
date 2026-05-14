use anchor_lang::prelude::*;
use solana_instructions_sysvar::{
    load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_ID,
};

mod errors;
mod introspection;
mod state;

use errors::FairfunRewardsError;
use introspection::verify_ed25519_ix_integrity;
pub use state::{GlobalConfig, RewardPool, UserClaim};

declare_id!("6NPfR5MSEuhwhZsXm4FKF4V1ULSvTPDaubYGkKVpVsPS");

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
        require!(
            ctx.accounts.treasury.lamports() >= claimable,
            FairfunRewardsError::InsufficientTreasury
        );

        let treasury_bump = ctx.accounts.pool.treasury_bump;
        let token_mint = ctx.accounts.pool.token_mint;
        let signer_seeds: &[&[u8]] = &[b"rewards_treasury", token_mint.as_ref(), &[treasury_bump]];
        let transfer_instruction = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.treasury.key(),
            &claimant,
            claimable,
        );

        anchor_lang::solana_program::program::invoke_signed(
            &transfer_instruction,
            &[
                ctx.accounts.treasury.to_account_info(),
                ctx.accounts.claimant.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
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
