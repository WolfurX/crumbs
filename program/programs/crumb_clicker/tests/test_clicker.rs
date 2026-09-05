use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    anchor_lang::solana_program::program_pack::Pack,
};

const CRUMB: u64 = 1_000_000;
const MAX: u64 = 100_000_000 * CRUMB;
const POOL: u64 = 100_000 * CRUMB;
const DAY: i64 = 86_400;

struct World {
    svm: LiteSVM,
    admin: Keypair,
    mint: Pubkey,
    emission: Pubkey,
    distributor: Pubkey,
    game: Pubkey,
    minter: Pubkey,
    slot: u64,
    ts: i64,
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) -> Result<(), String> {
    svm.expire_blockhash();
    let bh = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &bh);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?} logs={:?}", e.err, e.meta.logs))
}

impl World {
    fn tick(&mut self, slots: u64, seconds: i64) {
        self.slot += slots;
        self.ts += seconds;
        self.svm.warp_to_slot(self.slot);
        let mut clock: Clock = self.svm.get_sysvar();
        clock.slot = self.slot;
        clock.unix_timestamp = self.ts;
        self.svm.set_sysvar(&clock);
        self.svm.expire_blockhash();
    }
    fn day(&self) -> u64 { crumb_clicker::day_index(self.ts) }
    fn day_pda(&self, d: u64) -> Pubkey { Pubkey::find_program_address(&[crumb_clicker::DAY_SEED, &d.to_le_bytes()], &crumb_clicker::id()).0 }
    fn player_pda(&self, owner: &Pubkey) -> Pubkey { Pubkey::find_program_address(&[crumb_clicker::PLAYER_SEED, owner.as_ref()], &crumb_clicker::id()).0 }
    fn player(&self, owner: &Pubkey) -> crumb_clicker::Player {
        let acc = self.svm.get_account(&self.player_pda(owner)).unwrap();
        crumb_clicker::Player::try_deserialize(&mut &acc.data[..]).unwrap()
    }
    fn act_accounts(&self, authority: Pubkey, owner: &Pubkey, prev: Option<u64>) -> crumb_clicker::accounts::Act {
        crumb_clicker::accounts::Act {
            authority, game: self.game, player: self.player_pda(owner), today: self.day_pda(self.day()),
            prev_day: prev.map(|d| self.day_pda(d)), emission: self.emission, distributor: self.distributor, system_program: system_program::ID,
        }
    }
    fn click(&mut self, signer: &Keypair, owner: &Pubkey, prev: Option<u64>) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(crumb_clicker::id(), &crumb_clicker::instruction::Click { day: self.day() }.data(), self.act_accounts(signer.pubkey(), owner, prev).to_account_metas(None));
        send(&mut self.svm, &[ix], signer, &[signer])
    }
    fn buy(&mut self, signer: &Keypair, owner: &Pubkey, tier: u8, count: u8) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(crumb_clicker::id(), &crumb_clicker::instruction::Buy { day: self.day(), tier, count }.data(), self.act_accounts(signer.pubkey(), owner, None).to_account_metas(None));
        send(&mut self.svm, &[ix], signer, &[signer])
    }
    fn settle(&mut self, signer: &Keypair, owner: &Pubkey, prev: Option<u64>) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(crumb_clicker::id(), &crumb_clicker::instruction::Settle { day: self.day() }.data(), self.act_accounts(signer.pubkey(), owner, prev).to_account_metas(None));
        send(&mut self.svm, &[ix], signer, &[signer])
    }
}

