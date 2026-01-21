use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_spl::token::{self, Burn, Token, TokenAccount, Mint};

declare_id!("3M12BfitAEYz14WJBMnjahEuSvhsWhjfGJXbzur26o2U");

/// Galaxy Wheel Program
/// Users burn stardust tokens for a chance to win SOL from treasury
/// Rewards are % of treasury, dynamic tier count (1-10)
/// Probabilities must sum to 100%

pub const MAX_TIERS: usize = 10;

#[program]
pub mod galaxy_wheel {
    use super::*;

    /// Initialize the wheel with configuration
    pub fn initialize(
        ctx: Context<Initialize>,
        cost_per_spin: u64,
        num_tiers: u8,
        probabilities: [u16; MAX_TIERS],
        reward_bps: [u16; MAX_TIERS],
    ) -> Result<()> {
        require!(num_tiers >= 1 && num_tiers <= 10, WheelError::InvalidTierCount);
        
        let state = &mut ctx.accounts.state;
        
        // Validate probabilities sum to 10000 (100%)
        let total_prob: u16 = probabilities[..num_tiers as usize].iter().sum();
        require!(total_prob == 10000, WheelError::InvalidProbabilities);
        
        state.authority = ctx.accounts.authority.key();
        state.stardust_mint = ctx.accounts.stardust_mint.key();
        state.cost_per_spin = cost_per_spin;
        state.num_tiers = num_tiers;
        state.probabilities = probabilities;
        state.reward_bps = reward_bps;
        state.total_spins = 0;
        state.total_distributed = 0;
        state.bump = ctx.bumps.state;
        state.pool_bump = ctx.bumps.pool;
        
        msg!("Galaxy Wheel initialized with {} tiers", num_tiers);
        Ok(())
    }

    /// Fund the treasury pool with SOL
    pub fn fund_pool(ctx: Context<FundPool>, amount: u64) -> Result<()> {
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.funder.key(),
            &ctx.accounts.pool.key(),
            amount,
        );
        
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.funder.to_account_info(),
                ctx.accounts.pool.to_account_info(),
            ],
        )?;
        
        msg!("Treasury funded with {} lamports", amount);
        Ok(())
    }

    /// Spin the wheel - burn stardust for a chance to win SOL
    pub fn spin(ctx: Context<Spin>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let clock = Clock::get()?;
        let num_tiers = state.num_tiers as usize;
        
        // Get treasury balance before spin
        let treasury_balance = ctx.accounts.pool.lamports();
        
        // Generate pseudo-random number
        let seed_data = [
            ctx.accounts.user.key().as_ref(),
            &clock.slot.to_le_bytes(),
            &clock.unix_timestamp.to_le_bytes(),
            &state.total_spins.to_le_bytes(),
        ].concat();
        
        let hash_result = hash(&seed_data);
        let random_value = u16::from_le_bytes([hash_result.as_ref()[0], hash_result.as_ref()[1]]) % 10000;
        
        // Determine reward tier based on probabilities
        let mut cumulative: u16 = 0;
        let mut reward_tier: u8 = 0;
        
        for i in 0..num_tiers {
            cumulative += state.probabilities[i];
            if random_value < cumulative {
                reward_tier = i as u8;
                break;
            }
        }
        
        // Calculate reward as % of treasury
        let reward_bps = state.reward_bps[reward_tier as usize] as u64;
        let reward_amount = (treasury_balance * reward_bps) / 10000;
        
        // Burn stardust from user
        let cpi_accounts = Burn {
            mint: ctx.accounts.stardust_mint.to_account_info(),
            from: ctx.accounts.user_stardust.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        
        token::burn(cpi_ctx, state.cost_per_spin)?;
        
        // Transfer SOL reward from pool to user
        if reward_amount > 0 {
            require!(treasury_balance >= reward_amount, WheelError::InsufficientTreasury);
            
            **ctx.accounts.pool.try_borrow_mut_lamports()? -= reward_amount;
            **ctx.accounts.user.try_borrow_mut_lamports()? += reward_amount;
        }
        
        // Update state
        state.total_spins += 1;
        state.total_distributed += reward_amount;
        
        // Update user spin history
        let user_history = &mut ctx.accounts.user_history;
        if user_history.user == Pubkey::default() {
            user_history.user = ctx.accounts.user.key();
        }
        user_history.total_spins += 1;
        user_history.total_won += reward_amount;
        user_history.last_spin_tier = reward_tier;
        user_history.last_spin_amount = reward_amount;
        user_history.last_spin_timestamp = clock.unix_timestamp;
        
        // Emit result event
        emit!(SpinResult {
            user: ctx.accounts.user.key(),
            tier: reward_tier,
            reward_amount,
            reward_bps: reward_bps as u16,
            treasury_balance,
            timestamp: clock.unix_timestamp,
        });
        
        msg!("Spin #{}: Tier {} - Won {} lamports", state.total_spins, reward_tier, reward_amount);
        Ok(())
    }

    /// Admin: Update spin cost only
    pub fn set_spin_cost(ctx: Context<UpdateConfig>, cost_per_spin: u64) -> Result<()> {
        ctx.accounts.state.cost_per_spin = cost_per_spin;
        msg!("Spin cost updated to {}", cost_per_spin);
        Ok(())
    }

    /// Admin: Update probabilities and reward percentages
    pub fn set_probabilities(
        ctx: Context<UpdateConfig>,
        num_tiers: u8,
        probabilities: [u16; MAX_TIERS],
        reward_bps: [u16; MAX_TIERS],
    ) -> Result<()> {
        require!(num_tiers >= 1 && num_tiers <= 10, WheelError::InvalidTierCount);
        
        let total_prob: u16 = probabilities[..num_tiers as usize].iter().sum();
        require!(total_prob == 10000, WheelError::InvalidProbabilities);
        
        let state = &mut ctx.accounts.state;
        state.num_tiers = num_tiers;
        state.probabilities = probabilities;
        state.reward_bps = reward_bps;
        
        msg!("Config updated - {} tiers", num_tiers);
        Ok(())
    }
}

