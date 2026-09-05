//! CRUMB emission: one mint, a hard cap, a daily pool that halves each time the minted supply crosses
//! the halfway mark of what remains, and a registry of distributors (games, tools) with weights.
//! The program never sets a price and holds no treasury: everything it mints goes to a recipient a
//! distributor names.
pub mod error;
pub mod state;

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, SetAuthority, Token, TokenAccount};
use anchor_spl::token::spl_token::instruction::AuthorityType;

pub use error::*;
pub use state::*;

declare_id!("C8NRjLU9ajS5okBSbDhMBXsF2naVGm82y6g3hdefTQcY");

#[program]
pub mod crumb_emission {
    use super::*;

    /// Take over an existing, empty 6-decimal mint whose authority is the caller. Metadata is created
    /// by the caller beforehand, while they still hold the authority.
    pub fn initialize(ctx: Context<Initialize>, max_supply: u64, base_daily_pool: u64) -> Result<()> {
        let mint = &ctx.accounts.mint;
        require!(mint.supply == 0 && mint.decimals == 6, EmissionError::BadMint);
        require!(mint.mint_authority.contains(&ctx.accounts.authority.key()), EmissionError::BadMint);
        require!(max_supply > 0 && base_daily_pool > 0 && base_daily_pool <= max_supply, EmissionError::BadMint);

        let e = &mut ctx.accounts.emission;
        e.authority = ctx.accounts.authority.key();
        e.mint = mint.key();
        e.max_supply = max_supply;
        e.base_daily_pool = base_daily_pool;
        e.minted = 0;
        e.total_weight_bps = 0;
        e.distributors = 0;
        e.bump = ctx.bumps.emission;

        // mint authority -> emission PDA; freeze authority -> none, nobody can freeze CRUMB
        let cpi = ctx.accounts.token_program.key();
        token::set_authority(
            CpiContext::new(cpi, SetAuthority { account_or_mint: mint.to_account_info(), current_authority: ctx.accounts.authority.to_account_info() }),
            AuthorityType::MintTokens,
            Some(e.key()),
        )?;
        if mint.freeze_authority.contains(&ctx.accounts.authority.key()) {
            token::set_authority(
                CpiContext::new(cpi, SetAuthority { account_or_mint: mint.to_account_info(), current_authority: ctx.accounts.authority.to_account_info() }),
                AuthorityType::FreezeAccount,
                None,
            )?;
        }
        Ok(())
    }

    /// Register or update a distributor. `signer_key` is the key it will mint with.
    pub fn set_distributor(ctx: Context<SetDistributor>, weight_bps: u16, enabled: bool, name: String) -> Result<()> {
        require!(name.len() <= 24, EmissionError::NameTooLong);
        let e = &mut ctx.accounts.emission;
        let d = &mut ctx.accounts.distributor;
        let is_new = d.signer == Pubkey::default();
        let old = if d.enabled { d.weight_bps } else { 0 };
        let new = if enabled { weight_bps } else { 0 };
        let total = e.total_weight_bps.checked_sub(old).ok_or(EmissionError::Overflow)?.checked_add(new).ok_or(EmissionError::Overflow)?;
        require!(total <= BPS, EmissionError::WeightOverflow);
        e.total_weight_bps = total;
        if is_new {
            e.distributors = e.distributors.checked_add(1).ok_or(EmissionError::Overflow)?;
            d.emission = e.key();
            d.signer = ctx.accounts.signer_key.key();
            d.minted = 0;
            d.bump = ctx.bumps.distributor;
        }
        d.weight_bps = weight_bps;
        d.enabled = enabled;
        d.name = name;
        Ok(())
    }

    /// Mint CRUMB to a recipient. Only an enabled distributor's signer may call; the hard cap holds.
    pub fn mint(ctx: Context<MintCrumb>, amount: u64) -> Result<()> {
        require!(amount > 0, EmissionError::ZeroAmount);
        let d = &mut ctx.accounts.distributor;
        require!(d.enabled, EmissionError::DistributorDisabled);
        let e = &mut ctx.accounts.emission;
        require!(amount <= e.remaining(), EmissionError::SupplyExhausted);

        let seeds: &[&[u8]] = &[EMISSION_SEED, &[e.bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                token::MintTo { mint: ctx.accounts.mint.to_account_info(), to: ctx.accounts.recipient.to_account_info(), authority: e.to_account_info() },
                &[seeds],
            ),
            amount,
        )?;
        e.minted = e.minted.checked_add(amount).ok_or(EmissionError::Overflow)?;
        d.minted = d.minted.checked_add(amount).ok_or(EmissionError::Overflow)?;
        Ok(())
    }

    /// Remove a disabled distributor's record; its rent returns to the authority.
    pub fn remove_distributor(ctx: Context<RemoveDistributor>) -> Result<()> {
        require!(!ctx.accounts.distributor.enabled, EmissionError::DistributorEnabled);
        let e = &mut ctx.accounts.emission;
        e.distributors = e.distributors.saturating_sub(1);
        Ok(())
    }

    pub fn set_authority(ctx: Context<SetEmissionAuthority>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.emission.authority = new_authority;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Emission::INIT_SPACE, seeds = [EMISSION_SEED], bump)]
    pub emission: Account<'info, Emission>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetDistributor<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [EMISSION_SEED], bump = emission.bump, has_one = authority)]
    pub emission: Account<'info, Emission>,
    /// CHECK: any key; it is the future minting signer, recorded as-is
    pub signer_key: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = authority, space = 8 + Distributor::INIT_SPACE, seeds = [DISTRIBUTOR_SEED, signer_key.key().as_ref()], bump)]
    pub distributor: Account<'info, Distributor>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintCrumb<'info> {
    pub distributor_signer: Signer<'info>,
    #[account(mut, seeds = [DISTRIBUTOR_SEED, distributor_signer.key().as_ref()], bump = distributor.bump, has_one = emission)]
    pub distributor: Account<'info, Distributor>,
    #[account(mut, seeds = [EMISSION_SEED], bump = emission.bump, has_one = mint)]
    pub emission: Account<'info, Emission>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint)]
    pub recipient: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RemoveDistributor<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [EMISSION_SEED], bump = emission.bump, has_one = authority)]
    pub emission: Account<'info, Emission>,
    #[account(mut, close = authority, has_one = emission)]
    pub distributor: Account<'info, Distributor>,
}

#[derive(Accounts)]
pub struct SetEmissionAuthority<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [EMISSION_SEED], bump = emission.bump, has_one = authority)]
    pub emission: Account<'info, Emission>,
}
