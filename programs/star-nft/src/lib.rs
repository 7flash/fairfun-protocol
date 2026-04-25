use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Token, TokenAccount, Mint};
use solana_program::hash::hash;

declare_id!("HxqX7EZCWbYvjrZDJaVtU5y3ZjVXMEccWiahao9MPeKB");

/// STAR NFT Program: Two-step redemption system
/// 
/// Step 1: mint_star_nft - Burn stardust → Mint random rarity STAR NFT
/// Step 2: burn_for_treasury - Burn STAR NFT → Claim % of treasury

#[program]
pub mod star_nft {
    use super::*;

    /// Initialize the STAR NFT program
    pub fn initialize(
        ctx: Context<Initialize>,
        stardust_cost: u64,           // Stardust cost per NFT mint (1,000,000)
        rarity_probabilities: [u16; 5], // Probabilities for each rarity (sums to 10000)
        treasury_percentages: [[u16; 2]; 5], // Min/Max treasury % for each rarity (basis points)
    ) -> Result<()> {
        let state = &mut ctx.accounts.state;
        
        // Validate probabilities sum to 10000 (100%)
        let total_prob: u16 = rarity_probabilities.iter().sum();
        require!(total_prob == 10000, StarNftError::InvalidProbabilities);
        
        state.authority = ctx.accounts.authority.key();
        state.stardust_mint = ctx.accounts.stardust_mint.key();
        state.stardust_cost = stardust_cost;
        state.rarity_probabilities = rarity_probabilities;
        state.treasury_percentages = treasury_percentages;
        state.total_nfts_minted = 0;
        state.total_nfts_burned = 0;
        state.total_treasury_claimed = 0;
        state.bump = ctx.bumps.state;
        state.treasury_bump = ctx.bumps.treasury;
        
        msg!("STAR NFT Program Initialized");
        msg!("Stardust cost per mint: {}", stardust_cost);
        msg!("Rarity probabilities: {:?}", rarity_probabilities);
        
        Ok(())
    }