// ============================================
// ACCOUNTS
// ============================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + WheelState::LEN,
        seeds = [b"wheel_state"],
        bump
    )]
    pub state: Account<'info, WheelState>,
    
    /// CHECK: SOL treasury pool PDA
    #[account(
        mut,
        seeds = [b"wheel_pool"],
        bump
    )]
    pub pool: AccountInfo<'info>,
    
    pub stardust_mint: Account<'info, Mint>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundPool<'info> {
    /// CHECK: SOL treasury pool PDA
    #[account(
        mut,
        seeds = [b"wheel_pool"],
        bump
    )]
    pub pool: AccountInfo<'info>,
    
    #[account(mut)]
    pub funder: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Spin<'info> {
    #[account(
        mut,
        seeds = [b"wheel_state"],
        bump = state.bump
    )]
    pub state: Account<'info, WheelState>,
    
    /// CHECK: SOL treasury pool PDA
    #[account(
        mut,
        seeds = [b"wheel_pool"],
        bump = state.pool_bump
    )]
    pub pool: AccountInfo<'info>,
    
    #[account(mut)]
    pub stardust_mint: Account<'info, Mint>,
    
    #[account(
        mut,
        constraint = user_stardust.mint == state.stardust_mint,
        constraint = user_stardust.owner == user.key()
    )]
    pub user_stardust: Account<'info, TokenAccount>,
    
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserSpinHistory::LEN,
        seeds = [b"user_history", user.key().as_ref()],
        bump
    )]
    pub user_history: Account<'info, UserSpinHistory>,
    
    #[account(mut)]
    pub user: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [b"wheel_state"],
        bump = state.bump,
        constraint = state.authority == authority.key() @ WheelError::Unauthorized
    )]
    pub state: Account<'info, WheelState>,
    
    pub authority: Signer<'info>,
}

// ============================================
// STATE
// ============================================

#[account]
pub struct WheelState {
    pub authority: Pubkey,          // 32
    pub stardust_mint: Pubkey,      // 32
    pub cost_per_spin: u64,         // 8
    pub num_tiers: u8,              // 1
    pub probabilities: [u16; MAX_TIERS],  // 20 (10 x 2)
    pub reward_bps: [u16; MAX_TIERS],     // 20 (10 x 2)
    pub total_spins: u64,           // 8
    pub total_distributed: u64,     // 8
    pub bump: u8,                   // 1
    pub pool_bump: u8,              // 1
}

impl WheelState {
    pub const LEN: usize = 32 + 32 + 8 + 1 + 20 + 20 + 8 + 8 + 1 + 1; // 131
}

#[account]
pub struct UserSpinHistory {
    pub user: Pubkey,               // 32
    pub total_spins: u64,           // 8
    pub total_won: u64,             // 8
    pub last_spin_tier: u8,         // 1
    pub last_spin_amount: u64,      // 8
    pub last_spin_timestamp: i64,   // 8
}

impl UserSpinHistory {
    pub const LEN: usize = 32 + 8 + 8 + 1 + 8 + 8; // 65
}

// ============================================
// EVENTS
// ============================================

#[event]
pub struct SpinResult {
    pub user: Pubkey,
    pub tier: u8,
    pub reward_amount: u64,
    pub reward_bps: u16,
    pub treasury_balance: u64,
    pub timestamp: i64,
}

// ============================================
// ERRORS
// ============================================

#[error_code]
pub enum WheelError {
    #[msg("Probabilities must sum to 10000 (100%)")]
    InvalidProbabilities,
    
    #[msg("Number of tiers must be between 1 and 10")]
    InvalidTierCount,
    
    #[msg("Insufficient balance in treasury")]
    InsufficientTreasury,
    
    #[msg("Insufficient stardust balance")]
    InsufficientStardust,
    
    #[msg("Unauthorized - only authority can perform this action")]
    Unauthorized,
}
