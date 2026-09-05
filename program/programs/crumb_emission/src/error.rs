use anchor_lang::prelude::*;

#[error_code]
pub enum EmissionError {
    #[msg("the mint must have supply 0, 6 decimals and the authority as mint authority")]
    BadMint,
    #[msg("distributor weights would exceed 100%")]
    WeightOverflow,
    #[msg("distributor is disabled")]
    DistributorDisabled,
    #[msg("amount exceeds the remaining supply")]
    SupplyExhausted,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("name is longer than 24 bytes")]
    NameTooLong,
    #[msg("arithmetic overflow")]
    Overflow,
}
