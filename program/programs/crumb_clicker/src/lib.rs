//! Crumb Clicker: an idle clicker where every click is a transaction. Cookies are produced by
//! clicking and by bakers; each UTC day's cookie and click totals are recorded on chain and a fixed
//! CRUMB pool for that day is split by share. The CRUMB itself is minted by the emission program;
//! this program is one of its distributors.
pub mod error;
pub mod state;

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount};
use crumb_emission::program::CrumbEmission;
use crumb_emission::{Distributor, Emission};

pub use error::*;
pub use state::*;

declare_id!("7aPZt6exe1H2A1fnSqV2kV2ZHpgQWtKe4LYEXv1x3Lqi");

#[program]
pub mod crumb_clicker {
    use super::*;

    pub fn init_game(ctx: Context<InitGame>, start_fee_lamports: u64, free_slots: u64, entry_burn_base: u64, click_cap_per_day: u16, pool_cookie_bps: u16) -> Result<()> {
        require!(pool_cookie_bps as u64 <= BPS && click_cap_per_day > 0, ClickerError::BadConfig);
        let g = &mut ctx.accounts.game;
        g.admin = ctx.accounts.admin.key();
        g.emission = ctx.accounts.emission.key();
        g.crumb_mint = ctx.accounts.emission.mint;
        g.treasury = ctx.accounts.treasury.key();
        g.start_fee_lamports = start_fee_lamports;
        g.free_slots = free_slots;
        g.entry_burn_base = entry_burn_base;
        g.click_cap_per_day = click_cap_per_day;
        g.pool_cookie_bps = pool_cookie_bps;
        g.players = 0;
        g.total_clicks = 0;
        g.total_cookies_milli = 0;
        g.bump = ctx.bumps.game;
        g.minter_bump = ctx.bumps.minter;
        Ok(())
    }

    pub fn set_params(ctx: Context<AdminOnly>, start_fee_lamports: u64, free_slots: u64, entry_burn_base: u64, click_cap_per_day: u16, pool_cookie_bps: u16, treasury: Pubkey) -> Result<()> {
        require!(pool_cookie_bps as u64 <= BPS && click_cap_per_day > 0, ClickerError::BadConfig);
        let g = &mut ctx.accounts.game;
        g.start_fee_lamports = start_fee_lamports;
        g.free_slots = free_slots;
        g.entry_burn_base = entry_burn_base;
        g.click_cap_per_day = click_cap_per_day;
        g.pool_cookie_bps = pool_cookie_bps;
        g.treasury = treasury;
        Ok(())
    }

    /// Create the player account. Pays the start fee; past the free slots also burns CRUMB.
    pub fn start(ctx: Context<Start>, session: Pubkey) -> Result<()> {
        let g = &mut ctx.accounts.game;
        if g.start_fee_lamports > 0 {
            system_program::transfer(
                CpiContext::new(ctx.accounts.system_program.key(), system_program::Transfer { from: ctx.accounts.owner.to_account_info(), to: ctx.accounts.treasury.to_account_info() }),
                g.start_fee_lamports,
            )?;
        }
        let burn = g.entry_burn();
        if burn > 0 {
            let ata = ctx.accounts.owner_crumb.as_ref().ok_or(ClickerError::NotEnoughCookies)?;
            token::burn(
                CpiContext::new(ctx.accounts.token_program.key(), Burn { mint: ctx.accounts.crumb_mint.to_account_info(), from: ata.to_account_info(), authority: ctx.accounts.owner.to_account_info() }),
                burn,
            )?;
        }
        let now = Clock::get()?.unix_timestamp;
        let p = &mut ctx.accounts.player;
        p.owner = ctx.accounts.owner.key();
        p.session = session;
        p.last_ts = now;
        p.pending_day = day_index(now);
        p.click_day = p.pending_day;
        p.bump = ctx.bumps.player;
        g.players = g.players.checked_add(1).ok_or(ClickerError::Overflow)?;
        Ok(())
    }

    pub fn set_session(ctx: Context<OwnerOnly>, session: Pubkey) -> Result<()> {
        ctx.accounts.player.session = session;
        Ok(())
    }

    /// One click, one transaction. Three per second, at most `click_cap_per_day` counted per day.
    pub fn click(ctx: Context<Act>, day: u64) -> Result<()> {
        let clock = Clock::get()?;
        require!(day == day_index(clock.unix_timestamp), ClickerError::WrongDay);
        let a = &mut *ctx.accounts;
        touch(&mut a.player, &mut a.game, &mut a.today, ctx.bumps.today, a.prev_day.as_mut(), &a.emission, &a.distributor, clock.unix_timestamp)?;
        let p = &mut a.player;
        if p.last_click_ts == clock.unix_timestamp {
            require!(p.clicks_this_sec < CLICKS_PER_SECOND, ClickerError::ClickTooFast);
            p.clicks_this_sec += 1;
        } else {
            p.last_click_ts = clock.unix_timestamp;
            p.clicks_this_sec = 1;
        }
        let today = day_index(clock.unix_timestamp);
        if p.click_day != today {
            p.click_day = today;
            p.clicks_today = 0;
        }
        require!(p.clicks_today < a.game.click_cap_per_day, ClickerError::DailyCapReached);
        p.clicks_today += 1;
        let gain = p.click_power_milli();
        p.cookies_milli = p.cookies_milli.checked_add(gain).ok_or(ClickerError::Overflow)?;
        p.lifetime_cookies_milli += gain as u128;
        p.lifetime_clicks += 1;
        p.pending_cookies_milli += gain as u128;
        p.pending_clicks += 1;
        a.today.cookies_milli += gain as u128;
        a.today.clicks += 1;
        a.game.total_clicks += 1;
        a.game.total_cookies_milli += gain as u128;
        Ok(())
    }

