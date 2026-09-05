use {
    anchor_lang::{
        prelude::Pubkey,
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

const CRUMB: u64 = 1_000_000; // 6 decimals
const MAX: u64 = 100_000_000 * CRUMB;
const POOL: u64 = 100_000 * CRUMB;

fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) -> Result<(), String> {
    svm.expire_blockhash();
    let bh = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &bh);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?} logs={:?}", e.err, e.meta.logs))
}

fn setup() -> (LiteSVM, Keypair, Keypair, Pubkey) {
    let program_id = crumb_emission::id();
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/crumb_emission.so"));
    svm.add_program(program_id, bytes).unwrap();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
    // a fresh mint owned by admin, 6 decimals
    let mint = Keypair::new();
    let rent = svm.minimum_balance_for_rent_exemption(spl_token::state::Mint::LEN);
    let create = solana_system_interface::instruction::create_account(&admin.pubkey(), &mint.pubkey(), rent, spl_token::state::Mint::LEN as u64, &spl_token::id());
    let init = spl_token::instruction::initialize_mint2(&spl_token::id(), &mint.pubkey(), &admin.pubkey(), Some(&admin.pubkey()), 6).unwrap();
    send(&mut svm, &[create, init], &admin, &[&admin, &mint]).unwrap();
    let emission = Pubkey::find_program_address(&[crumb_emission::EMISSION_SEED], &program_id).0;
    (svm, admin, mint, emission)
}

fn initialize(svm: &mut LiteSVM, admin: &Keypair, mint: &Pubkey, emission: &Pubkey) -> Result<(), String> {
    let ix = Instruction::new_with_bytes(
        crumb_emission::id(),
        &crumb_emission::instruction::Initialize { max_supply: MAX, base_daily_pool: POOL }.data(),
        crumb_emission::accounts::Initialize { authority: admin.pubkey(), emission: *emission, mint: *mint, token_program: spl_token::id(), system_program: system_program::ID }.to_account_metas(None),
    );
    send(svm, &[ix], admin, &[admin])
}

fn emission_state(svm: &LiteSVM, emission: &Pubkey) -> crumb_emission::Emission {
    let acc = svm.get_account(emission).unwrap();
    crumb_emission::Emission::try_deserialize(&mut &acc.data[..]).unwrap()
}

#[test]
fn initialize_moves_mint_authority_to_pda() {
    let (mut svm, admin, mint, emission) = setup();
    initialize(&mut svm, &admin, &mint.pubkey(), &emission).unwrap();
    let e = emission_state(&svm, &emission);
    assert_eq!(e.max_supply, MAX);
    assert_eq!(e.minted, 0);
    assert_eq!(e.pool_now(), POOL);
    let m = svm.get_account(&mint.pubkey()).unwrap();
    let mint_state = spl_token::state::Mint::unpack(&m.data).unwrap();
    assert_eq!(mint_state.mint_authority.unwrap(), emission);
    assert!(mint_state.freeze_authority.is_none());
    // a second initialize must fail
    assert!(initialize(&mut svm, &admin, &mint.pubkey(), &emission).is_err());
}

#[test]
fn distributor_mints_within_cap_and_weights_are_bounded() {
    let (mut svm, admin, mint, emission) = setup();
    initialize(&mut svm, &admin, &mint.pubkey(), &emission).unwrap();
    let game = Keypair::new(); // stands in for a game's PDA signer
    svm.airdrop(&game.pubkey(), 1_000_000_000).unwrap();
    let distributor = Pubkey::find_program_address(&[crumb_emission::DISTRIBUTOR_SEED, game.pubkey().as_ref()], &crumb_emission::id()).0;
    let set = |svm: &mut LiteSVM, weight: u16, enabled: bool| {
        let ix = Instruction::new_with_bytes(
            crumb_emission::id(),
            &crumb_emission::instruction::SetDistributor { weight_bps: weight, enabled, name: "clicker".into() }.data(),
            crumb_emission::accounts::SetDistributor { authority: admin.pubkey(), emission, signer_key: game.pubkey(), distributor, system_program: system_program::ID }.to_account_metas(None),
        );
        send(svm, &[ix], &admin, &[&admin])
    };
    set(&mut svm, 10_000, true).unwrap();
    assert!(set(&mut svm, 10_001, true).is_err(), "over 100% must fail");
    set(&mut svm, 10_000, true).unwrap();
    assert_eq!(emission_state(&svm, &emission).total_weight_bps, 10_000);

    // recipient token account for a player
    let player = Keypair::new();
    let ata = spl_associated_token_account::get_associated_token_address(&player.pubkey(), &mint.pubkey());
    let create_ata = spl_associated_token_account::instruction::create_associated_token_account(&admin.pubkey(), &player.pubkey(), &mint.pubkey(), &spl_token::id());
    send(&mut svm, &[create_ata], &admin, &[&admin]).unwrap();

    let mint_ix = |amount: u64| Instruction::new_with_bytes(
        crumb_emission::id(),
        &crumb_emission::instruction::Mint { amount }.data(),
        crumb_emission::accounts::MintCrumb { distributor_signer: game.pubkey(), distributor, emission, mint: mint.pubkey(), recipient: ata, token_program: spl_token::id() }.to_account_metas(None),
    );
    send(&mut svm, &[mint_ix(5 * CRUMB)], &game, &[&game]).unwrap();
    let e = emission_state(&svm, &emission);
    assert_eq!(e.minted, 5 * CRUMB);
    let bal = spl_token::state::Account::unpack(&svm.get_account(&ata).unwrap().data).unwrap().amount;
    assert_eq!(bal, 5 * CRUMB);

    // a stranger cannot mint
    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let bad = Instruction::new_with_bytes(
        crumb_emission::id(),
        &crumb_emission::instruction::Mint { amount: CRUMB }.data(),
        crumb_emission::accounts::MintCrumb { distributor_signer: stranger.pubkey(), distributor, emission, mint: mint.pubkey(), recipient: ata, token_program: spl_token::id() }.to_account_metas(None),
    );
    assert!(send(&mut svm, &[bad], &stranger, &[&stranger]).is_err());

    // disabled distributor cannot mint; over-cap mint fails
    set(&mut svm, 10_000, false).unwrap();
    assert!(send(&mut svm, &[mint_ix(CRUMB)], &game, &[&game]).is_err());
    set(&mut svm, 10_000, true).unwrap();
    assert!(send(&mut svm, &[mint_ix(MAX)], &game, &[&game]).is_err(), "over the remaining supply");
}

#[test]
fn halving_follows_minted_supply_not_time() {
    let mut e = crumb_emission::Emission { authority: Pubkey::default(), mint: Pubkey::default(), max_supply: MAX, base_daily_pool: POOL, minted: 0, total_weight_bps: 0, distributors: 0, bump: 0 };
    assert_eq!(e.tranche(), 0);
    assert_eq!(e.pool_now(), POOL);
    e.minted = MAX / 2 - 1;
    assert_eq!(e.tranche(), 0);
    e.minted = MAX / 2;
    assert_eq!(e.tranche(), 1);
    assert_eq!(e.pool_now(), POOL / 2);
    e.minted = MAX / 2 + MAX / 4;
    assert_eq!(e.tranche(), 2);
    assert_eq!(e.pool_now(), POOL / 4);
    e.minted = MAX - 1;
    assert!(e.pool_now() <= 1);
    e.minted = MAX;
    assert_eq!(e.pool_now(), 0);
}
