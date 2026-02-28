use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_spl::token::{Mint};

declare_id!("3M12BfitAEYz14WJBMnjahEuSvhsWhjfGJXbzur26o2U");

/// Galaxy Wheel Program - Dual Pool System
/// Auto Pool (wheel_pool): Random holder picked from on-chain registry each spin
/// Manual Pool (wheel_manual_pool): Holders get one free spin per 24h
/// No stardust burn - probabilities are weighted by stardust rank

pub const SPIN_COOLDOWN: i64 = 86400; // 24 hours in seconds
pub const MAX_TIERS: usize = 10;
pub const MAX_HOLDERS: usize = 30;

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
        
        msg!("Auto pool funded with {} lamports", amount);
        Ok(())
    }

    /// Fund the manual spin pool with SOL
    pub fn fund_manual_pool(ctx: Context<FundManualPool>, amount: u64) -> Result<()> {
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.funder.key(),
            &ctx.accounts.manual_pool.key(),
            amount,
        );

        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.funder.to_account_info(),
                ctx.accounts.manual_pool.to_account_info(),
            ],
        )?;

        msg!("Manual pool funded with {} lamports", amount);
        Ok(())
    }

    /// Daily spin - authority calls on behalf of holder, no stardust burn
    /// Uses manual_pool PDA, enforces 24h cooldown per holder
    /// Rewards are ACCUMULATED in UserRewards PDA (user must withdraw)
    pub fn spin(
        ctx: Context<Spin>,
        probabilities: [u16; MAX_TIERS],
    ) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let clock = Clock::get()?;
        let num_tiers = state.num_tiers as usize;

        // Validate probabilities sum to 10000
        let total_prob: u16 = probabilities[..num_tiers].iter().sum();
        require!(total_prob == 10000, WheelError::InvalidProbabilities);

        // Check 24h cooldown
        let user_history = &ctx.accounts.user_history;
        if user_history.user != Pubkey::default() {
            let elapsed = clock.unix_timestamp - user_history.last_spin_timestamp;
            require!(elapsed >= SPIN_COOLDOWN, WheelError::SpinCooldown);
        }

        // Get manual pool balance
        let treasury_balance = ctx.accounts.manual_pool.lamports();

        // Generate pseudo-random number
        let seed_data = [
            ctx.accounts.holder.key().as_ref(),
            &clock.slot.to_le_bytes(),
            &clock.unix_timestamp.to_le_bytes(),
            &state.total_spins.to_le_bytes(),
        ].concat();

        let hash_result = hash(&seed_data);
        let random_value = u16::from_le_bytes([hash_result.as_ref()[0], hash_result.as_ref()[1]]) % 10000;

        // Determine reward tier
        let mut cumulative: u16 = 0;
        let mut reward_tier: u8 = 0;

        for i in 0..num_tiers {
            cumulative += probabilities[i];
            if random_value < cumulative {
                reward_tier = i as u8;
                break;
            }
        }

        // Calculate reward as % of manual pool
        let reward_bps = state.reward_bps[reward_tier as usize] as u64;
        let reward_amount = (treasury_balance * reward_bps) / 10000;

        // Accumulate reward in UserRewards PDA (no direct transfer)
        let user_rewards = &mut ctx.accounts.user_rewards;
        if user_rewards.user == Pubkey::default() {
            user_rewards.user = ctx.accounts.holder.key();
            user_rewards.bump = ctx.bumps.user_rewards;
        }
        user_rewards.available += reward_amount;
        user_rewards.total_earned += reward_amount;
        user_rewards.last_reward_ts = clock.unix_timestamp;

        // Update state
        state.total_spins += 1;
        state.total_distributed += reward_amount;

        // Update user spin history
        let user_history = &mut ctx.accounts.user_history;
        if user_history.user == Pubkey::default() {
            user_history.user = ctx.accounts.holder.key();
        }
        user_history.total_spins += 1;
        user_history.total_won += reward_amount;
        user_history.last_spin_tier = reward_tier;
        user_history.last_spin_amount = reward_amount;
        user_history.last_spin_timestamp = clock.unix_timestamp;

        // Emit result event
        emit!(SpinResult {
            user: ctx.accounts.holder.key(),
            tier: reward_tier,
            reward_amount,
            reward_bps: reward_bps as u16,
            treasury_balance,
            timestamp: clock.unix_timestamp,
        });

        msg!("Daily Spin #{}: Holder {} - Tier {} - Credited {} lamports (available: {})",
            state.total_spins, ctx.accounts.holder.key(), reward_tier, reward_amount, user_rewards.available);
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

    /// Admin: Update stardust mint address (for fixing initialization errors)
    pub fn set_stardust_mint(ctx: Context<UpdateMint>, new_mint: Pubkey) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let old_mint = state.stardust_mint;
        state.stardust_mint = new_mint;
        msg!("Stardust mint updated from {} to {}", old_mint, new_mint);
        Ok(())
    }

    /// Admin: Update the on-chain holder registry
    /// Replaces the entire holder list (max MAX_HOLDERS entries)
    pub fn update_holders(
        ctx: Context<UpdateHolders>,
        holders: Vec<Pubkey>,
    ) -> Result<()> {
        require!(holders.len() <= MAX_HOLDERS, WheelError::TooManyHolders);
        require!(!holders.is_empty(), WheelError::EmptyHolderList);

        let registry = &mut ctx.accounts.registry;
        registry.authority = ctx.accounts.authority.key();
        registry.num_holders = holders.len() as u16;
        registry.last_updated = Clock::get()?.unix_timestamp;

        // Copy holders into fixed-size array
        registry.holders = [Pubkey::default(); MAX_HOLDERS];
        for (i, h) in holders.iter().enumerate() {
            registry.holders[i] = *h;
        }

        msg!("Holder registry updated with {} holders", holders.len());
        Ok(())
    }

    /// Admin: Clear the holder registry
    pub fn clear_holders(ctx: Context<UpdateHolders>) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        registry.num_holders = 0;
        registry.holders = [Pubkey::default(); MAX_HOLDERS];
        msg!("Holder registry cleared");
        Ok(())
    }

    /// Admin: Spin the wheel for a specific holder
    /// Winner is the holder whose user_rewards PDA is passed
    /// Reward is ACCUMULATED in the UserRewards PDA (not transferred directly)
    /// User must call withdraw() to claim
    pub fn admin_spin(
        ctx: Context<AdminSpin>,
        probabilities: [u16; MAX_TIERS],
    ) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let clock = Clock::get()?;
        let num_tiers = state.num_tiers as usize;

        // Validate probabilities sum to 10000
        let total_prob: u16 = probabilities[..num_tiers].iter().sum();
        require!(total_prob == 10000, WheelError::InvalidProbabilities);

        // Get treasury balance
        let treasury_balance = ctx.accounts.pool.lamports();

        // The holder is explicitly passed as an account
        let holder_pubkey = ctx.accounts.holder.key();

        // Generate tier random number
        let tier_seed = [
            holder_pubkey.as_ref(),
            &clock.slot.to_le_bytes()[..],
            &clock.unix_timestamp.to_le_bytes()[..],
            &state.total_spins.to_le_bytes()[..],
            b"tier",
        ].concat();
        let tier_hash = hash(&tier_seed);
        let random_value = u16::from_le_bytes([tier_hash.as_ref()[0], tier_hash.as_ref()[1]]) % 10000;

        // Determine reward tier
        let mut cumulative: u16 = 0;
        let mut reward_tier: u8 = 0;
        for i in 0..num_tiers {
            cumulative += probabilities[i];
            if random_value < cumulative {
                reward_tier = i as u8;
                break;
            }
        }

        // Calculate reward as % of treasury
        let reward_bps = state.reward_bps[reward_tier as usize] as u64;
        let reward_amount = (treasury_balance * reward_bps) / 10000;

        // Accumulate reward in UserRewards PDA (no direct transfer)
        let user_rewards = &mut ctx.accounts.user_rewards;
        if user_rewards.user == Pubkey::default() {
            user_rewards.user = holder_pubkey;
            user_rewards.bump = ctx.bumps.user_rewards;
        }
        user_rewards.available += reward_amount;
        user_rewards.total_earned += reward_amount;
        user_rewards.last_reward_ts = clock.unix_timestamp;

        // Update state
        state.total_spins += 1;
        state.total_distributed += reward_amount;

        // Emit result event
        emit!(SpinResult {
            user: holder_pubkey,
            tier: reward_tier,
            reward_amount,
            reward_bps: reward_bps as u16,
            treasury_balance,
            timestamp: clock.unix_timestamp,
        });

        msg!("Admin Spin #{}: Holder {} - Tier {} - Credited {} lamports (available: {})",
            state.total_spins, holder_pubkey, reward_tier, reward_amount, user_rewards.available);
        Ok(())
    }

    /// Withdraw accumulated rewards from UserRewards PDA
    /// User signs the transaction, SOL is transferred from pool to user
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let user_rewards = &mut ctx.accounts.user_rewards;
        let amount = user_rewards.available;
        
        require!(amount > 0, WheelError::NothingToWithdraw);

        let treasury_balance = ctx.accounts.pool.lamports();
        require!(treasury_balance >= amount, WheelError::InsufficientTreasury);

        // Transfer SOL from pool PDA to user
        let state = &ctx.accounts.state;
        let pool_bump = state.pool_bump;
        let pool_seeds: &[&[u8]] = &[b"wheel_pool", &[pool_bump]];

        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.pool.key(),
            &ctx.accounts.user.key(),
            amount,
        );

        anchor_lang::solana_program::program::invoke_signed(
            &transfer_ix,
            &[
                ctx.accounts.pool.to_account_info(),
                ctx.accounts.user.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[pool_seeds],
        )?;

        // Update rewards state
        user_rewards.available = 0;
        user_rewards.total_withdrawn += amount;

        msg!("Withdraw: {} claimed {} lamports", ctx.accounts.user.key(), amount);
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
    /// CHECK: SOL auto treasury pool PDA
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
pub struct FundManualPool<'info> {
    /// CHECK: SOL manual spin pool PDA
    #[account(
        mut,
        seeds = [b"wheel_manual_pool"],
        bump
    )]
    pub manual_pool: AccountInfo<'info>,

    #[account(mut)]
    pub funder: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Spin<'info> {
    #[account(
        mut,
        seeds = [b"wheel_state"],
        bump = state.bump,
        constraint = state.authority == authority.key() @ WheelError::Unauthorized
    )]
    pub state: Account<'info, WheelState>,

    /// CHECK: SOL manual pool PDA
    #[account(
        mut,
        seeds = [b"wheel_manual_pool"],
        bump
    )]
    pub manual_pool: AccountInfo<'info>,

    /// Authority must match state.authority
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Target holder
    pub holder: AccountInfo<'info>,

    /// Holder's UserRewards PDA — rewards are accumulated here
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + UserRewards::LEN,
        seeds = [b"user_rewards", holder.key().as_ref()],
        bump
    )]
    pub user_rewards: Account<'info, UserRewards>,

    /// Holder's spin history PDA (for 24h cooldown tracking)
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + UserSpinHistory::LEN,
        seeds = [b"user_history", holder.key().as_ref()],
        bump
    )]
    pub user_history: Account<'info, UserSpinHistory>,

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

