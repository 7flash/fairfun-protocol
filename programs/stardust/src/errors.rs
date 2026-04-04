use anchor_lang::prelude::*;

/// Custom error codes for the Stardust Protocol
#[error_code]
pub enum StardustError {
    #[msg("Signature has expired.")]
    SignatureExpired,

    #[msg("No preceding signature instruction found.")]
    MissingSignatureInstruction,

    #[msg("Preceding instruction is not the Ed25519 program.")]
    InvalidProgramId,

    #[msg("Instruction data is too short or malformed.")]
    MalformedInstructionData,

    #[msg("Expected exactly 1 signature in Ed25519 instruction.")]
    InvalidSignatureCount,

    #[msg("External instruction reference detected. All data must be self-contained.")]
    ExternalInstructionReference,

    #[msg("Public key offset mismatch. Expected Stardust Standard Layout.")]
    InvalidPublicKeyOffset,

    #[msg("Signature offset mismatch. Expected Stardust Standard Layout.")]
    InvalidSignatureOffset,

    #[msg("Message offset mismatch. Expected Stardust Standard Layout.")]
    InvalidMessageOffset,

    #[msg("Message size mismatch.")]
    InvalidMessageSize,

    #[msg("Authority public key mismatch.")]
    InvalidAuthority,

    #[msg("Signed message content mismatch.")]
    InvalidMessageContent,

    #[msg("Nothing to claim. Already claimed up to lifetime earnings.")]
    NothingToClaim,

    #[msg("Lifetime earned cannot be less than already claimed.")]
    InvalidLifetimeEarned,

    #[msg("Insufficient balance in treasury to fulfill claim.")]
    InsufficientTreasury,
}
