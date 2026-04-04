use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_ID,
};
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::metadata::{
    create_metadata_accounts_v3, mpl_token_metadata::types::DataV2,
    CreateMetadataAccountsV3, Metadata,
};

mod errors;
mod introspection;
mod state;

use errors::StardustError;
use introspection::verify_ed25519_ix_integrity;
use state::{ProtocolState, UserClaim};

declare_id!("HsydRBzU6Bcw6ku3h4K6JqimRTxTeCfvZQL6yDBvAi4A");

/// Stardust Protocol: Secure claim of stardust tokens via backend-signed lifetime earnings
#[program]
pub mod stardust {
    use super::*;

    /// Initialize the protocol with authority and create stardust mint
    ///
    /// # Arguments
    /// * `authority` - The backend signer's public key that will sign claim messages
    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.authority = authority;
        state.stardust_mint = ctx.accounts.stardust_mint.key();
        state.bump = ctx.bumps.state;

        msg!("Stardust Protocol Initialized");
        msg!("Authority: {}", authority);
        msg!("Stardust Mint: {}", state.stardust_mint);

        Ok(())
    }

    /// Fund the treasury pool with SOL
    pub fn fund_treasury(ctx: Context<FundTreasury>, amount: u64) -> Result<()> {
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.funder.key(),
            &ctx.accounts.treasury_pool.key(),
            amount,
        );

        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.funder.to_account_info(),
                ctx.accounts.treasury_pool.to_account_info(),
            ],
        )?;

        msg!("Treasury funded with {} lamports", amount);
        Ok(())
    }

    /// Claim stardust tokens and SOL reward based on backend-signed lifetime earnings
    ///
    /// The transaction must contain a preceding Ed25519 instruction verifying
    /// the backend's signature over [user_pubkey | lifetime_earned].
    ///
    /// Mints (lifetime_earned - already_claimed) stardust tokens to the user.
    ///
    /// # Arguments
    /// * `lifetime_earned` - Total lifetime stardust earned (signed by backend)
    /// * `sol_reward` - SOL reward to withdraw from treasury (signed by backend)
    pub fn claim_stardust(ctx: Context<ClaimStardust>, lifetime_earned: u64, sol_reward: u64) -> Result<()> {
        let user_claim = &mut ctx.accounts.user_claim;
        let state = &ctx.accounts.state;

        // --- STEP 1: Calculate claimable amount ---
        // User can only claim the difference between lifetime earnings and already claimed
        if lifetime_earned < user_claim.claimed_amount {
            return err!(StardustError::InvalidLifetimeEarned);
        }

        let claimable = lifetime_earned
            .checked_sub(user_claim.claimed_amount)
            .ok_or(StardustError::InvalidLifetimeEarned)?;

        if claimable == 0 {
            return err!(StardustError::NothingToClaim);
        }

        // --- STEP 2: Instruction Introspection ---
        let ixs = &ctx.accounts.instructions;

        // Get current instruction index
        let current_index = load_current_index_checked(ixs)?;

        // Ensure there's a preceding instruction
        if current_index == 0 {
            return err!(StardustError::MissingSignatureInstruction);
        }

        // Load the immediately preceding instruction (must be Ed25519 verification)
        let signature_ix = load_instruction_at_checked((current_index - 1) as usize, ixs)?;

        // --- STEP 3: Reconstruct expected message ---
        // Payload = [UserPubkey(32) | LifetimeEarned(8) | SolReward(8)]
        let user_key = ctx.accounts.user.key();
        let mut expected_message = Vec::with_capacity(48);
        expected_message.extend_from_slice(&user_key.to_bytes());
        expected_message.extend_from_slice(&lifetime_earned.to_le_bytes());
        expected_message.extend_from_slice(&sol_reward.to_le_bytes());

        // --- STEP 4: Verify Ed25519 instruction integrity ---
        verify_ed25519_ix_integrity(
            &signature_ix,
            &state.authority.to_bytes(),
            &expected_message,
        )?;

        // --- STEP 5: Mint stardust tokens to user ---
        let seeds = &[b"state".as_ref(), &[state.bump]];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = MintTo {
            mint: ctx.accounts.stardust_mint.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.state.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        token::mint_to(cpi_ctx, claimable)?;

        // --- STEP 6: Transfer SOL reward from treasury if applicable ---
        if sol_reward > 0 {
            let treasury_balance = ctx.accounts.treasury_pool.lamports();
            if treasury_balance < sol_reward {
                return err!(StardustError::InsufficientTreasury);
            }

            let pool_bump = ctx.bumps.treasury_pool;
            let pool_seeds: &[&[u8]] = &[b"treasury_pool", &[pool_bump]];

            let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.treasury_pool.key(),
                &ctx.accounts.user.key(),
                sol_reward,
            );

            anchor_lang::solana_program::program::invoke_signed(
                &transfer_ix,
                &[
                    ctx.accounts.treasury_pool.to_account_info(),
                    ctx.accounts.user.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[pool_seeds],
            )?;
            msg!("Transferred {} lamports from treasury", sol_reward);
        }

        // --- STEP 7: Update user claim state ---
        user_claim.claimed_amount = lifetime_earned;
        user_claim.last_claim_timestamp = Clock::get()?.unix_timestamp;

        msg!("Stardust Claimed!");
        msg!("User: {}", user_key);
        msg!("Claimed Amount: {}", claimable);
        msg!("Total Lifetime Claimed: {}", lifetime_earned);
        msg!("SOL Reward: {}", sol_reward);

        emit!(StardustClaimed {
            user: user_key,
            claimed_amount: claimable,
            total_claimed: lifetime_earned,
            timestamp: user_claim.last_claim_timestamp,
        });

        Ok(())
    }

    /// Create token metadata for the stardust mint
    pub fn create_metadata(
        ctx: Context<CreateMetadata>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        let state = &ctx.accounts.state;
        let seeds = &[b"state".as_ref(), &[state.bump]];
        let signer_seeds = &[&seeds[..]];

        let data_v2 = DataV2 {
            name,
            symbol,
            uri,
            seller_fee_basis_points: 0,
            creators: None,
            collection: None,
            uses: None,
        };

        let cpi_accounts = CreateMetadataAccountsV3 {
            metadata: ctx.accounts.metadata.to_account_info(),
            mint: ctx.accounts.stardust_mint.to_account_info(),
            mint_authority: ctx.accounts.state.to_account_info(),
            payer: ctx.accounts.payer.to_account_info(),
            update_authority: ctx.accounts.payer.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            rent: ctx.accounts.rent.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_metadata_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );

        create_metadata_accounts_v3(cpi_ctx, data_v2, true, true, None)?;
        msg!("Token Metadata Created!");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// Protocol state PDA - stores authority and mint
    #[account(
        init,
        payer = payer,
        space = ProtocolState::LEN,
        seeds = [b"state"],
        bump
    )]
    pub state: Account<'info, ProtocolState>,

    /// Stardust token mint - created by this instruction
    /// Mint authority is the protocol state PDA
    #[account(
        init,
        payer = payer,
        mint::decimals = 9,
        mint::authority = state,
        seeds = [b"stardust_mint"],
        bump
    )]
    pub stardust_mint: Account<'info, Mint>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundTreasury<'info> {
    /// CHECK: SOL treasury pool PDA
    #[account(
        mut,
        seeds = [b"treasury_pool"],
        bump
    )]
    pub treasury_pool: AccountInfo<'info>,

    #[account(mut)]
    pub funder: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimStardust<'info> {
    /// The user claiming stardust
    #[account(mut)]
    pub user: Signer<'info>,

    /// User's claim tracking PDA
    #[account(
        init_if_needed,
        payer = user,
        space = UserClaim::LEN,
        seeds = [b"user_claim", user.key().as_ref()],
        bump
    )]
    pub user_claim: Account<'info, UserClaim>,

    /// Protocol state
    #[account(
        seeds = [b"state"],
        bump = state.bump,
        has_one = stardust_mint
    )]
    pub state: Account<'info, ProtocolState>,

    /// CHECK: SOL treasury pool PDA
    #[account(
        mut,
        seeds = [b"treasury_pool"],
        bump
    )]
    pub treasury_pool: AccountInfo<'info>,

    /// Stardust token mint
    #[account(mut)]
    pub stardust_mint: Account<'info, Mint>,

    /// User's token account for stardust
    #[account(
        mut,
        associated_token::mint = stardust_mint,
        associated_token::authority = user
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    /// Instructions sysvar for Ed25519 introspection
    /// CHECK: Verified via address constraint
    #[account(address = INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CreateMetadata<'info> {
    #[account(seeds = [b"state"], bump = state.bump, has_one = stardust_mint)]
    pub state: Account<'info, ProtocolState>,
    #[account(mut)]
    pub stardust_mint: Account<'info, Mint>,
    /// CHECK: Created by Metaplex
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[event]
pub struct StardustClaimed {
    pub user: Pubkey,
    pub claimed_amount: u64,
    pub total_claimed: u64,
    pub timestamp: i64,
}
