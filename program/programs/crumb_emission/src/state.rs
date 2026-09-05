use anchor_lang::prelude::*;

pub const EMISSION_SEED: &[u8] = b"emission";
pub const DISTRIBUTOR_SEED: &[u8] = b"distributor";
pub const BPS: u16 = 10_000;

/// The one CRUMB emission schedule. Owns the mint authority.
#[account]
#[derive(InitSpace)]
pub struct Emission {
    pub authority: Pubkey,
    pub mint: Pubkey,
    /// Hard cap, base units (6 decimals).
    pub max_supply: u64,
    /// Daily pool while the first half of the supply is minted; halves per tranche.
    pub base_daily_pool: u64,
    /// Total minted through this program, base units.
    pub minted: u64,
    /// Sum of enabled distributor weights, must stay <= BPS.
    pub total_weight_bps: u16,
    pub distributors: u16,
    pub bump: u8,
}

impl Emission {
    /// How many halvings have happened: k such that minted >= max * (1 - 1/2^k).
    pub fn tranche(&self) -> u32 {
        let remaining = self.max_supply.saturating_sub(self.minted);
        if remaining == 0 {
            return 64;
        }
        let mut k = 0u32;
        while k < 63 && remaining <= (self.max_supply >> (k + 1)) {
            k += 1;
        }
        k
    }

    /// Today's total pool across all distributors, base units. Zero once the supply is out.
    pub fn pool_now(&self) -> u64 {
        let k = self.tranche();
        if k >= 64 {
            return 0;
        }
        let pool = self.base_daily_pool >> k;
        pool.min(self.max_supply.saturating_sub(self.minted))
    }

    pub fn remaining(&self) -> u64 {
        self.max_supply.saturating_sub(self.minted)
    }
}

/// A program (or wallet) allowed to mint CRUMB, keyed by the signer it mints with.
#[account]
#[derive(InitSpace)]
pub struct Distributor {
    pub emission: Pubkey,
    /// The key that must sign `mint`. For a game this is one of its PDAs.
    pub signer: Pubkey,
    pub weight_bps: u16,
    pub enabled: bool,
    pub minted: u64,
    #[max_len(24)]
    pub name: String,
    pub bump: u8,
}

impl Distributor {
    /// This distributor's share of today's pool, base units.
    pub fn daily_allowance(&self, emission: &Emission) -> u64 {
        ((emission.pool_now() as u128) * (self.weight_bps as u128) / (BPS as u128)) as u64
    }
}