    /// Buy `count` units of a tier, one after the other at rising prices.
    pub fn buy(ctx: Context<Act>, day: u64, tier: u8, count: u8) -> Result<()> {
        require!((tier as usize) < TIERS, ClickerError::BadTier);
        require!(count >= 1 && count <= 20, ClickerError::BadCount);
        let now = Clock::get()?.unix_timestamp;
        require!(day == day_index(now), ClickerError::WrongDay);
        let a = &mut *ctx.accounts;
        touch(&mut a.player, &mut a.game, &mut a.today, ctx.bumps.today, a.prev_day.as_mut(), &a.emission, &a.distributor, now)?;
        let p = &mut a.player;
        let t = tier as usize;
        for _ in 0..count {
            let price = tier_price_milli(t, p.owned[t]).ok_or(ClickerError::Overflow)?;
            require!(p.cookies_milli >= price, ClickerError::NotEnoughCookies);
            p.cookies_milli -= price;
            p.owned[t] += 1;
            p.cps_milli = p.cps_milli.checked_add(TIER_CPS_MILLI[t]).ok_or(ClickerError::Overflow)?;
        }
        Ok(())
    }

    /// Accrue idle production and settle a finished day into claimable CRUMB.
    pub fn settle(ctx: Context<Act>, day: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(day == day_index(now), ClickerError::WrongDay);
        let a = &mut *ctx.accounts;
        touch(&mut a.player, &mut a.game, &mut a.today, ctx.bumps.today, a.prev_day.as_mut(), &a.emission, &a.distributor, now)
    }

    /// Mint every claimable CRUMB to the owner's wallet.
    pub fn claim(ctx: Context<Claim>, day: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(day == day_index(now), ClickerError::WrongDay);
        let today_bump = ctx.bumps.today;
        let a = &mut *ctx.accounts;
        touch(&mut a.player, &mut a.game, &mut a.today, today_bump, a.prev_day.as_mut(), &a.emission, &a.distributor, now)?;
        let amount = a.player.claimable;
        require!(amount > 0, ClickerError::NothingToClaim);
        let bump = a.game.minter_bump;
        let seeds: &[&[u8]] = &[MINTER_SEED, &[bump]];
        crumb_emission::cpi::mint(
            CpiContext::new_with_signer(
                a.emission_program.key(),
                crumb_emission::cpi::accounts::MintCrumb {
                    distributor_signer: a.minter.to_account_info(),
                    distributor: a.distributor.to_account_info(),
                    emission: a.emission.to_account_info(),
                    mint: a.crumb_mint.to_account_info(),
                    recipient: a.owner_crumb.to_account_info(),
                    token_program: a.token_program.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        a.player.claimed = a.player.claimed.checked_add(amount).ok_or(ClickerError::Overflow)?;
        a.player.claimable = 0;
        Ok(())
    }
}

pub fn day_index(ts: i64) -> u64 {
    (ts.max(0) / SECONDS_PER_DAY) as u64
}

/// Accrue idle production, roll the day, settle the previous day's share into claimable CRUMB.
fn touch<'info>(p: &mut Account<'info, Player>, g: &mut Account<'info, Game>, today: &mut Account<'info, Day>, today_bump: u8, prev: Option<&mut Account<'info, Day>>, emission: &Account<'info, Emission>, distributor: &Account<'info, Distributor>, now: i64) -> Result<()> {
    let today_idx = day_index(now);
    require!(today.day == 0 || today.day == today_idx, ClickerError::WrongDay);
    if today.day == 0 {
        // first transaction of the day creates the record and snapshots this game's pool
        today.day = today_idx;
        today.bump = today_bump;
        today.pool = distributor.daily_allowance(emission);
    }
    // settle a previous day
    if p.pending_day != today_idx {
        if p.pending_cookies_milli > 0 || p.pending_clicks > 0 {
            let d = prev.ok_or(ClickerError::SettleFirst)?;
            require!(d.day == p.pending_day, ClickerError::WrongDay);
            let pool = d.pool as u128;
            let mut earned: u128 = 0;
            if d.cookies_milli > 0 {
                earned += pool * (g.pool_cookie_bps as u128) / (BPS as u128) * p.pending_cookies_milli / d.cookies_milli;
            }
            if d.clicks > 0 {
                earned += pool * ((BPS - g.pool_cookie_bps as u64) as u128) / (BPS as u128) * (p.pending_clicks as u128) / (d.clicks as u128);
            }
            p.claimable = p.claimable.checked_add(earned.min(u64::MAX as u128) as u64).ok_or(ClickerError::Overflow)?;
            p.pending_cookies_milli = 0;
            p.pending_clicks = 0;
        }
        p.pending_day = today_idx;
    }
    // idle production since the last touch, credited to today
    let elapsed = (now - p.last_ts).clamp(0, OFFLINE_CAP_S) as u64;
    if elapsed > 0 && p.cps_milli > 0 {
        let produced = (p.cps_milli as u128) * (elapsed as u128);
        let produced64 = produced.min(u64::MAX as u128) as u64;
        p.cookies_milli = p.cookies_milli.saturating_add(produced64);
        p.lifetime_cookies_milli += produced;
        p.pending_cookies_milli += produced;
        today.cookies_milli += produced;
        g.total_cookies_milli += produced;
    }
    p.last_ts = now;
    Ok(())
}

#[derive(Accounts)]
pub struct InitGame<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Game::INIT_SPACE, seeds = [GAME_SEED], bump)]
    pub game: Account<'info, Game>,
    /// CHECK: PDA that signs mints at the emission program; registered there as a distributor
    #[account(seeds = [MINTER_SEED], bump)]
    pub minter: UncheckedAccount<'info>,
    pub emission: Account<'info, Emission>,
    /// CHECK: where start fees go
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED], bump = game.bump, has_one = admin)]
    pub game: Account<'info, Game>,
}

