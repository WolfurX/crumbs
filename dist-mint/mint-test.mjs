import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { MINT_SIZE, createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction, createMintToInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { Buffer as Buffer$1 } from "buffer";
//#region src/lib/chain.ts
var RPC_URL = "https://rpc.cookiescan.io";
var DAS_URL = "https://api.cookiescan.io";
var TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
//#endregion
//#region src/lib/txs.ts
/** Turn an RPC/program error into one line a person can act on. */
function explainError(e) {
	const msg = e instanceof Error ? e.message : String(e);
	const blob = `${msg} ${e?.logs?.join(" ") ?? ""}`;
	if (/insufficient lamports|insufficient funds for rent/i.test(blob)) return "Not enough COOK to pay fees and account rent.";
	if (/insufficient funds|custom program error: 0x1\b/i.test(blob)) return "Not enough of the token in your wallet.";
	if (/User rejected|rejected the request|declined/i.test(blob)) return "You declined the signature in the wallet.";
	if (/Blockhash not found|block height exceeded/i.test(blob)) return "The transaction expired before it landed. Retry it.";
	if (/frozen|0x11\b/i.test(blob)) return "A token account in this batch is frozen.";
	return msg.length > 160 ? msg.slice(0, 157) + "…" : msg;
}
var crumb_store_default = {
	address: "A9bmhLfaJRUQKQvRktrtztg1w3hoRjp5UVc5TUhcaq2J",
	metadata: {
		"name": "crumb_store",
		"version": "0.1.0",
		"spec": "0.1.0",
		"description": "Raw byte blobs on Cookie Chain: NFT pictures and metadata for the Crumbs Mint tab"
	},
	instructions: [
		{
			"name": "close",
			"docs": ["Return the rent to the recipient and drop the account."],
			"discriminator": [
				98,
				165,
				201,
				177,
				108,
				65,
				206,
				96
			],
			"accounts": [
				{
					"name": "blob",
					"writable": true
				},
				{
					"name": "authority",
					"signer": true
				},
				{
					"name": "recipient",
					"writable": true
				}
			],
			"args": []
		},
		{
			"name": "finalize",
			"docs": ["Freeze the blob and hand the authority to its long-term owner."],
			"discriminator": [
				171,
				61,
				218,
				56,
				127,
				115,
				12,
				217
			],
			"accounts": [{
				"name": "blob",
				"writable": true
			}, {
				"name": "authority",
				"signer": true
			}],
			"args": [{
				"name": "new_authority",
				"type": "pubkey"
			}]
		},
		{
			"name": "init",
			"docs": ["Write the header into a freshly created, zeroed account owned by this program."],
			"discriminator": [
				220,
				59,
				207,
				236,
				108,
				250,
				47,
				100
			],
			"accounts": [{
				"name": "blob",
				"writable": true
			}, {
				"name": "authority",
				"signer": true
			}],
			"args": [{
				"name": "mime",
				"type": "string"
			}]
		},
		{
			"name": "write",
			"docs": ["Copy a chunk into the data region."],
			"discriminator": [
				235,
				116,
				91,
				200,
				206,
				170,
				144,
				120
			],
			"accounts": [{
				"name": "blob",
				"writable": true
			}, {
				"name": "authority",
				"signer": true
			}],
			"args": [{
				"name": "offset",
				"type": "u32"
			}, {
				"name": "bytes",
				"type": "bytes"
			}]
		}
	],
	errors: [
		{
			"code": 6e3,
			"name": "BadMime",
			"msg": "mime type must be 1 to 32 bytes"
		},
		{
			"code": 6001,
			"name": "TooSmall",
			"msg": "account too small for the header"
		},
		{
			"code": 6002,
			"name": "AlreadyInitialized",
			"msg": "blob already initialized"
		},
		{
			"code": 6003,
			"name": "NotInitialized",
			"msg": "blob not initialized"
		},
		{
			"code": 6004,
			"name": "WrongAuthority",
			"msg": "wrong authority"
		},
		{
			"code": 6005,
			"name": "Finalized",
			"msg": "blob is finalized"
		},
		{
			"code": 6006,
			"name": "OutOfRange",
			"msg": "write out of range"
		}
	]
};
//#endregion
//#region src/game/codec.ts
/** Build an instruction from the IDL's account order; pass pubkeys by account name, omit optionals to send the program id. */
function buildIx(idl, name, args, keys) {
	const ix = idl.instructions.find((i) => i.name === name);
	if (!ix) throw new Error(`no instruction ${name}`);
	const programId = new PublicKey(idl.address);
	const metas = ix.accounts.map((a) => {
		const k = keys[a.name] ?? (a.address ? new PublicKey(a.address) : void 0);
		if (!k) {
			if (a.optional) return {
				pubkey: programId,
				isSigner: false,
				isWritable: false
			};
			throw new Error(`missing account ${a.name} for ${name}`);
		}
		return {
			pubkey: k,
			isSigner: !!a.signer,
			isWritable: !!a.writable
		};
	});
	return new TransactionInstruction({
		programId,
		keys: metas,
		data: Buffer$1.concat([Buffer$1.from(ix.discriminator), ...args.map((a) => Buffer$1.from(a))])
	});
}
//#endregion
//#region src/mint/blob.ts
var STORE_PROGRAM = new PublicKey(crumb_store_default.address);
/** Bytes per write transaction: 1232 minus ~220 of envelope, rounded down. */
var CHUNK = 1e3;
/** Where finalized blobs are served from. Fixed to production so mints from the Pages mirror work too. */
var GATEWAY = "https://crumbs-cookie.vercel.app";
var blobUrl = (blob) => `${GATEWAY}/s/${typeof blob === "string" ? blob : blob.toBase58()}`;
var u32$1 = (n) => {
	const b = /* @__PURE__ */ new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, n, true);
	return b;
};
var str$1 = (s) => {
	const d = new TextEncoder().encode(s);
	return new Uint8Array([...u32$1(d.length), ...d]);
};
var initIx = (blob, authority, mime) => buildIx(crumb_store_default, "init", [str$1(mime)], {
	blob,
	authority
});
var writeIx = (blob, authority, offset, bytes) => buildIx(crumb_store_default, "write", [
	u32$1(offset),
	u32$1(bytes.length),
	bytes
], {
	blob,
	authority
});
var finalizeIx = (blob, authority, newAuthority) => buildIx(crumb_store_default, "finalize", [newAuthority.toBytes()], {
	blob,
	authority
});
var blobRent = (connection, size) => connection.getMinimumBalanceForRentExemption(96 + size);
var chunksOf = (size) => size <= 700 ? 0 : Math.ceil(size / CHUNK);
/** Transactions an upload takes: create (+inline), writes, finalize. */
var txsOf = (size) => size <= 700 ? 1 : 2 + chunksOf(size);
function newUploadState() {
	const kp = Keypair.generate();
	return {
		pubkey: kp.publicKey.toBase58(),
		secret: bs58.encode(kp.secretKey),
		created: false,
		chunks: [],
		finalized: false
	};
}
/** Run up to n tasks at a time. */
async function pool(n, tasks) {
	const out = new Array(tasks.length);
	let next = 0;
	const worker = async () => {
		while (next < tasks.length) {
			const i = next++;
			out[i] = await tasks[i]();
		}
	};
	await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
	return out;
}
/** A blockhash shared by many transactions, refreshed every 20 s. */
function blockhashCache(connection) {
	let cur = null;
	return async (force = false) => {
		if (force || !cur || Date.now() - cur.at > 2e4) cur = {
			...await connection.getLatestBlockhash("confirmed"),
			at: Date.now()
		};
		return cur;
	};
}
async function sendSigned(connection, tx, bh) {
	const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
	const res = await connection.confirmTransaction({
		signature: sig,
		...bh
	}, "confirmed");
	if (res.value.err) throw new Error(`On-chain error: ${JSON.stringify(res.value.err)}`);
	return sig;
}
async function withRetries(f, tries = 4) {
	let last;
	for (let i = 0; i < tries; i++) try {
		return await f();
	} catch (e) {
		last = e;
		await new Promise((r) => setTimeout(r, 800 * (i + 1)));
	}
	throw last;
}
/** Create, fill, finalize. Idempotent: reruns skip what the state says already landed. */
async function uploadBlob(o) {
	const { connection, uploader, bytes, mime, owner, state, save } = o;
	const blobKp = Keypair.fromSecretKey(bs58.decode(state.secret));
	const blob = blobKp.publicKey;
	const nextBlockhash = blockhashCache(connection);
	const total = chunksOf(bytes.length);
	const inline = bytes.length <= 700;
	const progress = () => o.onProgress?.(state.chunks.length, total);
	if (!state.created) {
		if (!await connection.getAccountInfo(blob, "confirmed")) {
			const lamports = await blobRent(connection, bytes.length);
			const ixs = [SystemProgram.createAccount({
				fromPubkey: uploader.publicKey,
				newAccountPubkey: blob,
				lamports,
				space: 96 + bytes.length,
				programId: STORE_PROGRAM
			}), initIx(blob, uploader.publicKey, mime)];
			if (inline) ixs.push(writeIx(blob, uploader.publicKey, 0, bytes), finalizeIx(blob, uploader.publicKey, owner));
			await withRetries(async () => {
				const bh = await nextBlockhash();
				const tx = new Transaction({
					feePayer: uploader.publicKey,
					recentBlockhash: bh.blockhash
				}).add(...ixs);
				tx.sign(uploader, blobKp);
				await sendSigned(connection, tx, bh);
			});
		}
		state.created = true;
		if (inline) state.finalized = true;
		save();
	}
	if (!inline) {
		const done = new Set(state.chunks);
		const pending = Array.from({ length: total }, (_, i) => i).filter((i) => !done.has(i));
		await pool(o.concurrency ?? 12, pending.map((i) => async () => {
			await withRetries(async () => {
				const bh = await nextBlockhash();
				const tx = new Transaction({
					feePayer: uploader.publicKey,
					recentBlockhash: bh.blockhash
				}).add(writeIx(blob, uploader.publicKey, i * CHUNK, bytes.subarray(i * CHUNK, (i + 1) * CHUNK)));
				tx.sign(uploader);
				await sendSigned(connection, tx, bh);
			});
			state.chunks.push(i);
			save();
			progress();
		}));
		if (!state.finalized) {
			await withRetries(async () => {
				const bh = await nextBlockhash();
				const tx = new Transaction({
					feePayer: uploader.publicKey,
					recentBlockhash: bh.blockhash
				}).add(finalizeIx(blob, uploader.publicKey, owner));
				tx.sign(uploader);
				await sendSigned(connection, tx, bh);
			});
			state.finalized = true;
			save();
		}
	}
	return blob;
}
/** Read a blob back from the chain (for verification scripts). */
async function readBlob(connection, blob) {
	const info = await connection.getAccountInfo(blob, "confirmed");
	if (!info || !info.owner.equals(STORE_PROGRAM)) return null;
	const d = info.data;
	if (Buffer$1.from(d.subarray(0, 8)).toString("latin1") !== "crumblob") return null;
	const len = new DataView(d.buffer, d.byteOffset).getUint32(40, true);
	return {
		mime: Buffer$1.from(d.subarray(46, 46 + d[45])).toString("latin1"),
		finalized: d[44] === 1,
		authority: new PublicKey(d.subarray(8, 40)),
		bytes: d.subarray(96, 96 + len)
	};
}
//#endregion
//#region src/mint/tm.ts
var METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
var metadataPda = (mint) => PublicKey.findProgramAddressSync([
	Buffer$1.from("metadata"),
	METADATA_PROGRAM.toBuffer(),
	mint.toBuffer()
], METADATA_PROGRAM)[0];
var editionPda = (mint) => PublicKey.findProgramAddressSync([
	Buffer$1.from("metadata"),
	METADATA_PROGRAM.toBuffer(),
	mint.toBuffer(),
	Buffer$1.from("edition")
], METADATA_PROGRAM)[0];
var u8 = (n) => Buffer$1.from([n & 255]);
var u16 = (n) => {
	const b = /* @__PURE__ */ new Uint8Array(2);
	new DataView(b.buffer).setUint16(0, n, true);
	return Buffer$1.from(b);
};
var u32 = (n) => {
	const b = /* @__PURE__ */ new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, n, true);
	return Buffer$1.from(b);
};
var u64 = (n) => {
	const b = /* @__PURE__ */ new Uint8Array(8);
	new DataView(b.buffer).setBigUint64(0, n, true);
	return Buffer$1.from(b);
};
var bool = (v) => Buffer$1.from([v ? 1 : 0]);
var str = (s) => {
	const d = Buffer$1.from(s, "utf8");
	return Buffer$1.concat([u32(d.length), d]);
};
var none = () => Buffer$1.from([0]);
var some = (b) => Buffer$1.concat([Buffer$1.from([1]), b]);
var meta$1 = (pubkey, isWritable = false, isSigner = false) => ({
	pubkey,
	isWritable,
	isSigner
});
/** CreateMetadataAccountV3 (discriminator 33). */
function createMetadataV3Ix(a) {
	if (Buffer$1.byteLength(a.name) > 32 || Buffer$1.byteLength(a.symbol) > 10 || Buffer$1.byteLength(a.uri) > 200) throw new Error("metadata field too long");
	const creators = a.creators.length ? some(Buffer$1.concat([u32(a.creators.length), ...a.creators.map((c) => Buffer$1.concat([
		c.address.toBuffer(),
		bool(c.verified),
		u8(c.share)
	]))])) : none();
	const collection = a.collection ? some(Buffer$1.concat([bool(false), a.collection.toBuffer()])) : none();
	const data = Buffer$1.concat([
		u8(33),
		str(a.name),
		str(a.symbol),
		str(a.uri),
		u16(a.sellerFeeBps),
		creators,
		collection,
		none(),
		bool(a.isMutable),
		none()
	]);
	return new TransactionInstruction({
		programId: METADATA_PROGRAM,
		data,
		keys: [
			meta$1(metadataPda(a.mint), true),
			meta$1(a.mint),
			meta$1(a.authority, false, true),
			meta$1(a.authority, true, true),
			meta$1(a.authority, false, true),
			meta$1(SystemProgram.programId),
			meta$1(SYSVAR_RENT_PUBKEY)
		]
	});
}
/** CreateMasterEditionV3 (discriminator 17), max supply 0: a one-of-one, no prints. */
function createMasterEditionV3Ix(mint, authority) {
	return new TransactionInstruction({
		programId: METADATA_PROGRAM,
		data: Buffer$1.concat([u8(17), some(u64(0n))]),
		keys: [
			meta$1(editionPda(mint), true),
			meta$1(mint, true),
			meta$1(authority, false, true),
			meta$1(authority, false, true),
			meta$1(authority, true, true),
			meta$1(metadataPda(mint), true),
			meta$1(TOKEN_PROGRAM),
			meta$1(SystemProgram.programId),
			meta$1(SYSVAR_RENT_PUBKEY)
		]
	});
}
/** Verify (discriminator 52) with VerificationArgs::CollectionV1; the collection's update authority signs. */
function verifyCollectionIx(itemMint, collectionMint, authority) {
	return new TransactionInstruction({
		programId: METADATA_PROGRAM,
		data: Buffer$1.concat([u8(52), u8(1)]),
		keys: [
			meta$1(authority, false, true),
			meta$1(METADATA_PROGRAM),
			meta$1(metadataPda(itemMint), true),
			meta$1(collectionMint),
			meta$1(metadataPda(collectionMint), true),
			meta$1(editionPda(collectionMint)),
			meta$1(SystemProgram.programId),
			meta$1(SYSVAR_INSTRUCTIONS_PUBKEY)
		]
	});
}
/** UpdateMetadataAccountV2 (discriminator 15) with only a new update authority: hands a piece to its creator. */
function setUpdateAuthorityIx(mint, currentAuthority, newAuthority) {
	return new TransactionInstruction({
		programId: METADATA_PROGRAM,
		data: Buffer$1.concat([
			u8(15),
			none(),
			some(newAuthority.toBuffer()),
			none(),
			none()
		]),
		keys: [meta$1(metadataPda(mint), true), meta$1(currentAuthority, false, true)]
	});
}
//#endregion
//#region src/mint/plan.ts
var MAX_PIECES = 1e3;
var FEE$1 = 5000n;
/** Metaplex keeps this in every new metadata account. */
var METAPLEX_CREATE_FEE = 10000000n;
var BUFFER = 10000000n;
var rentsCache = null;
function fetchRents(connection) {
	if (!rentsCache) rentsCache = (async () => {
		const [mint, ata, metadata, edition, b0, b1] = await Promise.all([
			connection.getMinimumBalanceForRentExemption(MINT_SIZE),
			connection.getMinimumBalanceForRentExemption(165),
			connection.getMinimumBalanceForRentExemption(607),
			connection.getMinimumBalanceForRentExemption(20),
			connection.getMinimumBalanceForRentExemption(96),
			connection.getMinimumBalanceForRentExemption(100096)
		]);
		return {
			mint: BigInt(mint),
			ata: BigInt(ata),
			metadata: BigInt(metadata) + METAPLEX_CREATE_FEE,
			edition: BigInt(edition),
			blobBase: BigInt(b0),
			blobPerByte: (BigInt(b1) - BigInt(b0)) / 100000n
		};
	})().catch((e) => {
		rentsCache = null;
		throw e;
	});
	return rentsCache;
}
var blobRentOf = (r, size) => r.blobBase + r.blobPerByte * BigInt(size);
var pieceName = (name, n) => `${name.trim()} #${n}`;
function pieceJson(form, n, imageBlob, mime) {
	const image = blobUrl(imageBlob);
	return JSON.stringify({
		name: n === null ? form.name.trim() : pieceName(form.name, n),
		symbol: form.symbol,
		description: form.description.trim(),
		image,
		external_url: `${GATEWAY}/`,
		attributes: [],
		properties: {
			files: [{
				uri: image,
				type: mime
			}],
			category: "image"
		}
	});
}
function estimate(r, form, imageSize, mime, count) {
	const labelSize = new TextEncoder().encode(pieceJson(form, MAX_PIECES, "1".repeat(44), mime)).length;
	const image = blobRentOf(r, imageSize);
	const labels = blobRentOf(r, labelSize) * BigInt(count + 1);
	const storeTxs = txsOf(imageSize) + (count + 1) * txsOf(labelSize) + 1;
	const mintTxs = count + 2;
	const pieces = (r.mint + r.ata + r.metadata + r.edition) * BigInt(count + 1);
	const fees = FEE$1 * BigInt(storeTxs + 2 * mintTxs + 2);
	const session = image + labels + pieces + fees + BUFFER;
	return {
		image,
		labels,
		pieces,
		fees,
		total: session,
		session,
		storeTxs,
		mintTxs
	};
}
//#endregion
//#region src/mint/engine.ts
var key = (owner) => `crumbs.drop.${typeof owner === "string" ? owner : owner.toBase58()}`;
function loadDrop(owner) {
	try {
		const raw = localStorage.getItem(key(owner));
		const s = raw ? JSON.parse(raw) : null;
		return s && s.v === 2 ? s : null;
	} catch {
		return null;
	}
}
function saveDrop(s) {
	s.updatedAt = Date.now();
	try {
		localStorage.setItem(key(s.owner), JSON.stringify(s));
	} catch {}
}
var b64 = {
	encode: (u) => {
		let s = "";
		for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768));
		return btoa(s);
	},
	decode: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
};
var newPiece = () => {
	const kp = Keypair.generate();
	return {
		mint: kp.publicKey.toBase58(),
		secret: bs58.encode(kp.secretKey),
		done: false
	};
};
function newDrop(owner, form, recipients, image) {
	const s = {
		v: 2,
		owner: owner.toBase58(),
		createdAt: Date.now(),
		updatedAt: Date.now(),
		form,
		recipients: recipients.map((r) => r.toBase58()),
		image: {
			mime: image.mime,
			b64: b64.encode(image.bytes),
			width: image.width,
			height: image.height
		},
		session: bs58.encode(Keypair.generate().secretKey),
		stage: "store",
		imageBlob: newUploadState(),
		collectionBlob: newUploadState(),
		pieceBlobs: recipients.map(() => newUploadState()),
		collection: newPiece(),
		pieces: recipients.map(() => newPiece())
	};
	saveDrop(s);
	return s;
}
var COLLECTION_UNITS = 22e4;
var PIECE_UNITS = 3e5;
var FEE = 5000n;
function progressOf(s, extra = {}) {
	const imageSize = Math.ceil(s.image.b64.length * 3 / 4);
	const chunksTotal = imageSize <= 700 ? 1 : Math.ceil(imageSize / 1e3);
	return {
		stage: s.stage,
		chunksDone: s.imageBlob.finalized ? chunksTotal : s.imageBlob.chunks.length,
		chunksTotal,
		labelsDone: (s.collectionBlob.finalized ? 1 : 0) + s.pieceBlobs.filter((b) => b.finalized).length,
		labelsTotal: s.pieceBlobs.length + 1,
		piecesDone: s.pieces.filter((p) => p.done).length,
		piecesTotal: s.pieces.length,
		...extra
	};
}
/** What the session key still needs for everything that has not landed yet. */
function remainingLamports(s, rents, imageSize) {
	const labelSize = 450;
	let need = 10000000n;
	if (!s.imageBlob.created) need += blobRentOf(rents, imageSize) + FEE * BigInt(2 + Math.ceil(imageSize / 1e3));
	else need += FEE * BigInt(1 + Math.ceil(imageSize / 1e3) - s.imageBlob.chunks.length);
	need += (blobRentOf(rents, labelSize) + FEE) * BigInt([s.collectionBlob, ...s.pieceBlobs].filter((b) => !b.created).length);
	const per = rents.mint + rents.ata + rents.metadata + rents.edition + FEE;
	need += per * BigInt([s.collection, ...s.pieces].filter((p) => !p.done).length);
	need += FEE * 2n;
	return need;
}
function mintTx(s, i, session, creator, rents, blockhash) {
	const piece = i === null ? s.collection : s.pieces[i];
	const mintKp = Keypair.fromSecretKey(bs58.decode(piece.secret));
	const mint = mintKp.publicKey;
	const recipient = i === null ? creator : new PublicKey(s.recipients[i]);
	const ata = getAssociatedTokenAddressSync(mint, recipient);
	const uri = blobUrl(i === null ? s.collectionBlob.pubkey : s.pieceBlobs[i].pubkey);
	const me = session.publicKey;
	const tx = new Transaction({
		feePayer: me,
		recentBlockhash: blockhash
	}).add(ComputeBudgetProgram.setComputeUnitLimit({ units: i === null ? COLLECTION_UNITS : PIECE_UNITS }), SystemProgram.createAccount({
		fromPubkey: me,
		newAccountPubkey: mint,
		lamports: Number(rents.mint),
		space: MINT_SIZE,
		programId: TOKEN_PROGRAM
	}), createInitializeMint2Instruction(mint, 0, me, me), createAssociatedTokenAccountIdempotentInstruction(me, ata, recipient, mint), createMintToInstruction(mint, ata, me, 1), createMetadataV3Ix({
		mint,
		authority: me,
		name: i === null ? s.form.name.trim() : pieceName(s.form.name, i + 1),
		symbol: s.form.symbol,
		uri,
		sellerFeeBps: s.form.royaltyBps,
		creators: [{
			address: creator,
			verified: false,
			share: 100
		}],
		collection: i === null ? void 0 : new PublicKey(s.collection.mint),
		isMutable: true
	}), createMasterEditionV3Ix(mint, me));
	if (i !== null) tx.add(verifyCollectionIx(mint, new PublicKey(s.collection.mint), me), setUpdateAuthorityIx(mint, me, creator));
	return {
		tx,
		mintKp
	};
}
/** The whole drop, resumable from whatever the saved state says already happened. */
async function runDrop(connection, wallet, s, hooks) {
	const creator = new PublicKey(s.owner);
	const session = Keypair.fromSecretKey(bs58.decode(s.session));
	const me = session.publicKey;
	const bytes = b64.decode(s.image.b64);
	const report = (extra = {}) => hooks.onProgress(progressOf(s, extra));
	const rents = await fetchRents(connection);
	const save = () => saveDrop(s);
	const nextBlockhash = blockhashCache(connection);
	const unknown = [s.collection, ...s.pieces].filter((p) => !p.done);
	for (let i = 0; i < unknown.length; i += 100) {
		const slice = unknown.slice(i, i + 100);
		(await connection.getMultipleAccountsInfo(slice.map((p) => new PublicKey(p.mint)), "confirmed")).forEach((info, j) => {
			if (info) slice[j].done = true;
		});
	}
	save();
	const balance = BigInt(await connection.getBalance(me, "confirmed"));
	const need = s.funded ? remainingLamports(s, rents, bytes.length) : estimate(rents, s.form, bytes.length, s.image.mime, s.pieces.length).session;
	if (balance < need) {
		const lamports = need - balance;
		report({ prompt: `Fund the drop, ${(Number(lamports) / 1e9).toFixed(2)} COOK` });
		const bh = await connection.getLatestBlockhash("confirmed");
		const tx = new Transaction({
			feePayer: creator,
			recentBlockhash: bh.blockhash
		}).add(SystemProgram.transfer({
			fromPubkey: creator,
			toPubkey: me,
			lamports
		}));
		let signed;
		try {
			signed = await wallet.signTransaction(tx);
		} catch (e) {
			throw new Error(explainError(e));
		}
		report({
			prompt: void 0,
			note: "Funding the drop"
		});
		s.funded = await sendSigned(connection, signed, bh);
		save();
	}
	report({ prompt: void 0 });
	if (s.stage === "store") {
		await uploadBlob({
			connection,
			uploader: session,
			bytes,
			mime: s.image.mime,
			owner: creator,
			state: s.imageBlob,
			save,
			onProgress: () => report()
		});
		report();
		await pool(8, [() => uploadBlob({
			connection,
			uploader: session,
			bytes: new TextEncoder().encode(pieceJson(s.form, null, s.imageBlob.pubkey, s.image.mime)),
			mime: "application/json",
			owner: creator,
			state: s.collectionBlob,
			save
		}), ...s.pieceBlobs.map((st, i) => () => uploadBlob({
			connection,
			uploader: session,
			bytes: new TextEncoder().encode(pieceJson(s.form, i + 1, s.imageBlob.pubkey, s.image.mime)),
			mime: "application/json",
			owner: creator,
			state: st,
			save
		}))].map((t) => async () => {
			await t();
			report();
		}));
		s.stage = "mint";
		save();
		report();
	}
	if (s.stage === "mint") {
		const sendPiece = async (i) => {
			const piece = i === null ? s.collection : s.pieces[i];
			if (piece.done) return;
			let last;
			for (let attempt = 0; attempt < 4; attempt++) try {
				const bh = await nextBlockhash(attempt > 0);
				const { tx, mintKp } = mintTx(s, i, session, creator, rents, bh.blockhash);
				tx.sign(session, mintKp);
				piece.sig = await sendSigned(connection, tx, bh);
				piece.done = true;
				save();
				report();
				return;
			} catch (e) {
				last = e;
				if (await connection.getAccountInfo(new PublicKey(piece.mint), "confirmed")) {
					piece.done = true;
					save();
					report();
					return;
				}
				const logs = (e.logs ?? []).filter((l) => /failed|error|Error/i.test(l)).slice(-3).join(" · ");
				report({ note: `${i === null ? "The collection" : `Piece ${i + 1}`} didn't land, sending again: ${explainError(e)}${logs ? ` [${logs}]` : ""}` });
				await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
			}
			throw new Error(`${i === null ? "The collection" : `Piece ${i + 1}`} kept failing: ${explainError(last)}`);
		};
		await sendPiece(null);
		await pool(8, s.pieces.map((_, i) => () => sendPiece(i)));
		if (!s.handedOver) {
			const bh = await nextBlockhash();
			const tx = new Transaction({
				feePayer: me,
				recentBlockhash: bh.blockhash
			}).add(setUpdateAuthorityIx(new PublicKey(s.collection.mint), me, creator));
			tx.sign(session);
			await sendSigned(connection, tx, bh);
			s.handedOver = true;
			save();
		}
		s.stage = "done";
		save();
	}
	if (!s.refunded) {
		const left = BigInt(await connection.getBalance(me, "confirmed"));
		if (left > FEE) try {
			const bh = await connection.getLatestBlockhash("confirmed");
			const tx = new Transaction({
				feePayer: me,
				recentBlockhash: bh.blockhash
			}).add(SystemProgram.transfer({
				fromPubkey: me,
				toPubkey: creator,
				lamports: left - FEE
			}));
			tx.sign(session);
			await sendSigned(connection, tx, bh);
		} catch {}
		s.refunded = true;
		save();
	}
	report();
}
//#endregion
//#region scripts/mint-test.ts
var STATE_FILE = `${process.env.HOME}/.config/crumbs/mint-test-state.json`;
var mem = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
globalThis.localStorage = {
	getItem: (k) => mem[k] ?? null,
	setItem: (k, v) => {
		mem[k] = v;
		writeFileSync(STATE_FILE, JSON.stringify(mem));
	},
	removeItem: (k) => {
		delete mem[k];
		writeFileSync(STATE_FILE, JSON.stringify(mem));
	}
};
process.on("unhandledRejection", (e) => {
	console.error("FAILED", e);
	process.exit(1);
});
var conn = new Connection(RPC_URL, "confirmed");
var raw = JSON.parse(readFileSync(`${process.env.HOME}/.config/crumbs/deployer.json`, "utf8"));
var kp = Keypair.fromSecretKey(Uint8Array.from(Array.isArray(raw) ? raw : raw.secretKey));
var signer = {
	publicKey: kp.publicKey,
	signTransaction: async (tx) => (tx.partialSign(kp), tx),
	signAllTransactions: async (txs) => (txs.forEach((t) => t.partialSign(kp)), txs)
};
var cook = (n) => (Number(n) / 1e9).toFixed(4);
var bal = async () => cook(await conn.getBalance(kp.publicKey));
var png = new Uint8Array(readFileSync("public/og.png"));
console.log("deployer", kp.publicKey.toBase58(), "balance", await bal(), "COOK; picture", png.length, "bytes");
var form = {
	name: "Crumbs Test Pass",
	symbol: "CTP",
	description: "Engine test of the Crumbs quick drop. Safe to ignore.",
	royaltyBps: 500
};
var est = estimate(await fetchRents(conn), form, png.length, "image/png", 3);
console.log(`estimate: image ${cook(est.image)} labels ${cook(est.labels)} pieces ${cook(est.pieces)} fees ${cook(est.fees)} total ${cook(est.total)} COOK; store txs ${est.storeTxs}, mint txs ${est.mintTxs}`);
var recipients = [
	kp.publicKey,
	Keypair.generate().publicKey,
	Keypair.generate().publicKey
];
var resumed = process.env.RESUME ? loadDrop(kp.publicKey) : null;
if (resumed) console.log("resuming drop from", resumed.stage);
var state = resumed ?? newDrop(kp.publicKey, form, recipients, {
	bytes: png,
	mime: "image/png",
	width: 1200,
	height: 630
});
var t0 = Date.now();
var last = "";
await runDrop(conn, signer, state, { onProgress: (p) => {
	const line = `${p.stage} chunks ${p.chunksDone}/${p.chunksTotal} labels ${p.labelsDone}/${p.labelsTotal} pieces ${p.piecesDone}/${p.piecesTotal}${p.prompt ? " PROMPT " + p.prompt : ""}${p.note ? " | " + p.note : ""}`;
	if (line !== last) console.log(`  ${((Date.now() - t0) / 1e3).toFixed(1)}s ${line}`);
	last = line;
} });
console.log(`done in ${((Date.now() - t0) / 1e3).toFixed(1)}s, balance ${await bal()} COOK`);
console.log("collection", state.collection.mint, "pieces", state.pieces.map((p) => p.mint).join(" "));
console.log("image blob", state.imageBlob.pubkey, blobUrl(state.imageBlob.pubkey));
var img = await readBlob(conn, new PublicKey(state.imageBlob.pubkey));
console.log("image blob on chain:", img ? `${img.mime} ${img.bytes.length} bytes finalized=${img.finalized} authority=${img.authority.toBase58().slice(0, 6)} equal=${Buffer.from(img.bytes).equals(Buffer.from(png))}` : "MISSING");
var label = await readBlob(conn, new PublicKey(state.pieceBlobs[0].pubkey));
console.log("label 1:", label ? `${label.mime} ${new TextDecoder().decode(label.bytes)}` : "MISSING");
var meta = await conn.getAccountInfo(metadataPda(new PublicKey(state.pieces[0].mint)));
console.log("piece 1 metadata account:", meta ? `${meta.data.length} bytes` : "MISSING");
for (const url of [blobUrl(state.imageBlob.pubkey), blobUrl(state.pieceBlobs[0].pubkey)]) try {
	const r = await fetch(url);
	console.log("gateway", url.slice(-12), r.status, r.headers.get("content-type"), (await r.arrayBuffer()).byteLength, "bytes");
} catch (e) {
	console.log("gateway", url, "error", e.message);
}
var das = async (method, params) => (await (await fetch(DAS_URL, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method,
		params
	})
})).json()).result;
await new Promise((r) => setTimeout(r, 4e3));
var asset = await das("getAsset", { id: state.pieces[1].mint });
console.log("DAS piece 2:", asset ? `${asset.interface} name=${asset.content?.metadata?.name} grouping=${JSON.stringify(asset.grouping)} owner=${asset.ownership?.owner?.slice(0, 6)} uri=${asset.content?.json_uri}` : "not indexed yet");
var group = await das("getAssetsByGroup", {
	groupKey: "collection",
	groupValue: state.collection.mint,
	page: 1,
	limit: 10
});
console.log("DAS collection group total:", group?.total);
try {
	const bz = await (await fetch(`https://bakedbazaar.art/api/nft/${state.pieces[0].mint}`, { headers: { "user-agent": "Mozilla/5.0" } })).text();
	console.log("bazaar piece 1:", bz.slice(0, 300));
} catch (e) {
	console.log("bazaar error", e.message);
}
process.exit(0);
//#endregion
export {};
