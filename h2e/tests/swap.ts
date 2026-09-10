/**
 * Task 1.8b — swap_payout, against the local jupiter_stub venue.
 *
 * Offline by construction: the coin is a preloaded synthetic Bonding CoinConfig
 * (scripts/gen-swap-fixtures.ts), the venue is the stub, and every asset is a
 * test SPL mint. No DBC / cp-amm / network. The stub returns a caller-specified
 * out_amount, which is what makes test 2 (delta, not quote) possible.
 *
 * Run with: bash scripts/swap-test.sh
 */
import * as anchor from '@coral-xyz/anchor'
import {
    PublicKey, Keypair, TransactionMessage, VersionedTransaction, TransactionInstruction,
    SystemProgram, LAMPORTS_PER_SOL, AddressLookupTableProgram, AddressLookupTableAccount,
} from '@solana/web3.js'
import {
    getAccount, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
    createSyncNativeInstruction, createMint, mintTo, TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { assert } from 'chai'
import crypto from 'crypto'
import fs from 'fs'
import {
    pdas, PROGRAM_ID, JUPITER_PROGRAM, initializeGlobalIx, settleEpochIx, swapPayoutIx,
    distributeBatchIx, distributeBatchAltAddresses, setGraduationIx, claimAndSweepIx,
    initPlatformAllowlistIx, setPlatformAllowlistIx,
    decodeEpochState, decodeBucketState, decodeAllowlistState, decodeCoinConfig,
    WSOL_MINT, BN, RouteMeta,
} from '../client'

const STUB = JUPITER_PROGRAM // scripts build h2e with stub-jupiter -> JUPITER_PROGRAM == stub
const RESERVE_AUTH = PublicKey.findProgramAddressSync([Buffer.from('reserve')], STUB)[0]

// stub_swap Anchor discriminator = sha256("global:stub_swap")[0..8]
const STUB_SWAP_DISC = crypto.createHash('sha256').update('global:stub_swap').digest().subarray(0, 8)
function stubData(amountIn: bigint, outAmount: bigint): Buffer {
    const b = Buffer.alloc(16)
    b.writeBigUInt64LE(amountIn, 0); b.writeBigUInt64LE(outAmount, 8)
    return Buffer.concat([STUB_SWAP_DISC, b])
}

describe('swap_payout (Task 1.8b)', () => {
    const provider = anchor.AnchorProvider.env(); anchor.setProvider(provider)
    const conn = provider.connection
    const keeper = (provider.wallet as anchor.Wallet).payer
    const admin = Keypair.generate(), unrelated = Keypair.generate()
    const CONFIG = new PublicKey(fs.readFileSync('tests/fixtures/platform-config.txt', 'utf8').trim())
    const platformWallet = Keypair.generate().publicKey
    const coinMint = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('tests/fixtures/swap/coin-mint.json', 'utf8')))).publicKey

    let outMint: PublicKey       // an allowlisted, classic-SPL payout asset
    let otherMint: PublicKey     // a valid SPL mint deliberately NOT allowlisted
    let reserveSource: PublicKey // stub WSOL reserve
    let reserveDest: PublicKey   // stub out-asset reserve (funded)
    let reserveOther: PublicKey
    const payoutAuth = pdas.payoutAuthority(coinMint)
    const payoutWsol = getAssociatedTokenAddressSync(WSOL_MINT, payoutAuth, true)
    let payoutOut: PublicKey, payoutOther: PublicKey

    async function air(pk: PublicKey, s = 20) { await conn.confirmTransaction(await conn.requestAirdrop(pk, s * LAMPORTS_PER_SOL), 'confirmed') }
    async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
        const { blockhash } = await conn.getLatestBlockhash()
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message())
        tx.sign(signers); const sig = await conn.sendTransaction(tx); await conn.confirmTransaction(sig, 'confirmed')
        const meta = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
        return { sig, size: tx.serialize().length, cu: meta?.meta?.computeUnitsConsumed }
    }
    async function warmAlt(addresses: PublicKey[]): Promise<AddressLookupTableAccount> {
        const slot = await conn.getSlot('finalized')
        const [c, altAddr] = AddressLookupTableProgram.createLookupTable({ authority: keeper.publicKey, payer: keeper.publicKey, recentSlot: slot })
        await send([c], [keeper])
        for (let i = 0; i < addresses.length; i += 18) await send([AddressLookupTableProgram.extendLookupTable({ payer: keeper.publicKey, authority: keeper.publicKey, lookupTable: altAddr, addresses: addresses.slice(i, i + 18) })], [keeper])
        let alt: AddressLookupTableAccount | null = null
        for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 400)); alt = (await conn.getAddressLookupTable(altAddr)).value; if (alt && alt.state.addresses.length >= addresses.length) break }
        await new Promise(r => setTimeout(r, 1200)); return alt!
    }
    async function expectFailAlt(ixs: TransactionInstruction[], signers: Keypair[], re: RegExp, alt: AddressLookupTableAccount) {
        let failed = false
        try {
            const { blockhash } = await conn.getLatestBlockhash()
            const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message([alt]))
            tx.sign(signers); const sig = await conn.sendTransaction(tx); await conn.confirmTransaction(sig, 'confirmed')
        } catch (e: any) {
            failed = true
            let logs = e.logs
            if (!logs && typeof e.getLogs === 'function') { try { logs = await e.getLogs(conn) } catch {} }
            assert.match([e.message, logs && logs.join(' ')].filter(Boolean).join(' | '), re, 'wrong error')
        }
        assert.isTrue(failed, 'expected rejection')
    }
    async function expectFail(ixs: TransactionInstruction[], signers: Keypair[], re: RegExp) {
        let failed = false
        try { await send(ixs, signers) } catch (e: any) {
            failed = true
            let logs = e.logs
            if (!logs && typeof e.getLogs === 'function') { try { logs = await e.getLogs(conn) } catch {} }
            assert.match([e.message, logs && logs.join(' ')].filter(Boolean).join(' | '), re, 'wrong error')
        }
        assert.isTrue(failed, 'expected rejection')
    }
    async function fundPayoutWsol(lamports: number) {
        await send([
            createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, payoutWsol, payoutAuth, WSOL_MINT),
            SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: payoutWsol, lamports }),
            createSyncNativeInstruction(payoutWsol),
        ], [keeper])
    }
    const bal = async (a: PublicKey) => { try { return (await getAccount(conn, a)).amount } catch { return 0n } }

    // A stub route for (out) swapping `amountIn` WSOL -> `outAmount` of `mint`.
    function stubRoute(destAta: PublicKey, resSrc: PublicKey, resDst: PublicKey): RouteMeta[] {
        return [
            { pubkey: payoutAuth, isSigner: false, isWritable: false }, // forced signer on-chain
            { pubkey: payoutWsol, isSigner: false, isWritable: true },
            { pubkey: destAta, isSigner: false, isWritable: true },
            { pubkey: resSrc, isSigner: false, isWritable: true },
            { pubkey: resDst, isSigner: false, isWritable: true },
            { pubkey: RESERVE_AUTH, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ]
    }

    before(async function () {
        this.timeout(180000)
        for (const k of [admin, unrelated]) await air(k.publicKey)
        await send([initializeGlobalIx({
            admin: admin.publicKey, keeper: keeper.publicKey, platform_wallet: platformWallet, platform_config_key: CONFIG,
            usdc_mint: Keypair.generate().publicKey, holder_bps: 6000, h2e_bps: 3000, platform_bps: 1000,
            dev_buy_cap_bps: 300, holder_cap_bps: 300, epoch_seconds: new BN(2), h2e_epoch_seconds: new BN(604800),
            max_slippage_bps: 100, min_sweep_lamports: new BN(1000), pool_creation_fee_lamports: new BN(0),
            paused: false, pause_launches: false,
        }, keeper.publicKey)], [keeper])

        // Payout assets (classic SPL). keeper is mint authority.
        outMint = await createMint(conn, keeper, keeper.publicKey, null, 6)
        otherMint = await createMint(conn, keeper, keeper.publicKey, null, 6)

        // Standing PlatformAllowlist: settle_epoch requires allowed_mints ⊆ it.
        // outMint + WSOL are permitted; otherMint deliberately is not.
        await send([initPlatformAllowlistIx(admin.publicKey)], [admin])
        await send([setPlatformAllowlistIx(outMint, true, admin.publicKey), setPlatformAllowlistIx(WSOL_MINT, true, admin.publicKey)], [admin])

        // Stub reserves owned by the stub reserve PDA; fund the out reserves.
        reserveSource = getAssociatedTokenAddressSync(WSOL_MINT, RESERVE_AUTH, true)
        reserveDest = getAssociatedTokenAddressSync(outMint, RESERVE_AUTH, true)
        reserveOther = getAssociatedTokenAddressSync(otherMint, RESERVE_AUTH, true)
        await send([
            createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, reserveSource, RESERVE_AUTH, WSOL_MINT),
            createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, reserveDest, RESERVE_AUTH, outMint),
            createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, reserveOther, RESERVE_AUTH, otherMint),
        ], [keeper])
        await mintTo(conn, keeper, outMint, reserveDest, keeper, 1_000_000_000)
        await mintTo(conn, keeper, otherMint, reserveOther, keeper, 1_000_000_000)

        // Payout out ATAs (destination of swaps) must exist before the swap.
        payoutOut = getAssociatedTokenAddressSync(outMint, payoutAuth, true)
        payoutOther = getAssociatedTokenAddressSync(otherMint, payoutAuth, true)
        await send([
            createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, payoutOut, payoutAuth, outMint),
            createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, payoutOther, payoutAuth, otherMint),
        ], [keeper])
    })

    // Settle a fresh epoch index; allowlist = given mints; returns epochIndex.
    let nextEpoch = 100
    async function settle(allowed: PublicKey[], bucketCount = 1): Promise<number> {
        const e = nextEpoch++
        await send([settleEpochIx({ epochIndex: e, totalWeight: new BN(1), merkleRoot: Array(32).fill(0), bucketCount, allowedMints: allowed }, coinMint, keeper.publicKey)], [keeper])
        return e
    }

    it('1. happy path: amount_out recorded from the measured delta', async () => {
        await fundPayoutWsol(5_000_000)
        const e = await settle([outMint])
        const amountIn = 1_000_000n, outAmount = 2_000_000n
        const r = await send([swapPayoutIx({
            epochIndex: e, outMint, amountIn: new BN(amountIn.toString()), quotedOut: new BN(outAmount.toString()),
            minOut: new BN('1980000'), recipientCount: 3, jupData: stubData(amountIn, outAmount), route: stubRoute(payoutOut, reserveSource, reserveDest),
        }, coinMint, keeper.publicKey)], [keeper])
        const bk = decodeBucketState((await conn.getAccountInfo(pdas.bucketState(coinMint, e, outMint)))!.data)
        assert.equal(bk.amount_out.toString(), outAmount.toString(), 'amount_out == measured delta')
        assert.equal(bk.swapped, true); assert.equal(bk.amount_in.toString(), amountIn.toString()); assert.equal(bk.recipient_count, 3)
        const es = decodeEpochState((await conn.getAccountInfo(pdas.epochState(coinMint, e)))!.data)
        assert.equal(es.swapped_in.toString(), amountIn.toString(), 'swapped_in advanced')
        console.log(`      swap CU=${r.cu} size=${r.size}B route=${stubRoute(payoutOut, reserveSource, reserveDest).length}`)
    })

    it('2. DELTA, NOT QUOTE: stub returns less than quoted; stored amount_out is the delta', async () => {
        await fundPayoutWsol(5_000_000)
        const e = await settle([outMint])
        const amountIn = 1_000_000n, quoted = 2_000_000n, actual = 1_990_000n // < quoted, but >= floor(1.98e6)
        await send([swapPayoutIx({
            epochIndex: e, outMint, amountIn: new BN(amountIn.toString()), quotedOut: new BN(quoted.toString()),
            minOut: new BN('1980000'), recipientCount: 1, jupData: stubData(amountIn, actual), route: stubRoute(payoutOut, reserveSource, reserveDest),
        }, coinMint, keeper.publicKey)], [keeper])
        const bk = decodeBucketState((await conn.getAccountInfo(pdas.bucketState(coinMint, e, outMint)))!.data)
        assert.equal(bk.amount_out.toString(), actual.toString(), 'stored the measured delta')
        assert.notEqual(bk.amount_out.toString(), quoted.toString(), 'did NOT store the quote')
    })

    it('3. slippage floor: min_out below quoted×(1−slippage) is rejected', async () => {
        await fundPayoutWsol(5_000_000)
        const e = await settle([outMint])
        await expectFail([swapPayoutIx({
            epochIndex: e, outMint, amountIn: new BN(1_000_000), quotedOut: new BN(2_000_000),
            minOut: new BN(1_000_000), recipientCount: 1, jupData: stubData(1_000_000n, 2_000_000n), route: stubRoute(payoutOut, reserveSource, reserveDest),
        }, coinMint, keeper.publicKey)], [keeper], /SlippageTooLoose|slippage floor|custom program error/)
    })

    it('4. out_mint not in the allowlist is rejected', async () => {
        await fundPayoutWsol(5_000_000)
        const e = await settle([outMint]) // otherMint intentionally absent
        await expectFail([swapPayoutIx({
            epochIndex: e, outMint: otherMint, amountIn: new BN(1_000_000), quotedOut: new BN(2_000_000),
            minOut: new BN(1_980_000), recipientCount: 1, jupData: stubData(1_000_000n, 2_000_000n), route: stubRoute(payoutOther, reserveSource, reserveOther),
        }, coinMint, keeper.publicKey)], [keeper], /OutMintNotAllowed|not in this round|custom program error/)
    })

    it('5. CPI target that is not the pinned program is rejected', async () => {
        await fundPayoutWsol(5_000_000)
        const e = await settle([outMint])
        const ix = swapPayoutIx({
            epochIndex: e, outMint, amountIn: new BN(1_000_000), quotedOut: new BN(2_000_000),
            minOut: new BN(1_980_000), recipientCount: 1, jupData: stubData(1_000_000n, 2_000_000n), route: stubRoute(payoutOut, reserveSource, reserveDest),
        }, coinMint, keeper.publicKey)
        ix.keys[12] = { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false } // jupiter_program slot
        await expectFail([ix], [keeper], /WrongJupiterProgram|ConstraintAddress|custom program error/)
    })

    it('6. bucket already swapped is rejected', async () => {
        await fundPayoutWsol(5_000_000)
        const e = await settle([outMint])
        const mk = () => swapPayoutIx({
            epochIndex: e, outMint, amountIn: new BN(1_000_000), quotedOut: new BN(2_000_000),
            minOut: new BN(1_980_000), recipientCount: 1, jupData: stubData(1_000_000n, 2_000_000n), route: stubRoute(payoutOut, reserveSource, reserveDest),
        }, coinMint, keeper.publicKey)
        await send([mk()], [keeper])
        await expectFail([mk()], [keeper], /already in use|custom program error/) // init on BucketState
    })

    it('7. swapped_in + amount_in > payout_amount is rejected', async () => {
        // fund small, settle freezes payout_amount at that balance
        const payoutAta = payoutWsol
        // drain then fund exactly 1_000_000
        const cur = await bal(payoutAta)
        await fundPayoutWsol(0) // ensure ATA exists
        // settle with whatever is there, then try to swap more than payout_amount
        const e = await settle([outMint])
        const es = decodeEpochState((await conn.getAccountInfo(pdas.epochState(coinMint, e)))!.data)
        const over = new BN(es.payout_amount.toString()).add(new BN(1))
        void cur
        await expectFail([swapPayoutIx({
            epochIndex: e, outMint, amountIn: over, quotedOut: new BN(2_000_000),
            minOut: new BN(1_980_000), recipientCount: 1, jupData: stubData(BigInt(over.toString()), 2_000_000n), route: stubRoute(payoutOut, reserveSource, reserveDest),
        }, coinMint, keeper.publicKey)], [keeper], /SwapExceedsPayout|exceed the epoch payout|custom program error/)
    })

    it('8. remaining_accounts over the bound is rejected', async () => {
        await fundPayoutWsol(5_000_000)
        const e = await settle([outMint])
        const padded = stubRoute(payoutOut, reserveSource, reserveDest)
        while (padded.length <= 48) padded.push({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false })
        const ix = swapPayoutIx({
            epochIndex: e, outMint, amountIn: new BN(1_000_000), quotedOut: new BN(2_000_000),
            minOut: new BN(1_980_000), recipientCount: 1, jupData: stubData(1_000_000n, 2_000_000n), route: padded,
        }, coinMint, keeper.publicKey)
        // Compress keys into an ALT so the oversized account set actually reaches
        // the program and its runtime bound fires (rather than a client tx-size overrun).
        const alt = await warmAlt(ix.keys.map(k => k.pubkey))
        await expectFailAlt([ix], [keeper], /TooManySwapAccounts|account-lock bound|custom program error/, alt)
    })

    it('9. out_mint == WSOL: no swap, amount_out == amount_in', async () => {
        await fundPayoutWsol(5_000_000)
        const e = await settle([WSOL_MINT])
        const amountIn = 1_500_000n
        await send([swapPayoutIx({
            epochIndex: e, outMint: WSOL_MINT, amountIn: new BN(amountIn.toString()), quotedOut: new BN(amountIn.toString()),
            minOut: new BN(amountIn.toString()), recipientCount: 1, jupData: Buffer.alloc(0), route: [],
        }, coinMint, keeper.publicKey)], [keeper])
        const bk = decodeBucketState((await conn.getAccountInfo(pdas.bucketState(coinMint, e, WSOL_MINT)))!.data)
        assert.equal(bk.amount_out.toString(), amountIn.toString(), 'WSOL bucket: amount_out == amount_in')
        assert.equal(bk.swapped, true)
    })

    it('10. non-keeper is rejected', async () => {
        await fundPayoutWsol(5_000_000)
        const e = await settle([outMint])
        const ix = swapPayoutIx({
            epochIndex: e, outMint, amountIn: new BN(1_000_000), quotedOut: new BN(2_000_000),
            minOut: new BN(1_980_000), recipientCount: 1, jupData: stubData(1_000_000n, 2_000_000n), route: stubRoute(payoutOut, reserveSource, reserveDest),
        }, coinMint, unrelated.publicKey)
        await expectFail([ix], [unrelated], /NotKeeper|not the keeper|has_one|ConstraintHasOne|custom program error/)
    })

    it('11. END-TO-END: settle → allowlist → swap 2 buckets → distribute both → buckets_complete == bucket_count', async () => {
        await fundPayoutWsol(8_000_000)
        const e = await settle([outMint, WSOL_MINT], 2)
        const al = decodeAllowlistState((await conn.getAccountInfo(pdas.allowlistState(coinMint, e)))!.data)
        assert.equal(al.mints.length, 2, 'allowlist snapshot written at settle')

        // recipients
        const rs = [Keypair.generate().publicKey, Keypair.generate().publicKey]
        // bucket 1: outMint, swap then distribute both recipients
        await send([swapPayoutIx({
            epochIndex: e, outMint, amountIn: new BN(1_000_000), quotedOut: new BN(2_000_000),
            minOut: new BN(1_980_000), recipientCount: 2, jupData: stubData(1_000_000n, 2_000_000n), route: stubRoute(payoutOut, reserveSource, reserveDest),
        }, coinMint, keeper.publicKey)], [keeper])
        // bucket 2: WSOL, no swap
        await send([swapPayoutIx({
            epochIndex: e, outMint: WSOL_MINT, amountIn: new BN(1_000_000), quotedOut: new BN(1_000_000),
            minOut: new BN(1_000_000), recipientCount: 2, jupData: Buffer.alloc(0), route: [],
        }, coinMint, keeper.publicKey)], [keeper])

        // create recipient ATAs for both assets
        const mkAtas = (m: PublicKey) => rs.map(r => createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, getAssociatedTokenAddressSync(m, r), r, m))
        await send([...mkAtas(outMint), ...mkAtas(WSOL_MINT)], [keeper])

        // distribute bucket 1 (outMint)
        await send([distributeBatchIx({ epochIndex: e, outMint, startIndex: 0, recipients: rs, amounts: [new BN(500_000), new BN(500_000)] }, coinMint, keeper.publicKey)], [keeper])
        // distribute bucket 2 (WSOL)
        await send([distributeBatchIx({ epochIndex: e, outMint: WSOL_MINT, startIndex: 0, recipients: rs, amounts: [new BN(500_000), new BN(500_000)] }, coinMint, keeper.publicKey)], [keeper])

        const es = decodeEpochState((await conn.getAccountInfo(pdas.epochState(coinMint, e)))!.data)
        assert.equal(es.buckets_complete, 2, 'both buckets complete')
        assert.equal(es.bucket_count, 2)
        for (const r of rs) {
            assert.equal((await bal(getAssociatedTokenAddressSync(outMint, r))).toString(), '500000', 'paid in outMint')
            assert.equal((await bal(getAssociatedTokenAddressSync(WSOL_MINT, r))).toString(), '500000', 'paid in WSOL')
        }
    })

    it('12. set_graduation corrupt → fix (recovery). Successful graduated claim itself lives in graduation.ts (needs cp-amm).', async () => {
        const badPool = Keypair.generate().publicKey, badPos = Keypair.generate().publicKey
        // corrupt: admin writes a Graduated status with bogus pool/position (simulating a sync that read a shifted layout)
        await send([setGraduationIx(coinMint, 'Graduated', badPool, badPos, admin.publicKey)], [admin])
        let cc = decodeCoinConfig((await conn.getAccountInfo(pdas.coinConfig(coinMint)))!.data)
        assert.equal(Object.keys(cc.status)[0], 'Graduated'); assert.ok(cc.damm_pool.equals(badPool))

        // while corrupt, a graduated claim cannot succeed — the recorded damm_pool is garbage.
        // (Offline we assert the claim is rejected; the successful path is graduation.ts.)
        await expectFail([claimAndSweepIx({ caller: keeper.publicKey, mint: coinMint, config: CONFIG, platformWallet })], [keeper], /.*/)

        // fix: admin restores a sane state (back to Bonding, clears the bogus pool/position).
        await send([setGraduationIx(coinMint, 'Bonding', null, null, admin.publicKey)], [admin])
        cc = decodeCoinConfig((await conn.getAccountInfo(pdas.coinConfig(coinMint)))!.data)
        assert.equal(Object.keys(cc.status)[0], 'Bonding', 'recovered to Bonding')
        assert.isNull(cc.damm_pool, 'bogus damm_pool cleared'); assert.isNull(cc.locked_position, 'bogus position cleared')
    })
})
