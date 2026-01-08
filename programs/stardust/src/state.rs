use anchor_lang::prelude::*;

/// Global protocol state - stores the authority and mint
#[account]
pub struct ProtocolState {
    /// The backend authority public key that signs claim messages
    pub authority: Pubkey,
    /// The stardust SPL token mint address
    pub stardust_mint: Pubkey,
    /// Bump seed for PDA derivation
    pub bump: u8,
}

impl ProtocolState {
    pub const LEN: usize = 8 + // discriminator
        32 + // authority
        32 + // stardust_mint
        1;   // bump
}

/// Per-user claim tracking - PDA derived from ["user_claim", user_pubkey]
#[account]
pub struct UserClaim {
    /// The user's wallet address
    pub user: Pubkey,
    /// Total stardust already claimed by this user
    pub claimed_amount: u64,
    /// Last claim timestamp
    pub last_claim_timestamp: i64,
    /// Bump seed for PDA derivation
    pub bump: u8,
}

impl UserClaim {
    pub const LEN: usize = 8 + // discriminator
        32 + // user
        8 +  // claimed_amount
        8 +  // last_claim_timestamp
        1;   // bump
}
