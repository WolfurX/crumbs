use anchor_lang::prelude::*;

pub const GAME_SEED: &[u8] = b"game";
pub const PLAYER_SEED: &[u8] = b"player";
pub const DAY_SEED: &[u8] = b"day";
pub const MINTER_SEED: &[u8] = b"minter";
pub const TIERS: usize = 8;
pub const SECONDS_PER_DAY: i64 = 86_400;
/// Idle production is settled for at most this long away.
pub const OFFLINE_CAP_S: i64 = 7 * 86_400;
pub const BPS: u64 = 10_000;
/// Clicks accepted per player per wall-clock second. Slots are ~450 ms, so this is roughly one per
/// slot without punishing a click that lands in the same slot as the previous one.
pub const CLICKS_PER_SECOND: u8 = 3;
/// Cookies are stored in milli-cookies so a Cursor's 0.1 per second is an integer.
pub const MILLI: u64 = 1_000;
/// Every extra unit of a tier costs 15% more.
pub const GROWTH_NUM: u128 = 115;
pub const GROWTH_DEN: u128 = 100;
/// Hard ceiling on units per tier, keeps the price math in u128.
pub const MAX_UNITS: u16 = 400;

/// (base cost in cookies, cookies per second x 1000). Costs derive from payback targets, see sim/economy.py.
pub const TIER_COST: [u64; TIERS] = [120, 3_000, 60_000, 880_000, 12_000_000, 160_000_000, 2_300_000_000, 32_000_000_000];
pub const TIER_CPS_MILLI: [u64; TIERS] = [100, 1_000, 8_000, 47_000, 260_000, 1_400_000, 7_800_000, 44_000_000];
pub const TIER_NAMES: [&str; TIERS] = ["Cursor", "Grandma", "Oven", "Bakery", "Factory", "Validator", "Bridge", "Cookie Jar"];

/// Price of the next unit of a tier, in milli-cookies.
pub fn tier_price_milli(tier: usize, owned: u16) -> Option<u64> {
    if tier >= TIERS || owned >= MAX_UNITS {
        return None;
    }
    let mut p: u128 = (TIER_COST[tier] as u128) * (MILLI as u128);
    for _ in 0..owned {
        p = p.checked_mul(GROWTH_NUM)? / GROWTH_DEN;
        if p > u64::MAX as u128 {
            return None;
        }
    }
    Some(p as u64)
}

#[account]
#[derive(InitSpace)]
pub struct Game {
    pub admin: Pubkey,
    pub emission: Pubkey,
    pub crumb_mint: Pubkey,
    /// Lamports to the treasury on start, for every account.
    pub start_fee_lamports: u64,
    pub treasury: Pubkey,
    /// Accounts beyond this many burn CRUMB to start.
    pub free_slots: u64,
    /// CRUMB burned by account number free_slots, base units. Rises 10% per 100 accounts after.
    pub entry_burn_base: u64,
    pub click_cap_per_day: u16,
    /// Share of the daily pool split by cookies; the rest by counted clicks.
    pub pool_cookie_bps: u16,
    pub players: u64,
    pub total_clicks: u64,
    pub total_cookies_milli: u128,
    pub bump: u8,
    pub minter_bump: u8,
}

impl Game {
    /// CRUMB to burn for the next account, 0 while free slots remain.
    pub fn entry_burn(&self) -> u64 {
        if self.players < self.free_slots {
            return 0;
        }
        let steps = (self.players - self.free_slots) / 100;
        let mut b: u128 = self.entry_burn_base as u128;
        for _ in 0..steps.min(200) {
            b = b * 110 / 100;
        }
        b.min(u64::MAX as u128) as u64
    }
}

/// One record per UTC day. Totals are final once the day is over, which is what claims rely on.
#[account]
#[derive(InitSpace)]
pub struct Day {
    pub day: u64,
    pub cookies_milli: u128,
    pub clicks: u64,
    /// This game's CRUMB for the day, base units, snapshotted when the day record is created.
    pub pool: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Player {
    pub owner: Pubkey,
    /// Browser keypair allowed to click, buy and claim on the owner's behalf. Claims pay the owner.
    pub session: Pubkey,
    pub cookies_milli: u64,
    pub cps_milli: u64,
    pub owned: [u16; TIERS],
    pub lifetime_cookies_milli: u128,
    pub lifetime_clicks: u64,
    pub last_ts: i64,
    /// Second of the last click and how many clicks landed in it; at most CLICKS_PER_SECOND.
    pub last_click_ts: i64,
    pub clicks_this_sec: u8,
    pub click_day: u64,
    pub clicks_today: u16,
    /// Activity not yet settled into claimable CRUMB, attributed to `pending_day`.
    pub pending_day: u64,
    pub pending_cookies_milli: u128,
    pub pending_clicks: u64,
    pub claimable: u64,
    pub claimed: u64,
    pub bump: u8,
}

impl Player {
    pub fn click_power_milli(&self) -> u64 {
        // 1 cookie + 0.1% of production per second
        MILLI + self.cps_milli / 1_000
    }
}
