use anchor_lang::prelude::*;

#[error_code]
pub enum ClickerError {
    #[msg("only the owner or the session key may act for this player")]
    Unauthorized,
    #[msg("one click per slot")]
    ClickTooFast,
    #[msg("daily click cap reached, come back tomorrow")]
    DailyCapReached,
    #[msg("not enough cookies")]
    NotEnoughCookies,
    #[msg("unknown tier")]
    BadTier,
    #[msg("count must be between 1 and 20")]
    BadCount,
    #[msg("the day record passed does not match")]
    WrongDay,
    #[msg("pending activity from a previous day must be settled first")]
    SettleFirst,
    #[msg("nothing to claim")]
    NothingToClaim,
    #[msg("the current day is not over yet")]
    DayNotOver,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("bad configuration value")]
    BadConfig,
}
