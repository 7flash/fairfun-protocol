use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use solana_sdk_ids::ed25519_program::ID as ED25519_PROGRAM_ID;

use crate::errors::FairfunRewardsError;

const EXPECTED_PK_OFFSET: u16 = 16;
const EXPECTED_SIG_OFFSET: u16 = 48;
const EXPECTED_MSG_OFFSET: u16 = 112;

pub fn verify_ed25519_ix_integrity(
    ix: &Instruction,
    expected_authority_pubkey: &[u8],
    expected_message: &[u8],
) -> Result<()> {
    if ix.program_id != ED25519_PROGRAM_ID {
        return err!(FairfunRewardsError::InvalidProgramId);
    }

    if ix.data.len() < EXPECTED_MSG_OFFSET as usize {
        return err!(FairfunRewardsError::MalformedInstructionData);
    }

    if ix.data[0] != 1 {
        return err!(FairfunRewardsError::InvalidSignatureCount);
    }

    let args = &ix.data;
    let read_u16 = |start: usize| -> Result<u16> {
        let bytes = args
            .get(start..start + 2)
            .ok_or(FairfunRewardsError::MalformedInstructionData)?;
        let array: [u8; 2] = bytes
            .try_into()
            .map_err(|_| error!(FairfunRewardsError::MalformedInstructionData))?;
        Ok(u16::from_le_bytes(array))
    };

    let signature_offset = read_u16(2)?;
    let signature_ix_index = read_u16(4)?;
    let public_key_offset = read_u16(6)?;
    let public_key_ix_index = read_u16(8)?;
    let message_offset = read_u16(10)?;
    let message_size = read_u16(12)?;
    let message_ix_index = read_u16(14)?;

    if signature_ix_index != u16::MAX
        || public_key_ix_index != u16::MAX
        || message_ix_index != u16::MAX
    {
        return err!(FairfunRewardsError::ExternalInstructionReference);
    }

    if public_key_offset != EXPECTED_PK_OFFSET {
        return err!(FairfunRewardsError::InvalidPublicKeyOffset);
    }

    if signature_offset != EXPECTED_SIG_OFFSET {
        return err!(FairfunRewardsError::InvalidSignatureOffset);
    }

    if message_offset != EXPECTED_MSG_OFFSET {
        return err!(FairfunRewardsError::InvalidMessageOffset);
    }

    if message_size as usize != expected_message.len() {
        return err!(FairfunRewardsError::InvalidMessageSize);
    }

    let pubkey_slice = args
        .get(EXPECTED_PK_OFFSET as usize..EXPECTED_SIG_OFFSET as usize)
        .ok_or(FairfunRewardsError::MalformedInstructionData)?;
    if pubkey_slice != expected_authority_pubkey {
        return err!(FairfunRewardsError::InvalidAuthority);
    }

    let message_end = EXPECTED_MSG_OFFSET as usize + expected_message.len();
    let message_slice = args
        .get(EXPECTED_MSG_OFFSET as usize..message_end)
        .ok_or(FairfunRewardsError::MalformedInstructionData)?;
    if message_slice != expected_message {
        return err!(FairfunRewardsError::InvalidMessageContent);
    }

    Ok(())
}
