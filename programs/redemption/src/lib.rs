use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_spl::token::{self, Burn, Token, TokenAccount, Mint};

declare_id!("GXY4Red3mPt1onXkV1C2A3m5dR7xFdZiP8A9gN7K4bE5");

/// Galaxy Wheel Program (formerly Stardust Redemption)
/// Users burn stardust tokens for a chance to win SOL from treasury
/// Rewards are % of treasury, not fixed amounts
/// Probabilities must sum to 100%

#[program]
pub mod galaxy_wheel {
    use super::*;

    /// Initialize the wheel with configuration
    /// probabilities: [nothing, small(1%), medium(10%), jackpot(50%)] in basis points (sum to 10000)
    /// reward_bps: [0, 100, 1000, 5000] = [0%, 1%, 10%, 50%] of treasury
    pub fn initialize(
        ctx: Context<Initialize>,
        cost_per_spin: u64,         // Stardust cost per spin (with 9 decimals)
        probabilities: [u16; 4],    // Probabilities in basis points (must sum to 10000)
        reward_bps: [u16; 4],       // Reward as basis points of treasury
    ) -> Result<()> {
        let state = &mut ctx.accounts.state;
        
        // Validate probabilities sum to 10000 (100%)
        let total_prob: u16 = probabilities.iter().sum();
        require!(total_prob == 10000, WheelError::InvalidProbabilities);
        
        state.authority = ctx.accounts.authority.key();
        state.stardust_mint = ctx.accounts.stardust_mint.key();
        state.cost_per_spin = cost_per_spin;
        state.probabilities = probabilities;
        state.reward_bps = reward_bps;
        state.total_spins = 0;
        state.total_distributed = 0;
        state.bump = ctx.bumps.state;
        state.pool_bump = ctx.bumps.pool;
        
        msg!("Galaxy Wheel initialized!");
        msg!("Cost per spin: {} stardust (raw)", cost_per_spin);
        msg!("Probabilities: {:?}", probabilities);
        msg!("Reward percentages (bps): {:?}", reward_bps);
        
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
        
        msg!("Treasury funded with {} lamports ({} SOL)", amount, amount as f64 / 1e9);
        Ok(())
    }

    /// Spin the wheel - burn stardust for a chance to win SOL
    /// Returns: tier (0-3) in program logs and SpinResult event
    pub fn spin(ctx: Context<Spin>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let clock = Clock::get()?;
        
        // Get treasury balance before spin
        let treasury_balance = ctx.accounts.pool.lamports();
        
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
        let mut reward_tier: u8 = 0;
        
        for (i, &prob) in state.probabilities.iter().enumerate() {
            cumulative += prob;
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
            // First spin - initialize
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
            treasury_balance,
            timestamp: clock.unix_timestamp,
        });
        
        msg!("🎰 Spin #{}: Tier {} - Won {} lamports ({} SOL)", 
            state.total_spins,
            reward_tier,
            reward_amount,
            reward_amount as f64 / 1e9
        );
        
        Ok(())
    }

    /// Admin: Update spin cost only
    pub fn set_spin_cost(ctx: Context<UpdateConfig>, cost_per_spin: u64) -> Result<()> {
        ctx.accounts.state.cost_per_spin = cost_per_spin;
        msg!("Spin cost updated to {} stardust", cost_per_spin);
        Ok(())
    }

    /// Admin: Update probabilities and reward percentages
    pub fn set_probabilities(
        ctx: Context<UpdateConfig>,
        probabilities: [u16; 4],
        reward_bps: [u16; 4],
    ) -> Result<()> {
        // Validate probabilities sum to 10000
        let total_prob: u16 = probabilities.iter().sum();
        require!(total_prob == 10000, WheelError::InvalidProbabilities);
        
        let state = &mut ctx.accounts.state;
        state.probabilities = probabilities;
        state.reward_bps = reward_bps;
        
        msg!("Probabilities updated: {:?}", probabilities);
        msg!("Reward percentages (bps) updated: {:?}", reward_bps);
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
        space = 8 + WheelState::INIT_SPACE,
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
        space = 8 + UserSpinHistory::INIT_SPACE,
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
#[derive(InitSpace)]
pub struct WheelState {
    pub authority: Pubkey,
    pub stardust_mint: Pubkey,
    pub cost_per_spin: u64,
    pub probabilities: [u16; 4],  // Probabilities in basis points (10000 = 100%)
    pub reward_bps: [u16; 4],     // Reward as basis points of treasury
    pub total_spins: u64,
    pub total_distributed: u64,   // Total SOL distributed
    pub bump: u8,
    pub pool_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserSpinHistory {
    pub user: Pubkey,
    pub total_spins: u64,
    pub total_won: u64,
    pub last_spin_tier: u8,
    pub last_spin_amount: u64,
    pub last_spin_timestamp: i64,
}

// ============================================
// EVENTS
// ============================================

#[event]
pub struct SpinResult {
    pub user: Pubkey,
    pub tier: u8,
    pub reward_amount: u64,
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
    
    #[msg("Insufficient balance in treasury")]
    InsufficientTreasury,
    
    #[msg("Insufficient stardust balance")]
    InsufficientStardust,
    
    #[msg("Unauthorized - only authority can perform this action")]
    Unauthorized,
}
