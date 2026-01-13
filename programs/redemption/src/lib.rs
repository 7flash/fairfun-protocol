use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_spl::token::{self, Burn, Token, TokenAccount, Mint};

declare_id!("GXY4Red3mPt1onXkV1C2A3m5dR7xFdZiP8A9gN7K4bE5");

/// Stardust Redemption Program
/// Allows users to burn stardust tokens for a chance to win SOL rewards
/// Probabilities are configurable by admin

#[program]
pub mod stardust_redemption {
    use super::*;

    /// Initialize the redemption pool with SOL rewards
    pub fn initialize(
        ctx: Context<Initialize>,
        cost_per_spin: u64,   // Stardust cost per spin (in token units)
        probabilities: [u16; 5], // Probabilities out of 10000 (basis points)
        rewards: [u64; 5],    // SOL rewards in lamports for each tier
    ) -> Result<()> {
        let state = &mut ctx.accounts.state;
        
        state.authority = ctx.accounts.authority.key();
        state.stardust_mint = ctx.accounts.stardust_mint.key();
        state.cost_per_spin = cost_per_spin;
        state.probabilities = probabilities;
        state.rewards = rewards;
        state.total_spins = 0;
        state.total_distributed = 0;
        state.bump = ctx.bumps.state;
        
        // Validate probabilities sum to 10000 (100%)
        let total_prob: u16 = probabilities.iter().sum();
        require!(total_prob == 10000, RedemptionError::InvalidProbabilities);
        
        msg!("Redemption pool initialized");
        msg!("Cost per spin: {} stardust", cost_per_spin);
        msg!("Reward tiers: {:?}", rewards);
        msg!("Probabilities: {:?}", probabilities);
        
        Ok(())
    }

    /// Fund the redemption pool with SOL
    pub fn fund_pool(ctx: Context<FundPool>, amount: u64) -> Result<()> {
        // Transfer SOL from funder to pool PDA
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
        
        msg!("Pool funded with {} lamports", amount);
        Ok(())
    }

    /// Spin the wheel - burn stardust for a chance to win SOL
    pub fn spin(ctx: Context<Spin>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let clock = Clock::get()?;
        
        // Generate pseudo-random number using blockhash and user data
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
        let mut reward_tier: usize = 0;
        
        for (i, &prob) in state.probabilities.iter().enumerate() {
            cumulative += prob;
            if random_value < cumulative {
                reward_tier = i;
                break;
            }
        }
        
        let reward_amount = state.rewards[reward_tier];
        
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
            let pool_lamports = ctx.accounts.pool.lamports();
            require!(pool_lamports >= reward_amount, RedemptionError::InsufficientPoolBalance);
            
            **ctx.accounts.pool.try_borrow_mut_lamports()? -= reward_amount;
            **ctx.accounts.user.try_borrow_mut_lamports()? += reward_amount;
        }
        
        // Update state
        state.total_spins += 1;
        state.total_distributed += reward_amount;
        
        // Emit winner event
        emit!(SpinResult {
            user: ctx.accounts.user.key(),
            reward_tier: reward_tier as u8,
            reward_amount,
            timestamp: clock.unix_timestamp,
        });
        
        msg!("Spin #{}: User {} won {} lamports (tier {})", 
            state.total_spins, 
            ctx.accounts.user.key(),
            reward_amount,
            reward_tier
        );
        
        Ok(())
    }

    /// Admin: Update probabilities and rewards
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        probabilities: [u16; 5],
        rewards: [u64; 5],
    ) -> Result<()> {
        let state = &mut ctx.accounts.state;
        
        // Validate probabilities sum to 10000
        let total_prob: u16 = probabilities.iter().sum();
        require!(total_prob == 10000, RedemptionError::InvalidProbabilities);
        
        state.probabilities = probabilities;
        state.rewards = rewards;
        
        msg!("Config updated - Probabilities: {:?}, Rewards: {:?}", probabilities, rewards);
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
        space = 8 + RedemptionState::INIT_SPACE,
        seeds = [b"redemption_state"],
        bump
    )]
    pub state: Account<'info, RedemptionState>,
    
    #[account(
        seeds = [b"redemption_pool"],
        bump
    )]
    /// CHECK: This is the SOL pool PDA
    pub pool: AccountInfo<'info>,
    
    pub stardust_mint: Account<'info, Mint>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundPool<'info> {
    #[account(
        mut,
        seeds = [b"redemption_pool"],
        bump
    )]
    /// CHECK: This is the SOL pool PDA
    pub pool: AccountInfo<'info>,
    
    #[account(mut)]
    pub funder: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Spin<'info> {
    #[account(
        mut,
        seeds = [b"redemption_state"],
        bump = state.bump
    )]
    pub state: Account<'info, RedemptionState>,
    
    #[account(
        mut,
        seeds = [b"redemption_pool"],
        bump
    )]
    /// CHECK: This is the SOL pool PDA
    pub pool: AccountInfo<'info>,
    
    #[account(mut)]
    pub stardust_mint: Account<'info, Mint>,
    
    #[account(
        mut,
        constraint = user_stardust.mint == state.stardust_mint,
        constraint = user_stardust.owner == user.key()
    )]
    pub user_stardust: Account<'info, TokenAccount>,
    
    #[account(mut)]
    pub user: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [b"redemption_state"],
        bump = state.bump,
        constraint = state.authority == authority.key()
    )]
    pub state: Account<'info, RedemptionState>,
    
    pub authority: Signer<'info>,
}

// ============================================
// STATE
// ============================================

#[account]
#[derive(InitSpace)]
pub struct RedemptionState {
    pub authority: Pubkey,
    pub stardust_mint: Pubkey,
    pub cost_per_spin: u64,
    pub probabilities: [u16; 5],  // Probabilities in basis points (10000 = 100%)
    pub rewards: [u64; 5],        // SOL rewards in lamports
    pub total_spins: u64,
    pub total_distributed: u64,   // Total SOL distributed
    pub bump: u8,
}

// ============================================
// EVENTS
// ============================================

#[event]
pub struct SpinResult {
    pub user: Pubkey,
    pub reward_tier: u8,
    pub reward_amount: u64,
    pub timestamp: i64,
}

// ============================================
// ERRORS
// ============================================

#[error_code]
pub enum RedemptionError {
    #[msg("Probabilities must sum to 10000 (100%)")]
    InvalidProbabilities,
    
    #[msg("Insufficient balance in redemption pool")]
    InsufficientPoolBalance,
    
    #[msg("Insufficient stardust balance")]
    InsufficientStardust,
}
