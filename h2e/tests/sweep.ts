/**
 * Task 1.5 tests — claim_and_sweep (bonding path). Cloned DBC rail.
 * Every state-writing test asserts on-chain readback.
 */
import * as anchor from '@coral-xyz/anchor'
import {
    PublicKey, Keypair, TransactionMessage, VersionedTransaction, Transaction, TransactionInstruction,
    AddressLookupTableProgram, AddressLookupTableAccount, ComputeBudgetProgram, SystemProgram, LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import {
    getAccount, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
    createSyncNativeInstruction, NATIVE_MINT,
} from '@solana/spl-token'
import { assert } from 'chai'
import fs from 'fs'
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
    pdas, initializeGlobalIx, pauseIx, decodeCoinConfig, launchCoinIx, launchCoinAltAddresses,
    claimAndSweepIx, claimAndSweepAltAddresses, sweepAtas, sweepAtaIxs,
    initPlatformAllowlistIx, setPlatformAllowlistIx, WSOL_MINT, BN,
} from '../client'

const HOLDER_BPS = 6000, H2E_BPS = 3000, PLATFORM_BPS = 1000
const MIN_SWEEP = new BN(1_000_000)

describe('claim_and_sweep (bonding)', () => {
    const provider = anchor.AnchorProvider.env(); anchor.setProvider(provider)
    const conn = provider.connection
    const admin = (provider.wallet as anchor.Wallet).payer
    const dbc = DynamicBondingCurveClient.create(conn, 'confirmed')
    const CONFIG = new PublicKey(fs.readFileSync('tests/fixtures/platform-config.txt', 'utf8').trim())
    const platformWallet = Keypair.generate().publicKey

    async function airdrop(pk: PublicKey, sol = 5) { await conn.confirmTransaction(await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL), 'confirmed') }
    async function sendV0(ixs: TransactionInstruction[], signers: Keypair[], alt?: AddressLookupTableAccount) {
        const { blockhash } = await conn.getLatestBlockhash()
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alt ? [alt] : []))
        tx.sign(signers)
        const size = tx.serialize().length
        const sig = await conn.sendTransaction(tx); await conn.confirmTransaction(sig, 'confirmed')
        const meta = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
        return { sig, size, cu: meta?.meta?.computeUnitsConsumed }
    }
    async function warmAlt(addresses: PublicKey[]): Promise<AddressLookupTableAccount> {
        const slot = await conn.getSlot('finalized')
        const [c, altAddr] = AddressLookupTableProgram.createLookupTable({ authority: admin.publicKey, payer: admin.publicKey, recentSlot: slot })
        const e = AddressLookupTableProgram.extendLookupTable({ payer: admin.publicKey, authority: admin.publicKey, lookupTable: altAddr, addresses })
        await sendV0([c, e], [admin])
        let alt: AddressLookupTableAccount | null = null
        for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 400)); alt = (await conn.getAddressLookupTable(altAddr)).value; if (alt && alt.state.addresses.length >= addresses.length) break }
        await new Promise(r => setTimeout(r, 1200)); return alt!
    }
    async function launch(): Promise<{ mint: Keypair, pool: PublicKey }> {
        const mint = Keypair.generate()
        const accts = { payer: admin.publicKey, baseMint: mint.publicKey, config: CONFIG, platformWallet }
        const alt = await warmAlt(launchCoinAltAddresses(accts))
        const ix = launchCoinIx({ name: 'Sweep', symbol: 'SW', uri: 'https://x.io/s.json', dev_buy_lamports: new BN(0), default_payout_mint: WSOL_MINT }, accts)
        const { blockhash } = await conn.getLatestBlockhash()
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: admin.publicKey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message([alt]))
        tx.sign([admin, mint]); await conn.confirmTransaction(await conn.sendTransaction(tx), 'confirmed')
        return { mint, pool: deriveDbcPoolAddress(WSOL_MINT, mint.publicKey, CONFIG) }
    }
    async function tradeBuy(pool: PublicKey, sol: number, trader: Keypair) {
        const tx: Transaction = await dbc.pool.swap({ owner: trader.publicKey, pool, amountIn: new BN(Math.round(sol * LAMPORTS_PER_SOL)), minimumAmountOut: new BN(0), swapBaseForQuote: false, referralTokenAccount: null })
        tx.feePayer = trader.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.sign(trader)
        await conn.confirmTransaction(await conn.sendRawTransaction(tx.serialize()), 'confirmed')
    }
    async function partnerFee(pool: PublicKey): Promise<BN> { return (await dbc.state.getPool(pool))!.poolState.partnerQuoteFee }
    async function wsol(ata: PublicKey): Promise<bigint> { try { return (await getAccount(conn, ata)).amount } catch { return 0n } }
    /** Fund a FeeAuthority WSOL ATA to a precise token amount (for min-sweep / rounding tests). */
    async function prefundFeeAta(mint: PublicKey, amount: number) {
        const a = sweepAtas(mint, platformWallet)
        await sendV0([
            createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, a.feeWsolAta, a.feeAuthority, WSOL_MINT),
            SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: a.feeWsolAta, lamports: amount }),
            createSyncNativeInstruction(a.feeWsolAta),
        ], [admin])
    }
    async function sweep(mint: PublicKey, caller: Keypair) {
        const accts = { caller: caller.publicKey, mint, config: CONFIG, platformWallet }
        const alt = await warmAlt(claimAndSweepAltAddresses(accts))
        const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...sweepAtaIxs(mint, platformWallet, caller.publicKey), claimAndSweepIx(accts)]
        return sendV0(ixs, [caller], alt)
    }

    before(async () => {
        await sendV0([initializeGlobalIx({
            admin: admin.publicKey, keeper: Keypair.generate().publicKey, platform_wallet: platformWallet,
            platform_config_key: CONFIG, usdc_mint: Keypair.generate().publicKey,
            holder_bps: HOLDER_BPS, h2e_bps: H2E_BPS, platform_bps: PLATFORM_BPS, dev_buy_cap_bps: 300, holder_cap_bps: 300,
            epoch_seconds: new BN(86400), h2e_epoch_seconds: new BN(604800), max_slippage_bps: 100,
            min_sweep_lamports: MIN_SWEEP, pool_creation_fee_lamports: new BN(0), paused: false, pause_launches: false,
        }, admin.publicKey)], [admin])
        // Task 1.9: allow WSOL as the launched coin's default_payout_mint
        await sendV0([initPlatformAllowlistIx(admin.publicKey), setPlatformAllowlistIx(WSOL_MINT, true, admin.publicKey)], [admin])
    })

    it('1,7,8. happy path: fees split 60/30/10, total_claimed set, fee ATA empty', async () => {
        const { mint, pool } = await launch()
        await tradeBuy(pool, 0.2, admin)
        const claimed = await partnerFee(pool)
        assert.ok(claimed.gt(MIN_SWEEP), 'generated > min_sweep fees')
        const a = sweepAtas(mint.publicKey, platformWallet)
        // revenue and platform vaults are GLOBAL and accumulate across coins;
        // assert the delta from this sweep. payout is per-mint (fresh here).
        const [rev0, plat0] = [await wsol(a.revenueWsolAta), await wsol(a.platformWsolAta)]
        const r = await sweep(mint.publicKey, admin)
        console.log(`      sweep: CU=${r.cu} size=${r.size}B  claimed=${claimed.toString()}`)

        const holder = claimed.mul(new BN(HOLDER_BPS)).div(new BN(10000))
        const h2e = claimed.mul(new BN(H2E_BPS)).div(new BN(10000))
        const platform = claimed.sub(holder).sub(h2e)
        assert.equal((await wsol(a.payoutWsolAta)).toString(), holder.toString(), 'payout = holder')
        assert.equal(((await wsol(a.revenueWsolAta)) - rev0).toString(), h2e.toString(), 'revenue delta = h2e')
        assert.equal(((await wsol(a.platformWsolAta)) - plat0).toString(), platform.toString(), 'platform delta')
        assert.equal(await wsol(a.feeWsolAta), 0n, 'fee ATA empty')
        const cc = decodeCoinConfig((await conn.getAccountInfo(pdas.coinConfig(mint.publicKey)))!.data)
        assert.equal(cc.total_claimed.toString(), claimed.toString(), 'total_claimed')
        // sum invariant
        assert.equal(holder.add(h2e).add(platform).toString(), claimed.toString(), 'transfers sum to claimed')
    })

    it('2. attack: caller-supplied receiver is rejected; funds do not move', async () => {
        const { mint, pool } = await launch()
        await tradeBuy(pool, 0.2, admin)
        const attacker = Keypair.generate(); await airdrop(attacker.publicKey)
        const attackerAta = getAssociatedTokenAddressSync(NATIVE_MINT, attacker.publicKey)
        // create attacker's own WSOL ATA, then substitute it for the constrained fee receiver
        const accts = { caller: attacker.publicKey, mint: mint.publicKey, config: CONFIG, platformWallet }
        const alt = await warmAlt(claimAndSweepAltAddresses(accts))
        const good = claimAndSweepIx(accts)
        const a = sweepAtas(mint.publicKey, platformWallet)
        const tampered = new TransactionInstruction({
            programId: good.programId, data: good.data,
            keys: good.keys.map(k => k.pubkey.equals(a.feeWsolAta) ? { ...k, pubkey: attackerAta } : k),
        })
        let failed = false
        try {
            await sendV0([
                createAssociatedTokenAccountIdempotentInstruction(attacker.publicKey, attackerAta, attacker.publicKey, WSOL_MINT),
                ...sweepAtaIxs(mint.publicKey, platformWallet, attacker.publicKey), tampered,
            ], [attacker], alt)
        } catch (e: any) { failed = true; assert.match(String(e.logs ?? e), /Associated|ConstraintAssociated|AccountNotAssociated|custom program error|2009|3014/, 'expected associated-token constraint failure') }
        assert.isTrue(failed, 'attack must be rejected')
        assert.equal(await wsol(attackerAta), 0n, 'attacker received nothing')
        assert.equal(await wsol(a.payoutWsolAta), 0n, 'vaults untouched (no sweep happened)')
    })

    it('3. permissionless: an unrelated wallet sweeps; funds land in the correct vaults', async () => {
        const { mint, pool } = await launch()
        await tradeBuy(pool, 0.2, admin)
        const claimed = await partnerFee(pool)
        const stranger = Keypair.generate(); await airdrop(stranger.publicKey)
        const a = sweepAtas(mint.publicKey, platformWallet)
        await sweep(mint.publicKey, stranger)
        const holder = claimed.mul(new BN(HOLDER_BPS)).div(new BN(10000))
        assert.equal((await wsol(a.payoutWsolAta)).toString(), holder.toString(), 'stranger sweep still routes to payout vault')
        assert.equal(await wsol(a.feeWsolAta), 0n, 'fee ATA empty')
    })

    it('4. balance below min_sweep_lamports is rejected', async () => {
        const { mint } = await launch()
        await prefundFeeAta(mint.publicKey, 500_000) // < MIN_SWEEP
        let failed = false
        try { await sweep(mint.publicKey, admin) } catch (e: any) { failed = true; assert.match(String(e.logs ?? e), /BelowMinSweep|below min_sweep|custom program error/, 'expected BelowMinSweep') }
        assert.isTrue(failed, 'must reject below min')
    })


    it('5. paused = true is rejected', async () => {
        const { mint, pool } = await launch()
        await tradeBuy(pool, 0.2, admin)
        await sendV0([pauseIx(true, false, admin.publicKey)], [admin]) // paused, launches still allowed
        let failed = false
        try { await sweep(mint.publicKey, admin) } catch (e: any) { failed = true; assert.match(String(e.logs ?? e), /Paused|distribution is paused|custom program error/, 'expected Paused') }
        assert.isTrue(failed, 'must reject when paused')
        await sendV0([pauseIx(false, false, admin.publicKey)], [admin]) // unpause for later tests
    })

    it('9. rounding: claimed not divisible by 60/30/10; sum is exact; remainder to platform', async () => {
        const { mint } = await launch()
        const CLAIMED = 1_000_003 // not divisible: 0.6/0.3/0.1 do not land on integers
        await prefundFeeAta(mint.publicKey, CLAIMED)
        const a = sweepAtas(mint.publicKey, platformWallet)
        const [rev0, plat0] = [await wsol(a.revenueWsolAta), await wsol(a.platformWsolAta)]
        await sweep(mint.publicKey, admin)
        const holder = Math.floor(CLAIMED * HOLDER_BPS / 10000)     // 600001
        const h2e = Math.floor(CLAIMED * H2E_BPS / 10000)           // 300000
        const platform = CLAIMED - holder - h2e                     // 100002
        const idealPlatform = Math.floor(CLAIMED * PLATFORM_BPS / 10000) // 100000
        const remainder = platform - idealPlatform                 // 2
        console.log(`      claimed=${CLAIMED} -> holder=${holder} h2e=${h2e} platform=${platform} (ideal 10%=${idealPlatform}, remainder ${remainder} -> platform)`)
        assert.equal((await wsol(a.payoutWsolAta)).toString(), String(holder))
        assert.equal(((await wsol(a.revenueWsolAta)) - rev0).toString(), String(h2e))
        assert.equal(((await wsol(a.platformWsolAta)) - plat0).toString(), String(platform))
        assert.equal(holder + h2e + platform, CLAIMED, 'transfers sum to exactly claimed')
        assert.equal(await wsol(a.feeWsolAta), 0n, 'fee ATA empty')
        assert.isAbove(remainder, 0, 'this claimed amount exercises a non-zero remainder')
    })
})