    /// Fund the treasury with SOL
    pub fn fund_treasury(ctx: Context<FundTreasury>, amount: u64) -> Result<()> {
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.funder.key(),
            &ctx.accounts.treasury.key(),
            amount,
        );
        
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.funder.to_account_info(),
                ctx.accounts.treasury.to_account_info(),
            ],
        )?;
        
        msg!("Treasury funded with {} lamports", amount);
        Ok(())
    }

    /// Mint a STAR NFT by burning stardust
    /// Returns a random rarity based on configured probabilities
    pub fn mint_star_nft(ctx: Context<MintStarNft>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let clock = Clock::get()?;
        
        // Generate pseudo-random rarity using blockhash and user data
        let seed_data = [
            ctx.accounts.user.key().as_ref(),
            &clock.slot.to_le_bytes(),
            &clock.unix_timestamp.to_le_bytes(),
            &state.total_nfts_minted.to_le_bytes(),
        ].concat();
        
        let hash_result = hash(&seed_data);
        let random_value = u16::from_le_bytes([hash_result.as_ref()[0], hash_result.as_ref()[1]]) % 10000;
        
        // Determine rarity based on probabilities
        let mut cumulative: u16 = 0;
        let mut rarity: u8 = 0;
        
        for (i, &prob) in state.rarity_probabilities.iter().enumerate() {
            cumulative += prob;
            if random_value < cumulative {
                rarity = i as u8;
                break;
            }
        }
        
        // Determine treasury % within rarity range (random within min/max)
        let min_pct = state.treasury_percentages[rarity as usize][0];
        let max_pct = state.treasury_percentages[rarity as usize][1];
        
        // Use different hash bytes for treasury percentage randomness
        let pct_random = u16::from_le_bytes([hash_result.as_ref()[2], hash_result.as_ref()[3]]);
        let pct_range = max_pct.saturating_sub(min_pct);
        let treasury_claim_pct = min_pct + (pct_random % (pct_range + 1));
        
        // Burn stardust from user
        let cpi_accounts = Burn {
            mint: ctx.accounts.stardust_mint.to_account_info(),
            from: ctx.accounts.user_stardust.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
        
        token::burn(cpi_ctx, state.stardust_cost)?;
        
        // Create the NFT data account
        let nft = &mut ctx.accounts.star_nft;
        nft.owner = ctx.accounts.user.key();
        nft.rarity = rarity;
        nft.treasury_claim_pct = treasury_claim_pct;
        nft.minted_at = clock.unix_timestamp;
        nft.nft_index = state.total_nfts_minted;
        nft.bump = ctx.bumps.star_nft;
        
        // Update state
        state.total_nfts_minted += 1;
        
        emit!(StarNftMinted {
            user: ctx.accounts.user.key(),
            nft_index: nft.nft_index,
            rarity,
            treasury_claim_pct,
            timestamp: clock.unix_timestamp,
        });
        
        msg!("STAR NFT Minted!");
        msg!("Rarity: {} (0=Common, 4=Legendary)", rarity);
        msg!("Treasury Claim: {}bp ({}%)", treasury_claim_pct, treasury_claim_pct as f64 / 100.0);
        
        Ok(())
    }

    /// Burn a STAR NFT to claim treasury percentage
    pub fn burn_for_treasury(ctx: Context<BurnForTreasury>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let nft = &ctx.accounts.star_nft;
        let clock = Clock::get()?;
        
        // Verify NFT ownership
        require!(nft.owner == ctx.accounts.user.key(), StarNftError::NotNftOwner);
        
        // Calculate treasury claim amount
        // treasury_claim_pct is in basis points (1 = 0.01%, 100 = 1%)
        let treasury_balance = ctx.accounts.treasury.lamports();
        let claim_amount = (treasury_balance as u128)
            .checked_mul(nft.treasury_claim_pct as u128)
            .ok_or(StarNftError::Overflow)?
            .checked_div(10000) // basis points to percentage
            .ok_or(StarNftError::Overflow)? as u64;
        
        require!(claim_amount > 0, StarNftError::ZeroClaim);
        require!(treasury_balance >= claim_amount, StarNftError::InsufficientTreasury);
        
        // Transfer SOL from treasury to user
        **ctx.accounts.treasury.try_borrow_mut_lamports()? -= claim_amount;
        **ctx.accounts.user.try_borrow_mut_lamports()? += claim_amount;
        
        // Close the NFT account (return rent to user)
        // The NFT account will be closed by Anchor's close constraint
        
        // Update state
        state.total_nfts_burned += 1;
        state.total_treasury_claimed += claim_amount;
        
        emit!(StarNftBurned {
            user: ctx.accounts.user.key(),
            nft_index: nft.nft_index,
            rarity: nft.rarity,
            claim_amount,
            treasury_balance_before: treasury_balance,
            timestamp: clock.unix_timestamp,
        });
        
        msg!("STAR NFT Burned!");
        msg!("Claimed {} lamports ({}% of treasury)", claim_amount, nft.treasury_claim_pct as f64 / 100.0);
        
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
        space = 8 + StarNftState::INIT_SPACE,
        seeds = [b"star_nft_state"],
        bump
    )]
    pub state: Account<'info, StarNftState>,
    
    #[account(
        mut,
        seeds = [b"treasury"],
        bump
    )]
    /// CHECK: Treasury PDA for SOL
    pub treasury: AccountInfo<'info>,
    
    pub stardust_mint: Account<'info, Mint>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundTreasury<'info> {
    #[account(
        seeds = [b"star_nft_state"],
        bump = state.bump
    )]
    pub state: Account<'info, StarNftState>,
    
    #[account(
        mut,
        seeds = [b"treasury"],
        bump = state.treasury_bump
    )]
    /// CHECK: Treasury PDA
    pub treasury: AccountInfo<'info>,
    
    #[account(mut)]
    pub funder: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintStarNft<'info> {
    #[account(
        mut,
        seeds = [b"star_nft_state"],
        bump = state.bump
    )]
    pub state: Account<'info, StarNftState>,
    
    #[account(
        init,
        payer = user,
        space = 8 + StarNft::INIT_SPACE,
        seeds = [b"star_nft", user.key().as_ref(), &state.total_nfts_minted.to_le_bytes()],
        bump
    )]
    pub star_nft: Account<'info, StarNft>,
    
    #[account(mut)]
    pub stardust_mint: Account<'info, Mint>,
    
    #[account(
        mut,
        constraint = user_stardust.mint == state.stardust_mint,
        constraint = user_stardust.owner == user.key(),
        constraint = user_stardust.amount >= state.stardust_cost @ StarNftError::InsufficientStardust
    )]
    pub user_stardust: Account<'info, TokenAccount>,
    
    #[account(mut)]
    pub user: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BurnForTreasury<'info> {
    #[account(
        mut,
        seeds = [b"star_nft_state"],
        bump = state.bump
    )]
    pub state: Account<'info, StarNftState>,
    
    #[account(
        mut,
        close = user,
        seeds = [b"star_nft", user.key().as_ref(), &star_nft.nft_index.to_le_bytes()],
        bump = star_nft.bump,
        constraint = star_nft.owner == user.key() @ StarNftError::NotNftOwner
    )]
    pub star_nft: Account<'info, StarNft>,
    
    #[account(
        mut,
        seeds = [b"treasury"],
        bump = state.treasury_bump
    )]
    /// CHECK: Treasury PDA
    pub treasury: AccountInfo<'info>,
    
    #[account(mut)]
    pub user: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

