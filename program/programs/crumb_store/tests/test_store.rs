use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::instruction::Instruction,
        InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) -> Result<(), String> {
    svm.expire_blockhash();
    let bh = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &bh);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?} logs={:?}", e.err, e.meta.logs))
}

fn world() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    svm.add_program(crumb_store::id(), include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/crumb_store.so"))).unwrap();
    let uploader = Keypair::new();
    svm.airdrop(&uploader.pubkey(), 100_000_000_000).unwrap();
    (svm, uploader)
}

/// Client-side creation: system create_account with the program as owner, then init.
fn create_blob(svm: &mut LiteSVM, uploader: &Keypair, size: usize, mime: &str) -> Result<Keypair, String> {
    let blob = Keypair::new();
    let space = crumb_store::HEADER + size;
    let lamports = svm.minimum_balance_for_rent_exemption(space);
    let create = solana_system_interface::instruction::create_account(&uploader.pubkey(), &blob.pubkey(), lamports, space as u64, &crumb_store::id());
    let init = Instruction::new_with_bytes(
        crumb_store::id(),
        &crumb_store::instruction::Init { mime: mime.to_string() }.data(),
        crumb_store::accounts::Init { blob: blob.pubkey(), authority: uploader.pubkey() }.to_account_metas(None),
    );
    send(svm, &[create, init], uploader, &[uploader, &blob])?;
    Ok(blob)
}

fn write(svm: &mut LiteSVM, signer: &Keypair, blob: &Pubkey, offset: u32, bytes: Vec<u8>) -> Result<(), String> {
    let ix = Instruction::new_with_bytes(
        crumb_store::id(),
        &crumb_store::instruction::Write { offset, bytes }.data(),
        crumb_store::accounts::Authorized { blob: *blob, authority: signer.pubkey() }.to_account_metas(None),
    );
    send(svm, &[ix], signer, &[signer])
}

fn finalize(svm: &mut LiteSVM, signer: &Keypair, blob: &Pubkey, new_authority: Pubkey) -> Result<(), String> {
    let ix = Instruction::new_with_bytes(
        crumb_store::id(),
        &crumb_store::instruction::Finalize { new_authority }.data(),
        crumb_store::accounts::Authorized { blob: *blob, authority: signer.pubkey() }.to_account_metas(None),
    );
    send(svm, &[ix], signer, &[signer])
}

fn close(svm: &mut LiteSVM, signer: &Keypair, blob: &Pubkey, recipient: Pubkey) -> Result<(), String> {
    let ix = Instruction::new_with_bytes(
        crumb_store::id(),
        &crumb_store::instruction::Close {}.data(),
        crumb_store::accounts::Close { blob: *blob, authority: signer.pubkey(), recipient }.to_account_metas(None),
    );
    send(svm, &[ix], signer, &[signer])
}

#[test]
fn upload_finalize_read_back() {
    let (mut svm, uploader) = world();
    let payload: Vec<u8> = (0..2500u32).map(|i| (i * 7 % 251) as u8).collect();
    let blob = create_blob(&mut svm, &uploader, payload.len(), "image/webp").unwrap();
    // three chunks, out of order, 1000 bytes each
    write(&mut svm, &uploader, &blob.pubkey(), 2000, payload[2000..].to_vec()).unwrap();
    write(&mut svm, &uploader, &blob.pubkey(), 0, payload[..1000].to_vec()).unwrap();
    write(&mut svm, &uploader, &blob.pubkey(), 1000, payload[1000..2000].to_vec()).unwrap();
    let owner = Keypair::new();
    finalize(&mut svm, &uploader, &blob.pubkey(), owner.pubkey()).unwrap();
    let acc = svm.get_account(&blob.pubkey()).unwrap();
    assert_eq!(acc.owner, crumb_store::id());
    assert_eq!(&acc.data[..8], b"crumblob");
    assert_eq!(&acc.data[8..40], owner.pubkey().as_ref(), "authority handed over");
    assert_eq!(u32::from_le_bytes(acc.data[40..44].try_into().unwrap()), 2500);
    assert_eq!(acc.data[44], 1, "finalized");
    assert_eq!(acc.data[45] as usize, "image/webp".len());
    assert_eq!(&acc.data[46..46 + 10], b"image/webp");
    assert_eq!(&acc.data[crumb_store::HEADER..], &payload[..]);
}

#[test]
fn guards() {
    let (mut svm, uploader) = world();
    let blob = create_blob(&mut svm, &uploader, 1500, "application/json").unwrap();
    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    // wrong authority
    let e = write(&mut svm, &stranger, &blob.pubkey(), 0, vec![1; 10]).unwrap_err();
    assert!(e.contains("6004") || e.contains("WrongAuthority"), "{e}");
    // past the end
    let e = write(&mut svm, &uploader, &blob.pubkey(), 1000, vec![1; 501]).unwrap_err();
    assert!(e.contains("6006") || e.contains("OutOfRange"), "{e}");
    // exactly to the end is fine
    write(&mut svm, &uploader, &blob.pubkey(), 1000, vec![1; 500]).unwrap();
    // init twice
    let init = Instruction::new_with_bytes(
        crumb_store::id(),
        &crumb_store::instruction::Init { mime: "x".into() }.data(),
        crumb_store::accounts::Init { blob: blob.pubkey(), authority: uploader.pubkey() }.to_account_metas(None),
    );
    let e = send(&mut svm, &[init], &uploader, &[&uploader]).unwrap_err();
    assert!(e.contains("6002") || e.contains("AlreadyInitialized"), "{e}");
    // finalize, then no more writes, and the old authority is out
    let owner = Keypair::new();
    svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();
    finalize(&mut svm, &uploader, &blob.pubkey(), owner.pubkey()).unwrap();
    let e = write(&mut svm, &uploader, &blob.pubkey(), 0, vec![2; 10]).unwrap_err();
    assert!(e.contains("6004") || e.contains("WrongAuthority"), "{e}");
    let e = write(&mut svm, &owner, &blob.pubkey(), 0, vec![2; 10]).unwrap_err();
    assert!(e.contains("6005") || e.contains("Finalized"), "{e}");
    // mime too long
    let e = create_blob(&mut svm, &uploader, 10, &"m".repeat(33)).unwrap_err();
    assert!(e.contains("6000") || e.contains("BadMime"), "{e}");
}

#[test]
fn close_returns_rent() {
    let (mut svm, uploader) = world();
    let blob = create_blob(&mut svm, &uploader, 20_000, "image/webp").unwrap();
    let rent = svm.get_account(&blob.pubkey()).unwrap().lamports;
    let recipient = Keypair::new();
    let stranger = Keypair::new();
    svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    assert!(close(&mut svm, &stranger, &blob.pubkey(), recipient.pubkey()).is_err());
    close(&mut svm, &uploader, &blob.pubkey(), recipient.pubkey()).unwrap();
    assert_eq!(svm.get_account(&recipient.pubkey()).unwrap().lamports, rent);
    let gone = svm.get_account(&blob.pubkey());
    assert!(gone.is_none() || gone.unwrap().data.is_empty());
}
