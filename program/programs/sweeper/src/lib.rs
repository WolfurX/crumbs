//! Deployed over the retired clicker v1 program id so its leftover accounts can be closed and the
//! program itself closed afterwards. The admin key is fixed; nothing else is possible here.
use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("G86X3J8uUmYfaZawC2FDAjgVNMfyRgpUjyLQNQGxYfTR");

pub const ADMIN: Pubkey = pubkey!("GUiLxP1nZ93gXPENU3nMjhXQCt32QLfguW3sH8L6XHZK");

#[program]
pub mod sweeper {
    use super::*;

    /// Close any account this program owns; rent goes to the recipient.
    pub fn close(ctx: Context<Close>) -> Result<()> {
        let target = ctx.accounts.target.to_account_info();
        let recipient = ctx.accounts.recipient.to_account_info();
        let lamports = target.lamports();
        **recipient.try_borrow_mut_lamports()? += lamports;
        **target.try_borrow_mut_lamports()? = 0;
        target.assign(&system_program::ID);
        target.resize(0)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Close<'info> {
    #[account(address = ADMIN)]
    pub admin: Signer<'info>,
    /// CHECK: any account owned by this program
    #[account(mut, owner = crate::ID)]
    pub target: UncheckedAccount<'info>,
    /// CHECK: receives the rent
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
}
