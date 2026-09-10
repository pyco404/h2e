/**
 * Task 1.7 — settle_epoch, distribute_batch, set_graduation.
 * distribute_batch operates on preloaded swapped WSOL BucketState fixtures
 * (swap_payout is Task 1.8). settle_epoch/set_graduation use a real launched coin.
 */
import * as anchor from '@coral-xyz/anchor'
import {
    PublicKey, Keypair, TransactionMessage, VersionedTransaction, TransactionInstruction,
    AddressLookupTableProgram, AddressLookupTableAccount, ComputeBudgetProgram, SystemProgram, LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import {
    getAccount, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
    createSyncNativeInstruction, NATIVE_MINT,
} from '@solana/spl-token'
import { assert } from 'chai'
import fs from 'fs'
import {
    pdas, initializeGlobalIx, launchCoinIx, launchCoinAltAddresses, decodeCoinConfig,
    settleEpochIx, distributeBatchIx, distributeBatchAltAddresses, setGraduationIx,
    initPlatformAllowlistIx, setPlatformAllowlistIx,
    decodeEpochState, decodeBucketState, WSOL_MINT, BN,
} from '../client'

const M = JSON.parse(fs.readFileSync('tests/fixtures/epoch/manifest.json', 'utf8'))
const recipients: PublicKey[] = M.recipients.map((s: string) => new PublicKey(s))

describe('epoch / distribute', () => {
    const provider = anchor.AnchorProvider.env(); anchor.setProvider(provider)
    const conn = provider.connection
    const keeper = (provider.wallet as anchor.Wallet).payer // keeper = provider wallet for convenience
    const admin = Keypair.generate(), unrelated = Keypair.generate()
    const CONFIG = new PublicKey(fs.readFileSync('tests/fixtures/platform-config.txt', 'utf8').trim())
    const platformWallet = Keypair.generate().publicKey
    let coinMint: PublicKey

    async function air(pk: PublicKey, s = 5) { await conn.confirmTransaction(await conn.requestAirdrop(pk, s * LAMPORTS_PER_SOL), 'confirmed') }
    async function sendV0(ixs: TransactionInstruction[], signers: Keypair[], alt?: AddressLookupTableAccount) {
        const { blockhash } = await conn.getLatestBlockhash()
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alt ? [alt] : []))
        tx.sign(signers); const sig = await conn.sendTransaction(tx); await conn.confirmTransaction(sig, 'confirmed')
        const meta = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
        return { sig, size: tx.serialize().length, cu: meta?.meta?.computeUnitsConsumed }
    }
    async function expectFail(ixs: TransactionInstruction[], signers: Keypair[], re: RegExp, alt?: AddressLookupTableAccount) {
        let failed = false
        try { await sendV0(ixs, signers, alt) } catch (e: any) {
            failed = true
            let logs = e.logs
            if (!logs && typeof e.getLogs === 'function') { try { logs = await e.getLogs(conn) } catch {} }
            const msg = [e.message, logs && logs.join(' ')].filter(Boolean).join(' | ')
            assert.match(msg, re, 'wrong error')
        }
        assert.isTrue(failed, 'expected rejection')
    }
    async function simLogs(ixs: TransactionInstruction[], signers: Keypair[]): Promise<{ err: any, logs: string }> {
        const { blockhash } = await conn.getLatestBlockhash()
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message())
        tx.sign(signers)
        const r = await conn.simulateTransaction(tx, { sigVerify: false })
        return { err: r.value.err, logs: (r.value.logs ?? []).join(' ') }
    }
    async function warmAlt(addresses: PublicKey[]): Promise<AddressLookupTableAccount> {
        const slot = await conn.getSlot('finalized')
        const [c, altAddr] = AddressLookupTableProgram.createLookupTable({ authority: keeper.publicKey, payer: keeper.publicKey, recentSlot: slot })
        await sendV0([c], [keeper])
        for (let i = 0; i < addresses.length; i += 18) await sendV0([AddressLookupTableProgram.extendLookupTable({ payer: keeper.publicKey, authority: keeper.publicKey, lookupTable: altAddr, addresses: addresses.slice(i, i + 18) })], [keeper])
        let alt: AddressLookupTableAccount | null = null
        for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 400)); alt = (await conn.getAddressLookupTable(altAddr)).value; if (alt && alt.state.addresses.length >= addresses.length) break }
        await new Promise(r => setTimeout(r, 1200)); return alt!
    }
    // fund a payout_authority(mint) WSOL ATA with `lamports` of wrapped SOL
    async function fundPayout(mint: PublicKey, lamports: number) {
        const pa = pdas.payoutAuthority(mint), ata = getAssociatedTokenAddressSync(WSOL_MINT, pa, true)
        await sendV0([createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, ata, pa, WSOL_MINT), SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: ata, lamports }), createSyncNativeInstruction(ata)], [keeper])
        return ata
    }
    const wsol = async (a: PublicKey) => { try { return (await getAccount(conn, a)).amount } catch { return 0n } }

    before(async function () {
        this.timeout(120000)
        for (const k of [admin, unrelated]) await air(k.publicKey)
        // GlobalConfig: keeper=provider wallet, admin=admin, epoch_seconds=2 (short epochs)
        await sendV0([initializeGlobalIx({ admin: admin.publicKey, keeper: keeper.publicKey, platform_wallet: platformWallet, platform_config_key: CONFIG, usdc_mint: Keypair.generate().publicKey, holder_bps: 6000, h2e_bps: 3000, platform_bps: 1000, dev_buy_cap_bps: 300, holder_cap_bps: 300, epoch_seconds: new BN(2), h2e_epoch_seconds: new BN(604800), max_slippage_bps: 100, min_sweep_lamports: new BN(1000), pool_creation_fee_lamports: new BN(0), paused: false, pause_launches: false }, keeper.publicKey)], [keeper])
        // Task 1.9: allow WSOL as a payout asset (used as default_payout_mint and in settle's allowed_mints)
        await sendV0([initPlatformAllowlistIx(admin.publicKey), setPlatformAllowlistIx(WSOL_MINT, true, admin.publicKey)], [admin])
        // launch a real coin (for settle + set_graduation)
        const mint = Keypair.generate()
        const accts = { payer: keeper.publicKey, baseMint: mint.publicKey, config: CONFIG, platformWallet }
        await sendV0([launchCoinIx({ name: 'E', symbol: 'E', uri: 'https://x.io/e.json', dev_buy_lamports: new BN(0), default_payout_mint: WSOL_MINT }, accts)], [keeper, mint], await warmAlt(launchCoinAltAddresses(accts)))
        coinMint = mint.publicKey
        // create recipient WSOL ATAs (shared across distribute tests)
        for (let i = 0; i < recipients.length; i += 8) {
            const ix = recipients.slice(i, i + 8).map(r => createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, getAssociatedTokenAddressSync(WSOL_MINT, r), r, WSOL_MINT))
            await sendV0(ix, [keeper])
        }
    })

    // ---- settle_epoch ----
    it('settle_epoch: before epoch_end rejected; non-keeper rejected', async () => {
        await fundPayout(coinMint, 7_000_000)
        await expectFail([settleEpochIx({ epochIndex: 500, totalWeight: new BN(0), merkleRoot: Array(32).fill(0), bucketCount: 1, allowedMints: [] }, coinMint, keeper.publicKey)], [keeper], /EpochNotEnded|has not ended|custom program error/)
        await expectFail([settleEpochIx({ epochIndex: 0, totalWeight: new BN(0), merkleRoot: Array(32).fill(0), bucketCount: 1, allowedMints: [] }, coinMint, unrelated.publicKey)], [unrelated], /NotKeeper|not the keeper|custom program error/)
    })

    it('settle_epoch: payout_amount = vault balance; frozen against later fees; duplicate rejected', async () => {
        const payoutAta = getAssociatedTokenAddressSync(WSOL_MINT, pdas.payoutAuthority(coinMint), true)
        const bal = await wsol(payoutAta)
        await new Promise(r => setTimeout(r, 3000)) // epoch 0 (2s) has ended
        await sendV0([settleEpochIx({ epochIndex: 0, totalWeight: new BN(123), merkleRoot: Array(32).fill(7), bucketCount: 2, allowedMints: [WSOL_MINT] }, coinMint, keeper.publicKey)], [keeper])
        const es = decodeEpochState((await conn.getAccountInfo(pdas.epochState(coinMint, 0)))!.data)
        assert.equal(es.payout_amount.toString(), bal.toString(), 'payout_amount == vault balance at settle')
        assert.equal(es.settled, true); assert.equal(es.bucket_count, 2); assert.equal(es.total_weight.toString(), '123')
        // fees arriving after settle do not change payout_amount
        await fundPayout(coinMint, 3_000_000)
        const es2 = decodeEpochState((await conn.getAccountInfo(pdas.epochState(coinMint, 0)))!.data)
        assert.equal(es2.payout_amount.toString(), bal.toString(), 'frozen')
        // duplicate settle for the same index rejected (init)
        await expectFail([settleEpochIx({ epochIndex: 0, totalWeight: new BN(0), merkleRoot: Array(32).fill(0), bucketCount: 1, allowedMints: [] }, coinMint, keeper.publicKey)], [keeper], /already in use|custom program error/)
    })

    // ---- distribute_batch (fixtures) ----
    const batch = (mint: PublicKey, start: number, slice: PublicKey[], amt: number) =>
        distributeBatchIx({ epochIndex: 0, outMint: WSOL_MINT, startIndex: start, recipients: slice, amounts: slice.map(() => new BN(amt)) }, mint, keeper.publicKey)
    async function distAlt(mint: PublicKey, slice: PublicKey[]) {
        return warmAlt([...distributeBatchAltAddresses({ epochIndex: 0, outMint: WSOL_MINT, startIndex: 0, recipients: [], amounts: [] }, mint), ...slice.map(r => getAssociatedTokenAddressSync(WSOL_MINT, r))])
    }

    it('1+6. happy path across batches until complete; buckets_complete increments', async () => {
        const mint = new PublicKey(M.cases.A.mint)
        await fundPayout(mint, 21_000_000)
        const before = recipients.map(() => 0n)
        const b0 = recipients.slice(0, 13), b1 = recipients.slice(13, 20)
        const r0 = await sendV0([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), batch(mint, 0, b0, 100_000)], [keeper], await distAlt(mint, b0))
        await sendV0([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), batch(mint, 13, b1, 100_000)], [keeper], await distAlt(mint, b1))
        const bk = decodeBucketState((await conn.getAccountInfo(pdas.bucketState(mint, 0, WSOL_MINT)))!.data)
        assert.equal(bk.cursor, 20); assert.equal(bk.complete, true); assert.equal(bk.paid_amount.toString(), '2000000')
        for (const r of recipients) assert.equal((await wsol(getAssociatedTokenAddressSync(WSOL_MINT, r))).toString(), '100000', 'each paid once')
        const es = decodeEpochState((await conn.getAccountInfo(pdas.epochState(mint, 0)))!.data)
        assert.equal(es.buckets_complete, 1, 'buckets_complete incremented')
        console.log(`      13-recipient batch: CU=${r0.cu} size=${r0.size}B`)
    })

    it('2. replay of an applied batch is rejected (no double pay)', async () => {
        const mint = new PublicKey(M.cases.B.mint); await fundPayout(mint, 21_000_000)
        const b0 = recipients.slice(0, 13)
        const paidBefore = await Promise.all(recipients.map(r => wsol(getAssociatedTokenAddressSync(WSOL_MINT, r))))
        const altB = await distAlt(mint, b0)
        await sendV0([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), batch(mint, 0, b0, 100_000)], [keeper], altB)
        await expectFail([batch(mint, 0, b0, 100_000)], [keeper], /CursorMismatch|start index|custom program error/, altB) // start_index 0 != cursor 13
        // each recipient paid exactly once more than before
        for (let i = 0; i < 13; i++) assert.equal((await wsol(getAssociatedTokenAddressSync(WSOL_MINT, recipients[i]))) - paidBefore[i], 100000n, 'paid exactly once')
    })

    it('3. out-of-order batch is rejected', async () => {
        const mint = new PublicKey(M.cases.D.mint); await fundPayout(mint, 21_000_000)
        await expectFail([batch(mint, 5, recipients.slice(5, 10), 100)], [keeper], /CursorMismatch|start index|custom program error/)
    })
    it('4. overpayment is rejected', async () => {
        const mint = new PublicKey(M.cases.D.mint) // amount_out = 1000
        const b = recipients.slice(0, 13)
        await expectFail([batch(mint, 0, b, 100_000)], [keeper], /Overpayment|exceeds bucket|custom program error/, await distAlt(mint, b))
    })
    it('7. non-keeper rejected', async () => {
        const mint = new PublicKey(M.cases.D.mint)
        // keeper ACCOUNT = unrelated so has_one=keeper fails on the config
        const ix = distributeBatchIx({ epochIndex: 0, outMint: WSOL_MINT, startIndex: 0, recipients: recipients.slice(0, 1), amounts: [new BN(1)] }, mint, unrelated.publicKey)
        const { err, logs } = await simLogs([ix], [unrelated])
        assert.isNotNull(err, 'must fail')
        assert.match(logs, /NotKeeper|not the keeper|has_one|ConstraintHasOne/, 'expected NotKeeper')
    })
    it('8. length mismatch rejected', async () => {
        const mint = new PublicKey(M.cases.D.mint)
        const ix = distributeBatchIx({ epochIndex: 0, outMint: WSOL_MINT, startIndex: 0, recipients: recipients.slice(0, 3), amounts: [new BN(1), new BN(1)] }, mint, keeper.publicKey)
        await expectFail([ix], [keeper], /LengthMismatch|length mismatch|custom program error/)
    })
    it('9. zero-amount recipient rejected (round-builder drops sub-rent shares)', async () => {
        const mint = new PublicKey(M.cases.D.mint)
        const ix = distributeBatchIx({ epochIndex: 0, outMint: WSOL_MINT, startIndex: 0, recipients: recipients.slice(0, 2), amounts: [new BN(1), new BN(0)] }, mint, keeper.publicKey)
        await expectFail([ix], [keeper], /ZeroAmount|zero-amount|custom program error/)
    })

    it('5. crash and resume from the on-chain cursor', async () => {
        const mint = new PublicKey(M.cases.C.mint); await fundPayout(mint, 21_000_000)
        await sendV0([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), batch(mint, 0, recipients.slice(0, 13), 100_000)], [keeper], await distAlt(mint, recipients.slice(0, 13)))
        // "crash": read cursor from chain and resume
        const cur = decodeBucketState((await conn.getAccountInfo(pdas.bucketState(mint, 0, WSOL_MINT)))!.data).cursor
        assert.equal(cur, 13, 'cursor persisted')
        await sendV0([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), batch(mint, cur, recipients.slice(cur, 20), 100_000)], [keeper], await distAlt(mint, recipients.slice(cur, 20)))
        assert.equal(decodeBucketState((await conn.getAccountInfo(pdas.bucketState(mint, 0, WSOL_MINT)))!.data).complete, true, 'completed after resume')
    })

    // ---- set_graduation ----
    it('set_graduation: admin overwrites; keeper and unrelated rejected', async () => {
        const damm = Keypair.generate().publicKey, pos = Keypair.generate().publicKey
        await expectFail([setGraduationIx(coinMint, 'Graduated', damm, pos, keeper.publicKey)], [keeper], /NotAdmin|not the admin|custom program error/)
        await expectFail([setGraduationIx(coinMint, 'Graduated', damm, pos, unrelated.publicKey)], [unrelated], /NotAdmin|not the admin|custom program error/)
        await sendV0([setGraduationIx(coinMint, 'Graduated', damm, pos, admin.publicKey)], [admin])
        const cc = decodeCoinConfig((await conn.getAccountInfo(pdas.coinConfig(coinMint)))!.data)
        assert.equal(Object.keys(cc.status)[0], 'Graduated'); assert.ok(cc.damm_pool.equals(damm)); assert.ok(cc.locked_position.equals(pos))
    })
})