// ============================================
// STATE
// ============================================

#[account]
#[derive(InitSpace)]
pub struct StarNftState {
    pub authority: Pubkey,
    pub stardust_mint: Pubkey,
    pub stardust_cost: u64,              // Cost in stardust to mint one NFT
    #[max_len(5)]
    pub rarity_probabilities: [u16; 5],  // Probabilities (sums to 10000)
    #[max_len(5)]
    pub treasury_percentages: [[u16; 2]; 5], // Min/Max treasury % per rarity (basis points)
    pub total_nfts_minted: u64,
    pub total_nfts_burned: u64,
    pub total_treasury_claimed: u64,
    pub bump: u8,
    pub treasury_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct StarNft {
    pub owner: Pubkey,
    pub rarity: u8,                    // 0=Common, 1=Uncommon, 2=Rare, 3=Epic, 4=Legendary
    pub treasury_claim_pct: u16,       // Treasury percentage in basis points
    pub minted_at: i64,
    pub nft_index: u64,
    pub bump: u8,
}

// ============================================
// EVENTS
// ============================================

#[event]
pub struct StarNftMinted {
    pub user: Pubkey,
    pub nft_index: u64,
    pub rarity: u8,
    pub treasury_claim_pct: u16,
    pub timestamp: i64,
}

#[event]
pub struct StarNftBurned {
    pub user: Pubkey,
    pub nft_index: u64,
    pub rarity: u8,
    pub claim_amount: u64,
    pub treasury_balance_before: u64,
    pub timestamp: i64,
}

// ============================================
// ERRORS
// ============================================

#[error_code]
pub enum StarNftError {
    #[msg("Probabilities must sum to 10000 (100%)")]
    InvalidProbabilities,
    
    #[msg("Insufficient stardust balance")]
    InsufficientStardust,
    
    #[msg("Not the NFT owner")]
    NotNftOwner,
    
    #[msg("Insufficient treasury balance")]
    InsufficientTreasury,
    
    #[msg("Claim amount is zero")]
    ZeroClaim,
    
    #[msg("Arithmetic overflow")]
    Overflow,
}
