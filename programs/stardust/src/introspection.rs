use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::ed25519_program::ID as ED25519_PROGRAM_ID;
use std::convert::TryInto;

use crate::errors::StardustError;

/// Stardust Standard Layout offsets
const EXPECTED_PK_OFFSET: u16 = 16;
const EXPECTED_SIG_OFFSET: u16 = 48;
const EXPECTED_MSG_OFFSET: u16 = 112;

/// Verifies the Ed25519 instruction follows Stardust Standard Layout
/// and contains the expected authority pubkey and message.
///
/// This prevents "Wrong Offset" attacks where attackers include valid
/// authority keys in unused padding while signing with their own keys.
pub fn verify_ed25519_ix_integrity(
    ix: &Instruction,
    expected_authority_pubkey: &[u8],
    expected_message: &[u8],
) -> Result<()> {
    // 1. Verify it's the Ed25519 program
    if ix.program_id != ED25519_PROGRAM_ID {
        return err!(StardustError::InvalidProgramId);
    }

    // 2. Minimum length check: Header(16) + Pubkey(32) + Signature(64) = 112 bytes
    if ix.data.len() < 112 {
        return err!(StardustError::MalformedInstructionData);
    }

    // 3. Parse header - must have exactly 1 signature
    let num_signatures = ix.data[0];
    if num_signatures != 1 {
        return err!(StardustError::InvalidSignatureCount);
    }

    // 4. Parse offsets (little-endian u16 values)
    let args = &ix.data;
    
    let read_u16 = |start: usize| -> u16 {
        u16::from_le_bytes(args[start..start+2].try_into().unwrap())
    };

    let sig_offset = read_u16(2);
    let sig_ix_idx = read_u16(4);
    let pk_offset = read_u16(6);
    let pk_ix_idx = read_u16(8);
    let msg_offset = read_u16(10);
    let msg_size = read_u16(12);
    let msg_ix_idx = read_u16(14);

    // 5. Validate instruction indices - must be u16::MAX (self-contained)
    // Ed25519 program allows fetching data from other instructions; we forbid this
    if sig_ix_idx != u16::MAX || pk_ix_idx != u16::MAX || msg_ix_idx != u16::MAX {
        return err!(StardustError::ExternalInstructionReference);
    }

    // 6. Validate offsets match Stardust Standard Layout
    if pk_offset != EXPECTED_PK_OFFSET {
        msg!("Invalid PK Offset. Expected: {}, Got: {}", EXPECTED_PK_OFFSET, pk_offset);
        return err!(StardustError::InvalidPublicKeyOffset);
    }

    if sig_offset != EXPECTED_SIG_OFFSET {
        msg!("Invalid Sig Offset. Expected: {}, Got: {}", EXPECTED_SIG_OFFSET, sig_offset);
        return err!(StardustError::InvalidSignatureOffset);
    }

    if msg_offset != EXPECTED_MSG_OFFSET {
        msg!("Invalid Msg Offset. Expected: {}, Got: {}", EXPECTED_MSG_OFFSET, msg_offset);
        return err!(StardustError::InvalidMessageOffset);
    }

    // 7. Verify message size
    if msg_size as usize != expected_message.len() {
        msg!("Invalid Msg Size. Expected: {}, Got: {}", expected_message.len(), msg_size);
        return err!(StardustError::InvalidMessageSize);
    }

    // 8. Verify authority public key at offset 16
    let pk_slice = &args[16..48];
    if pk_slice != expected_authority_pubkey {
        msg!("Authority Mismatch");
        return err!(StardustError::InvalidAuthority);
    }

    // 9. Verify message content at offset 112
    let msg_end = 112 + expected_message.len();
    if args.len() < msg_end {
        return err!(StardustError::MalformedInstructionData);
    }
    let msg_slice = &args[112..msg_end];
    if msg_slice != expected_message {
        msg!("Message Mismatch");
        return err!(StardustError::InvalidMessageContent);
    }

    Ok(())
}