#[derive(Accounts)]
pub struct Start<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED], bump = game.bump, has_one = treasury, has_one = crumb_mint)]
    pub game: Account<'info, Game>,
    #[account(init, payer = owner, space = 8 + Player::INIT_SPACE, seeds = [PLAYER_SEED, owner.key().as_ref()], bump)]
    pub player: Account<'info, Player>,
    /// CHECK: checked against game.treasury
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut)]
    pub crumb_mint: Account<'info, Mint>,
    /// Needed only once the free slots are used up.
    #[account(mut, token::mint = crumb_mint, token::authority = owner)]
    pub owner_crumb: Option<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, owner.key().as_ref()], bump = player.bump, has_one = owner)]
    pub player: Account<'info, Player>,
}

/// Shared by click, buy and settle. `authority` is the owner or the session key. `day` is today's
/// index, checked against the clock in the handler; it only exists so the Day PDA can be derived.
#[derive(Accounts)]
#[instruction(day: u64)]
pub struct Act<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED], bump = game.bump, has_one = emission)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [PLAYER_SEED, player.owner.as_ref()], bump = player.bump, constraint = authority.key() == player.owner || authority.key() == player.session @ ClickerError::Unauthorized)]
    pub player: Account<'info, Player>,
    #[account(init_if_needed, payer = authority, space = 8 + Day::INIT_SPACE, seeds = [DAY_SEED, &day.to_le_bytes()], bump)]
    pub today: Account<'info, Day>,
    /// The record for `player.pending_day`, required when a finished day is still unsettled.
    #[account(seeds = [DAY_SEED, &prev_day.day.to_le_bytes()], bump = prev_day.bump)]
    pub prev_day: Option<Account<'info, Day>>,
    pub emission: Account<'info, Emission>,
    #[account(has_one = emission, constraint = distributor.signer == Pubkey::find_program_address(&[MINTER_SEED], &crate::ID).0)]
    pub distributor: Account<'info, Distributor>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(day: u64)]
pub struct Claim<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED], bump = game.bump, has_one = emission, has_one = crumb_mint)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [PLAYER_SEED, player.owner.as_ref()], bump = player.bump, has_one = owner, constraint = authority.key() == player.owner || authority.key() == player.session @ ClickerError::Unauthorized)]
    pub player: Account<'info, Player>,
    #[account(init_if_needed, payer = authority, space = 8 + Day::INIT_SPACE, seeds = [DAY_SEED, &day.to_le_bytes()], bump)]
    pub today: Account<'info, Day>,
    #[account(seeds = [DAY_SEED, &prev_day.day.to_le_bytes()], bump = prev_day.bump)]
    pub prev_day: Option<Account<'info, Day>>,
    #[account(mut)]
    pub emission: Account<'info, Emission>,
    #[account(mut, has_one = emission, constraint = distributor.signer == minter.key())]
    pub distributor: Account<'info, Distributor>,
    /// CHECK: the player's owner, receives the CRUMB
    pub owner: UncheckedAccount<'info>,
    /// CHECK: PDA signer registered as the distributor
    #[account(seeds = [MINTER_SEED], bump = game.minter_bump)]
    pub minter: UncheckedAccount<'info>,
    #[account(mut)]
    pub crumb_mint: Account<'info, Mint>,
    #[account(init_if_needed, payer = authority, associated_token::mint = crumb_mint, associated_token::authority = owner)]
    pub owner_crumb: Account<'info, TokenAccount>,
    pub emission_program: Program<'info, CrumbEmission>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
