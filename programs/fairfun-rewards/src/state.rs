use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub admin: Pubkey,
    pub backend_authority: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RewardPool {
    pub token_mint: Pubkey,
    pub total_deposited: u64,
    pub total_claimed: u64,
    pub active: bool,
    pub bump: u8,
    pub treasury_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserClaim {
    pub user: Pubkey,
    pub pool: Pubkey,
    pub claimed_amount: u64,
    pub bump: u8,
}
