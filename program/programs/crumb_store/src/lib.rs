//! Byte blobs on chain. A blob account is created by the client with the system program (owner =
//! this program, full size up front, since CPI allocation is capped at 10 KB), then `init` writes the
//! header, `write` fills it in chunks of about 1 KB per transaction, `finalize` freezes it and hands
//! the authority to its long-term owner. A read-only HTTP route serves finalized blobs by address.
//!
//! Layout: 0..8 discriminator "crumblob" | 8..40 authority | 40..44 data length (u32 LE) |
//! 44 finalized | 45 mime length | 46..78 mime (padded) | 78..96 reserved | 96.. data
use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("A9bmhLfaJRUQKQvRktrtztg1w3hoRjp5UVc5TUhcaq2J");

pub const DISC: [u8; 8] = *b"crumblob";
pub const HEADER: usize = 96;
pub const MIME_MAX: usize = 32;
const OFF_AUTHORITY: usize = 8;
const OFF_LEN: usize = 40;
const OFF_FINAL: usize = 44;
const OFF_MIME_LEN: usize = 45;
const OFF_MIME: usize = 46;

#[program]
pub mod crumb_store {
    use super::*;

    /// Write the header into a freshly created, zeroed account owned by this program.
    pub fn init(ctx: Context<Init>, mime: String) -> Result<()> {
        require!(mime.len() >= 1 && mime.len() <= MIME_MAX, StoreError::BadMime);
        let blob = &ctx.accounts.blob;
        let mut data = blob.try_borrow_mut_data()?;
        require!(data.len() > HEADER, StoreError::TooSmall);
        require!(data[..8] == [0u8; 8], StoreError::AlreadyInitialized);
        let len = (data.len() - HEADER) as u32;
        data[..8].copy_from_slice(&DISC);
        data[OFF_AUTHORITY..OFF_AUTHORITY + 32].copy_from_slice(ctx.accounts.authority.key.as_ref());
        data[OFF_LEN..OFF_LEN + 4].copy_from_slice(&len.to_le_bytes());
        data[OFF_FINAL] = 0;
        data[OFF_MIME_LEN] = mime.len() as u8;
        data[OFF_MIME..OFF_MIME + mime.len()].copy_from_slice(mime.as_bytes());
        Ok(())
    }

    /// Copy a chunk into the data region.
    pub fn write(ctx: Context<Authorized>, offset: u32, bytes: Vec<u8>) -> Result<()> {
        let blob = &ctx.accounts.blob;
        let mut data = blob.try_borrow_mut_data()?;
        check_header(&data, ctx.accounts.authority.key)?;
        require!(data[OFF_FINAL] == 0, StoreError::Finalized);
        let len = u32::from_le_bytes(data[OFF_LEN..OFF_LEN + 4].try_into().unwrap()) as usize;
        let end = (offset as usize).checked_add(bytes.len()).ok_or(StoreError::OutOfRange)?;
        require!(end <= len, StoreError::OutOfRange);
        let start = HEADER + offset as usize;
        data[start..start + bytes.len()].copy_from_slice(&bytes);
        Ok(())
    }

    /// Freeze the blob and hand the authority to its long-term owner.
    pub fn finalize(ctx: Context<Authorized>, new_authority: Pubkey) -> Result<()> {
        let blob = &ctx.accounts.blob;
        let mut data = blob.try_borrow_mut_data()?;
        check_header(&data, ctx.accounts.authority.key)?;
        require!(data[OFF_FINAL] == 0, StoreError::Finalized);
        data[OFF_FINAL] = 1;
        data[OFF_AUTHORITY..OFF_AUTHORITY + 32].copy_from_slice(new_authority.as_ref());
        Ok(())
    }

    /// Return the rent to the recipient and drop the account.
    pub fn close(ctx: Context<Close>) -> Result<()> {
        let blob = ctx.accounts.blob.to_account_info();
        {
            let data = blob.try_borrow_data()?;
            check_header(&data, ctx.accounts.authority.key)?;
        }
        let recipient = ctx.accounts.recipient.to_account_info();
        let lamports = blob.lamports();
        **recipient.try_borrow_mut_lamports()? += lamports;
        **blob.try_borrow_mut_lamports()? = 0;
        blob.assign(&system_program::ID);
        blob.resize(0)?;
        Ok(())
    }
}

fn check_header(data: &[u8], authority: &Pubkey) -> Result<()> {
    require!(data.len() >= HEADER && data[..8] == DISC, StoreError::NotInitialized);
    require!(&data[OFF_AUTHORITY..OFF_AUTHORITY + 32] == authority.as_ref(), StoreError::WrongAuthority);
    Ok(())
}

#[derive(Accounts)]
pub struct Init<'info> {
    /// CHECK: zeroed account owned by this program, created by the client with the system program
    #[account(mut, owner = crate::ID)]
    pub blob: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Authorized<'info> {
    /// CHECK: header is verified in the handler
    #[account(mut, owner = crate::ID)]
    pub blob: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Close<'info> {
    /// CHECK: header is verified in the handler
    #[account(mut, owner = crate::ID)]
    pub blob: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
    /// CHECK: receives the rent
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
}

#[error_code]
pub enum StoreError {
    #[msg("mime type must be 1 to 32 bytes")]
    BadMime,
    #[msg("account too small for the header")]
    TooSmall,
    #[msg("blob already initialized")]
    AlreadyInitialized,
    #[msg("blob not initialized")]
    NotInitialized,
    #[msg("wrong authority")]
    WrongAuthority,
    #[msg("blob is finalized")]
    Finalized,
    #[msg("write out of range")]
    OutOfRange,
}