#[derive(Accounts)]
pub struct UpdateMint<'info> {
    #[account(
        mut,
        seeds = [b"wheel_state"],
        bump = state.bump,
        constraint = state.authority == authority.key() @ WheelError::Unauthorized
    )]
    pub state: Account<'info, WheelState>,
    
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateHolders<'info> {
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + HolderRegistry::LEN,
        seeds = [b"holder_registry"],
        bump
    )]
    pub registry: Box<Account<'info, HolderRegistry>>,

    #[account(
        seeds = [b"wheel_state"],
        bump = state.bump,
        constraint = state.authority == authority.key() @ WheelError::Unauthorized
    )]
    pub state: Account<'info, WheelState>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminSpin<'info> {
    #[account(
        mut,
        seeds = [b"wheel_state"],
        bump = state.bump,
        constraint = state.authority == authority.key() @ WheelError::Unauthorized
    )]
    pub state: Account<'info, WheelState>,

    /// CHECK: SOL treasury pool PDA
    #[account(
        mut,
        seeds = [b"wheel_pool"],
        bump = state.pool_bump
    )]
    pub pool: AccountInfo<'info>,

    /// CHECK: The holder being spun for
    pub holder: AccountInfo<'info>,

    /// Holder's UserRewards PDA — rewards are accumulated here
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + UserRewards::LEN,
        seeds = [b"user_rewards", holder.key().as_ref()],
        bump
    )]
    pub user_rewards: Account<'info, UserRewards>,

    /// Authority must match state.authority
    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
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

    /// User's UserRewards PDA
    #[account(
        mut,
        seeds = [b"user_rewards", user.key().as_ref()],
        bump = user_rewards.bump,
        constraint = user_rewards.user == user.key() @ WheelError::Unauthorized
    )]
    pub user_rewards: Account<'info, UserRewards>,

    /// The user withdrawing their rewards
    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
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

