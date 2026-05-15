use anchor_lang::prelude::*;

#[error_code]
pub enum FairfunRewardsError {
    #[msg("Signature has expired")]
    SignatureExpired,
    #[msg("Missing preceding signature instruction")]
    MissingSignatureInstruction,
    #[msg("Preceding instruction is not the Ed25519 program")]
    InvalidProgramId,
    #[msg("Instruction data is malformed")]
    MalformedInstructionData,
    #[msg("Expected exactly one Ed25519 signature")]
    InvalidSignatureCount,
    #[msg("External instruction reference is not allowed")]
    ExternalInstructionReference,
    #[msg("Public key offset mismatch")]
    InvalidPublicKeyOffset,
    #[msg("Signature offset mismatch")]
    InvalidSignatureOffset,
    #[msg("Message offset mismatch")]
    InvalidMessageOffset,
    #[msg("Message size mismatch")]
    InvalidMessageSize,
    #[msg("Backend authority mismatch")]
    InvalidAuthority,
    #[msg("Signed message content mismatch")]
    InvalidMessageContent,
    #[msg("Pool is inactive")]
    PoolInactive,
    #[msg("Only the admin can perform this action")]
    NotAdmin,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Cumulative earned cannot decrease")]
    CumulativeEarnedDecreased,
    #[msg("Authorized amount exceeds signed deposit snapshot")]
    EarnedExceedsObservedDeposits,
    #[msg("Signed deposit snapshot exceeds onchain deposits")]
    ObservedDepositsExceedOnchainTotal,
    #[msg("Claim would exceed pool deposits")]
    ClaimExceedsPoolDeposits,
    #[msg("Treasury balance is insufficient")]
    InsufficientTreasury,
    #[msg("Delegated claims are disabled for this user")]
    DelegatedClaimsDisabled,
    #[msg("Delegator and claimant must be different wallets")]
    InvalidDelegatedClaimTarget,
}
