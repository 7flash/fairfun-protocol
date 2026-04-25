use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{
        self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
    },
};

declare_id!("HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A");

#[program]
pub mod anchor_fairfun {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= 1000, FairFunError::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.fee_bps = fee_bps;
        config.paused = false;
        config.total_deals = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn create_deal(
        ctx: Context<CreateDeal>,
        deal_id: u64,
        amount: u64,
        timeout_seconds: i64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, FairFunError::ProtocolPaused);
        require!(amount > 0, FairFunError::ZeroAmount);
        require!(timeout_seconds >= 3600, FairFunError::TimeoutTooShort);

        let clock = Clock::get()?;
        let deal = &mut ctx.accounts.deal;
        deal.deal_id = deal_id;
        deal.creator = ctx.accounts.creator.key();
        deal.recipient = ctx.accounts.recipient.key();
        deal.oracle = ctx.accounts.oracle.key();
        deal.refund_address = ctx.accounts.refund_address.key();
        deal.token_mint = ctx.accounts.token_mint.key();
        deal.amount = amount;
        deal.status = DealStatus::Created;
        deal.created_at = clock.unix_timestamp;
        deal.funded_at = 0;
        deal.deadline = 0;
        deal.timeout_seconds = timeout_seconds;
        deal.bump = ctx.bumps.deal;
        deal.vault_bump = ctx.bumps.vault;

        let config_mut = &mut ctx.accounts.config;
        config_mut.total_deals += 1;

        emit!(DealCreated {
            deal_id,
            creator: deal.creator,
            recipient: deal.recipient,
            oracle: deal.oracle,
            refund_address: deal.refund_address,
            amount,
            token_mint: deal.token_mint,
            timeout_seconds,
            vault: ctx.accounts.vault.key(),
        });

        Ok(())
    }

    pub fn activate(ctx: Context<Activate>) -> Result<()> {
        let deal = &mut ctx.accounts.deal;
        require!(deal.status == DealStatus::Created, FairFunError::InvalidStatus);

        let vault_balance = ctx.accounts.vault.amount;
        require!(
            vault_balance >= deal.amount,
            FairFunError::InsufficientDeposit
        );

        let clock = Clock::get()?;
        deal.status = DealStatus::Funded;
        deal.funded_at = clock.unix_timestamp;
        deal.deadline = clock.unix_timestamp + deal.timeout_seconds;

        emit!(DealActivated {
            deal_id: deal.deal_id,
            vault_balance,
            deadline: deal.deadline,
        });

        Ok(())
    }

    pub fn confirm(ctx: Context<Confirm>) -> Result<()> {
        let deal = &ctx.accounts.deal;
        require!(deal.status == DealStatus::Funded, FairFunError::InvalidStatus);

        let config = &ctx.accounts.config;
        let vault_balance = ctx.accounts.vault.amount;
        let fee = vault_balance
            .checked_mul(config.fee_bps as u64)
            .unwrap()
            .checked_div(10_000)
            .unwrap();
        let payout = vault_balance.checked_sub(fee).unwrap();

        let deal_id_bytes = deal.deal_id.to_le_bytes();
        let creator_bytes = deal.creator.to_bytes();
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"vault",
            creator_bytes.as_ref(),
            deal_id_bytes.as_ref(),
            &[deal.vault_bump],
        ]];

        if payout > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.recipient_token_account.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.token_mint.to_account_info(),
                    },
                    signer_seeds,
                ),
                payout,
                ctx.accounts.token_mint.decimals,
            )?;
        }

        if fee > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.admin_token_account.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.token_mint.to_account_info(),
                    },
                    signer_seeds,
                ),
                fee,
                ctx.accounts.token_mint.decimals,
            )?;
        }

        token_interface::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.creator.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ))?;

        let deal = &mut ctx.accounts.deal;
        deal.status = DealStatus::Completed;

        emit!(DealCompleted {
            deal_id: deal.deal_id,
            recipient: deal.recipient,
            payout,
            fee,
        });

        Ok(())
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let deal = &ctx.accounts.deal;
        require!(deal.status == DealStatus::Funded, FairFunError::InvalidStatus);

        let clock = Clock::get()?;
        let caller = ctx.accounts.caller.key();
        let is_oracle = caller == deal.oracle;
        let is_expired = clock.unix_timestamp > deal.deadline;
        require!(
            is_oracle || is_expired,
            FairFunError::NotAuthorizedToRefund
        );

        let vault_balance = ctx.accounts.vault.amount;
        let deal_id_bytes = deal.deal_id.to_le_bytes();
        let creator_bytes = deal.creator.to_bytes();
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"vault",
            creator_bytes.as_ref(),
            deal_id_bytes.as_ref(),
            &[deal.vault_bump],
        ]];

        if vault_balance > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.refund_token_account.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.token_mint.to_account_info(),
                    },
                    signer_seeds,
                ),
                vault_balance,
                ctx.accounts.token_mint.decimals,
            )?;
        }

        token_interface::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.creator.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ))?;

        let deal = &mut ctx.accounts.deal;
        deal.status = if is_expired {
            DealStatus::Expired
        } else {
            DealStatus::Refunded
        };

        emit!(DealRefunded {
            deal_id: deal.deal_id,
            refund_address: deal.refund_address,
            amount: vault_balance,
            expired: is_expired,
        });

        Ok(())
    }

    pub fn admin_withdraw(ctx: Context<AdminWithdraw>) -> Result<()> {
        let deal = &ctx.accounts.deal;
        let vault_balance = ctx.accounts.vault.amount;

        let deal_id_bytes = deal.deal_id.to_le_bytes();
        let creator_bytes = deal.creator.to_bytes();
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"vault",
            creator_bytes.as_ref(),
            deal_id_bytes.as_ref(),
            &[deal.vault_bump],
        ]];

        if vault_balance > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.admin_token_account.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.token_mint.to_account_info(),
                    },
                    signer_seeds,
                ),
                vault_balance,
                ctx.accounts.token_mint.decimals,
            )?;
        }

        token_interface::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.admin.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ))?;

        let deal = &mut ctx.accounts.deal;
        deal.status = DealStatus::AdminWithdrawn;

        emit!(AdminWithdrewDeal {
            deal_id: deal.deal_id,
            amount: vault_balance,
        });

        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminAction>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    pub fn set_fee(ctx: Context<AdminAction>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= 1000, FairFunError::FeeTooHigh);
        ctx.accounts.config.fee_bps = fee_bps;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = Config::DISCRIMINATOR.len() + Config::INIT_SPACE,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(deal_id: u64)]