#[account]
pub struct HolderRegistry {
    pub authority: Pubkey,              // 32
    pub num_holders: u16,               // 2
    pub last_updated: i64,              // 8
    pub holders: [Pubkey; MAX_HOLDERS], // 32 * 30 = 960
}

impl HolderRegistry {
    pub const LEN: usize = 32 + 2 + 8 + (32 * MAX_HOLDERS); // 1002
}

#[account]
pub struct UserRewards {
    pub user: Pubkey,           // 32
    pub available: u64,         // 8 — SOL available for withdrawal (lamports)
    pub total_earned: u64,      // 8 — lifetime earnings
    pub total_withdrawn: u64,   // 8 — lifetime withdrawals
    pub last_reward_ts: i64,    // 8 — last reward timestamp
    pub bump: u8,               // 1
}

impl UserRewards {
    pub const LEN: usize = 32 + 8 + 8 + 8 + 8 + 1; // 65
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
    
    #[msg("Unauthorized - only authority can perform this action")]
    Unauthorized,

    #[msg("Must wait 24 hours between daily spins")]
    SpinCooldown,

    #[msg("Too many holders (max 30)")]
    TooManyHolders,

    #[msg("Holder list cannot be empty")]
    EmptyHolderList,

    #[msg("Winner account not found in remaining_accounts")]
    WinnerNotFound,

    #[msg("No rewards available to withdraw")]
    NothingToWithdraw,
}