fn world() -> World {
    let mut svm = LiteSVM::new();
    svm.add_program(crumb_emission::id(), include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/crumb_emission.so"))).unwrap();
    svm.add_program(crumb_clicker::id(), include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/crumb_clicker.so"))).unwrap();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();
    let mint = Keypair::new();
    let rent = svm.minimum_balance_for_rent_exemption(spl_token::state::Mint::LEN);
    send(&mut svm, &[
        solana_system_interface::instruction::create_account(&admin.pubkey(), &mint.pubkey(), rent, spl_token::state::Mint::LEN as u64, &spl_token::id()),
        spl_token::instruction::initialize_mint2(&spl_token::id(), &mint.pubkey(), &admin.pubkey(), None, 6).unwrap(),
    ], &admin, &[&admin, &mint]).unwrap();
    let emission = Pubkey::find_program_address(&[crumb_emission::EMISSION_SEED], &crumb_emission::id()).0;
    send(&mut svm, &[Instruction::new_with_bytes(crumb_emission::id(), &crumb_emission::instruction::Initialize { max_supply: MAX, base_daily_pool: POOL }.data(),
        crumb_emission::accounts::Initialize { authority: admin.pubkey(), emission, mint: mint.pubkey(), token_program: spl_token::id(), system_program: system_program::ID }.to_account_metas(None))], &admin, &[&admin]).unwrap();
    let minter = Pubkey::find_program_address(&[crumb_clicker::MINTER_SEED], &crumb_clicker::id()).0;
    let distributor = Pubkey::find_program_address(&[crumb_emission::DISTRIBUTOR_SEED, minter.as_ref()], &crumb_emission::id()).0;
    send(&mut svm, &[Instruction::new_with_bytes(crumb_emission::id(), &crumb_emission::instruction::SetDistributor { weight_bps: 10_000, enabled: true, name: "clicker".into() }.data(),
        crumb_emission::accounts::SetDistributor { authority: admin.pubkey(), emission, signer_key: minter, distributor, system_program: system_program::ID }.to_account_metas(None))], &admin, &[&admin]).unwrap();
    let game = Pubkey::find_program_address(&[crumb_clicker::GAME_SEED], &crumb_clicker::id()).0;
    send(&mut svm, &[Instruction::new_with_bytes(crumb_clicker::id(),
        &crumb_clicker::instruction::InitGame { start_fee_lamports: 10_000_000, free_slots: 2, entry_burn_base: 10 * CRUMB, click_cap_per_day: 5, pool_cookie_bps: 7_000 }.data(),
        crumb_clicker::accounts::InitGame { admin: admin.pubkey(), game, minter, emission, treasury: admin.pubkey(), system_program: system_program::ID }.to_account_metas(None))], &admin, &[&admin]).unwrap();
    let mut w = World { svm, admin, mint: mint.pubkey(), emission, distributor, game, minter, slot: 100, ts: 1_800_000_000 };
    w.tick(0, 0);
    w
}

fn start(w: &mut World, owner: &Keypair, session: &Keypair, with_ata: bool) -> Result<(), String> {
    let ata = spl_associated_token_account::get_associated_token_address(&owner.pubkey(), &w.mint);
    let ix = Instruction::new_with_bytes(crumb_clicker::id(), &crumb_clicker::instruction::Start { session: session.pubkey() }.data(),
        crumb_clicker::accounts::Start { owner: owner.pubkey(), game: w.game, player: w.player_pda(&owner.pubkey()), treasury: w.admin.pubkey(), crumb_mint: w.mint,
            owner_crumb: if with_ata { Some(ata) } else { None }, token_program: spl_token::id(), system_program: system_program::ID }.to_account_metas(None));
    send(&mut w.svm, &[ix], owner, &[owner])
}

fn new_player(w: &mut World) -> (Keypair, Keypair) {
    let owner = Keypair::new();
    let session = Keypair::new();
    w.svm.airdrop(&owner.pubkey(), 5_000_000_000).unwrap();
    w.svm.airdrop(&session.pubkey(), 5_000_000_000).unwrap();
    (owner, session)
}

#[test]
fn click_rules_slot_and_daily_cap() {
    let mut w = world();
    let (owner, session) = new_player(&mut w);
    start(&mut w, &owner, &session, false).unwrap();
    let treasury_before = w.svm.get_balance(&w.admin.pubkey()).unwrap();
    assert!(treasury_before > 0);
    // session key clicks: three in the same second land, the fourth is rejected
    w.tick(1, 1);
    for _ in 0..3 { w.click(&session, &owner.pubkey(), None).unwrap(); w.tick(1, 0); }
    assert!(w.click(&session, &owner.pubkey(), None).is_err(), "fourth click in one second must fail");
    let p = w.player(&owner.pubkey());
    assert_eq!(p.lifetime_clicks, 3);
    assert_eq!(p.cookies_milli, 3_000);
    // a stranger cannot click for this player
    let stranger = Keypair::new();
    w.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    w.tick(1, 1);
    assert!(w.click(&stranger, &owner.pubkey(), None).is_err());
    // cap of 5 per day (test config): three landed already, two more, then the sixth fails
    for _ in 0..2 { w.tick(1, 1); w.click(&session, &owner.pubkey(), None).unwrap(); }
    w.tick(1, 1);
    assert!(w.click(&session, &owner.pubkey(), None).is_err(), "sixth click of the day must fail");
    assert_eq!(w.player(&owner.pubkey()).lifetime_clicks, 5);
}

#[test]
fn buy_accrues_and_costs_rise() {
    let mut w = world();
    let (owner, session) = new_player(&mut w);
    start(&mut w, &owner, &session, false).unwrap();
    // 5 clicks -> 5 cookies; a cursor costs 120: not enough
    for _ in 0..5 { w.tick(1, 1); w.click(&session, &owner.pubkey(), None).unwrap(); }
    assert!(w.buy(&session, &owner.pubkey(), 0, 1).is_err());
    // cheat the balance for the test: give the player cookies by minting? no: raise the cap instead via a fresh world is expensive,
    // so we fast-forward with a cursor bought after enough clicks over several days
    let mut day = w.day();
    let mut prev: Option<u64> = None;
    for _ in 0..30 {
        w.tick(2000, DAY); // next day
        let today = w.day();
        prev = if today != day { Some(day) } else { prev };
        for _ in 0..5 { w.tick(1, 1); w.click(&session, &owner.pubkey(), prev).unwrap(); prev = None; }
        day = w.day();
    }
    let p = w.player(&owner.pubkey());
    assert!(p.cookies_milli >= 120_000, "150 cookies after 30 days of 5 clicks");
    w.buy(&session, &owner.pubkey(), 0, 1).unwrap();
    let p = w.player(&owner.pubkey());
    assert_eq!(p.owned[0], 1);
    assert_eq!(p.cps_milli, 100);
    assert_eq!(crumb_clicker::tier_price_milli(0, 1).unwrap(), 138_000, "second cursor costs 15% more");
    // idle: one hour later the cursor produced 360 cookies
    w.tick(8000, 3600);
    w.settle(&session, &owner.pubkey(), None).unwrap();
    let p2 = w.player(&owner.pubkey());
    assert_eq!(p2.cookies_milli - p.cookies_milli, 100 * 3600);
}

#[test]
fn day_settles_into_crumb_and_claims_mint() {
    let mut w = world();
    let (a_owner, a_sess) = new_player(&mut w);
    let (b_owner, b_sess) = new_player(&mut w);
    start(&mut w, &a_owner, &a_sess, false).unwrap();
    start(&mut w, &b_owner, &b_sess, false).unwrap();
    let d0 = w.day();
    // A clicks 4 times, B clicks 1 time on day 0: A has 80% of clicks and 80% of cookies
    for _ in 0..4 { w.tick(1, 1); w.click(&a_sess, &a_owner.pubkey(), None).unwrap(); }
    w.tick(1, 1); w.click(&b_sess, &b_owner.pubkey(), None).unwrap();
    // next day: settle both with the day-0 record
    w.tick(2000, DAY);
    w.settle(&a_sess, &a_owner.pubkey(), Some(d0)).unwrap();
    w.settle(&b_sess, &b_owner.pubkey(), Some(d0)).unwrap();
    let a = w.player(&a_owner.pubkey());
    let b = w.player(&b_owner.pubkey());
    assert_eq!(a.claimable + b.claimable <= POOL, true);
    assert!(a.claimable > POOL * 79 / 100 && a.claimable <= POOL * 80 / 100, "A gets 80%: {}", a.claimable);
    assert!(b.claimable > POOL * 19 / 100 && b.claimable <= POOL * 20 / 100, "B gets 20%: {}", b.claimable);
    // settling without the previous day record fails when there is pending activity
    let d1 = w.day();
    w.tick(1, 1); w.click(&a_sess, &a_owner.pubkey(), None).unwrap();
    w.tick(2000, DAY);
    assert!(w.settle(&a_sess, &a_owner.pubkey(), None).is_err(), "needs day-1 record");
    w.settle(&a_sess, &a_owner.pubkey(), Some(d1)).unwrap();
    // claim mints to the owner's wallet, paid for by the session key
    let ata = spl_associated_token_account::get_associated_token_address(&a_owner.pubkey(), &w.mint);
    let claimable = w.player(&a_owner.pubkey()).claimable;
    let ix = Instruction::new_with_bytes(crumb_clicker::id(), &crumb_clicker::instruction::Claim { day: w.day() }.data(),
        crumb_clicker::accounts::Claim { authority: a_sess.pubkey(), game: w.game, player: w.player_pda(&a_owner.pubkey()), today: w.day_pda(w.day()), prev_day: None,
            emission: w.emission, distributor: w.distributor, owner: a_owner.pubkey(), minter: w.minter, crumb_mint: w.mint, owner_crumb: ata,
            emission_program: crumb_emission::id(), token_program: spl_token::id(), associated_token_program: spl_associated_token_account::id(), system_program: system_program::ID }.to_account_metas(None));
    send(&mut w.svm, &[ix], &a_sess, &[&a_sess]).unwrap();
    let bal = spl_token::state::Account::unpack(&w.svm.get_account(&ata).unwrap().data).unwrap().amount;
    assert_eq!(bal, claimable);
    let p = w.player(&a_owner.pubkey());
    assert_eq!(p.claimable, 0);
    assert_eq!(p.claimed, claimable);
    let e = crumb_emission::Emission::try_deserialize(&mut &w.svm.get_account(&w.emission).unwrap().data[..]).unwrap();
    assert_eq!(e.minted, claimable);
}

#[test]
fn entry_burn_after_free_slots() {
    let mut w = world();
    // free_slots = 2 in the test config
    let (o1, s1) = new_player(&mut w); start(&mut w, &o1, &s1, false).unwrap();
    let (o2, s2) = new_player(&mut w); start(&mut w, &o2, &s2, false).unwrap();
    let (o3, s3) = new_player(&mut w);
    // third player has no CRUMB: fails without a token account, and with an empty one
    assert!(start(&mut w, &o3, &s3, false).is_err());
    let ata = spl_associated_token_account::get_associated_token_address(&o3.pubkey(), &w.mint);
    send(&mut w.svm, &[spl_associated_token_account::instruction::create_associated_token_account(&w.admin.pubkey(), &o3.pubkey(), &w.mint, &spl_token::id())], &w.admin, &[&w.admin]).unwrap();
    assert!(start(&mut w, &o3, &s3, true).is_err(), "no CRUMB to burn");
    let game = crumb_clicker::Game::try_deserialize(&mut &w.svm.get_account(&w.game).unwrap().data[..]).unwrap();
    assert_eq!(game.entry_burn(), 10 * CRUMB);
}