pub struct CreateDeal<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    /// CHECK: recipient wallet chosen by creator
    pub recipient: UncheckedAccount<'info>,

    /// CHECK: oracle wallet chosen by creator
    pub oracle: UncheckedAccount<'info>,

    /// CHECK: refund destination chosen by creator
    pub refund_address: UncheckedAccount<'info>,

    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = creator,
        space = Deal::DISCRIMINATOR.len() + Deal::INIT_SPACE,
        seeds = [b"deal", creator.key().as_ref(), &deal_id.to_le_bytes()],
        bump,
    )]
    pub deal: Account<'info, Deal>,

    #[account(
        init,
        payer = creator,
        seeds = [b"vault", creator.key().as_ref(), &deal_id.to_le_bytes()],
        bump,
        token::mint = token_mint,
        token::authority = vault,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Activate<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(
        mut,
        seeds = [b"deal", deal.creator.as_ref(), &deal.deal_id.to_le_bytes()],
        bump = deal.bump,
    )]
    pub deal: Account<'info, Deal>,

    #[account(
        seeds = [b"vault", deal.creator.as_ref(), &deal.deal_id.to_le_bytes()],
        bump = deal.vault_bump,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct Confirm<'info> {
    #[account(
        mut,
        constraint = oracle.key() == deal.oracle @ FairFunError::NotOracle,
    )]
    pub oracle: Signer<'info>,

    /// CHECK: deal creator receives vault rent
    #[account(mut, constraint = creator.key() == deal.creator)]
    pub creator: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"deal", deal.creator.as_ref(), &deal.deal_id.to_le_bytes()],
        bump = deal.bump,
    )]
    pub deal: Account<'info, Deal>,

    #[account(
        mut,
        seeds = [b"vault", deal.creator.as_ref(), &deal.deal_id.to_le_bytes()],
        bump = deal.vault_bump,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(constraint = token_mint.key() == deal.token_mint @ FairFunError::MintMismatch)]
    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = oracle,
        associated_token::mint = token_mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program,
    )]
    pub recipient_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: must match deal.recipient
    #[account(constraint = recipient.key() == deal.recipient)]
    pub recipient: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = oracle,
        associated_token::mint = token_mint,
        associated_token::authority = admin,
        associated_token::token_program = token_program,
    )]
    pub admin_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: admin from config
    #[account(constraint = admin.key() == config.admin @ FairFunError::NotAdmin)]
    pub admin: UncheckedAccount<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    /// CHECK: deal creator
    #[account(mut, constraint = creator.key() == deal.creator)]
    pub creator: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"deal", deal.creator.as_ref(), &deal.deal_id.to_le_bytes()],
        bump = deal.bump,
    )]
    pub deal: Account<'info, Deal>,

    #[account(
        mut,
        seeds = [b"vault", deal.creator.as_ref(), &deal.deal_id.to_le_bytes()],
        bump = deal.vault_bump,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(constraint = token_mint.key() == deal.token_mint @ FairFunError::MintMismatch)]
    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = token_mint,
        associated_token::authority = refund_owner,
        associated_token::token_program = token_program,
    )]
    pub refund_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: must match deal.refund_address
    #[account(constraint = refund_owner.key() == deal.refund_address)]
    pub refund_owner: UncheckedAccount<'info>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminWithdraw<'info> {
    #[account(
        mut,
        constraint = admin.key() == config.admin @ FairFunError::NotAdmin,
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"deal", deal.creator.as_ref(), &deal.deal_id.to_le_bytes()],
        bump = deal.bump,
    )]
    pub deal: Account<'info, Deal>,

    #[account(
        mut,
        seeds = [b"vault", deal.creator.as_ref(), &deal.deal_id.to_le_bytes()],
        bump = deal.vault_bump,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(constraint = token_mint.key() == deal.token_mint @ FairFunError::MintMismatch)]
    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = admin,
        associated_token::mint = token_mint,
        associated_token::authority = admin,
        associated_token::token_program = token_program,
    )]
    pub admin_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    #[account(
        constraint = admin.key() == config.admin @ FairFunError::NotAdmin,
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub fee_bps: u16,
    pub paused: bool,
    pub total_deals: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Deal {
    pub deal_id: u64,
    pub creator: Pubkey,
    pub recipient: Pubkey,
    pub oracle: Pubkey,
    pub refund_address: Pubkey,
    pub token_mint: Pubkey,
    pub amount: u64,
    pub status: DealStatus,
    pub created_at: i64,
    pub funded_at: i64,
    pub deadline: i64,
    pub timeout_seconds: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum DealStatus {
    Created,
    Funded,
    Completed,
    Refunded,
    Expired,
    AdminWithdrawn,
}

#[event]
pub struct DealCreated {
    pub deal_id: u64,
    pub creator: Pubkey,
    pub recipient: Pubkey,
    pub oracle: Pubkey,
    pub refund_address: Pubkey,
    pub amount: u64,
    pub token_mint: Pubkey,
    pub timeout_seconds: i64,
    pub vault: Pubkey,
}

#[event]
pub struct DealActivated {
    pub deal_id: u64,
    pub vault_balance: u64,
    pub deadline: i64,
}

#[event]
pub struct DealCompleted {
    pub deal_id: u64,
    pub recipient: Pubkey,
    pub payout: u64,
    pub fee: u64,
}

#[event]
pub struct DealRefunded {
    pub deal_id: u64,
    pub refund_address: Pubkey,
    pub amount: u64,
    pub expired: bool,
}

#[event]
pub struct AdminWithdrewDeal {
    pub deal_id: u64,
    pub amount: u64,
}

#[error_code]
pub enum FairFunError {
    #[msg("Protocol is paused")]
    ProtocolPaused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Timeout must be at least 1 hour")]
    TimeoutTooShort,
    #[msg("Invalid deal status for this operation")]
    InvalidStatus,
    #[msg("Vault balance is less than required deal amount")]
    InsufficientDeposit,
    #[msg("Token mint does not match deal")]
    MintMismatch,
    #[msg("Only the oracle can perform this action")]
    NotOracle,
    #[msg("Not authorized to refund (must be oracle or past deadline)")]
    NotAuthorizedToRefund,
    #[msg("Only admin can perform this action")]
    NotAdmin,
    #[msg("Fee basis points too high (max 1000 = 10%)")]
    FeeTooHigh,
}
