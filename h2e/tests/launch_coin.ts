/**
 * Task 1.3 tests — launch_coin, against a local validator with the DBC rail
 * cloned from devnet (see scripts/launch-test.sh). Every state-writing test
 * asserts on-chain readback.
 *
 * GlobalConfig is a singleton with no setter yet, so this session fixes
 * pause_launches=false and pool_creation_fee_lamports=nonzero. The pause=true
 * case (spec test 5) runs in launch_pause.ts against its own session.
 */
import * as anchor from '@coral-xyz/anchor'
import {
    PublicKey, Keypair, TransactionMessage, VersionedTransaction, AddressLookupTableProgram,
    AddressLookupTableAccount, ComputeBudgetProgram, TransactionInstruction, LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import { getAccount } from '@solana/spl-token'
import { assert } from 'chai'
import fs from 'fs'
import {
    DynamicBondingCurveClient, deriveDbcPoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
    PROGRAM_ID, pdas, initializeGlobalIx, launchCoinIx, launchCoinAltAddresses,
    wrapSolIxs, closeWsolIx, decodeCoinConfig, initPlatformAllowlistIx, setPlatformAllowlistIx,
    WSOL_MINT, BN, LaunchCoinAccounts, LaunchCoinParams,
} from '../client'

const POOL_CREATION_FEE = new BN(10_000_000) // 0.01 SOL, non-zero for test 6
const TOTAL_SUPPLY_BASE = new BN('1000000000').mul(new BN(1_000_000)) // 1e9 * 1e6
const DEV_BUY_CAP_BPS = 300
const CAP = TOTAL_SUPPLY_BASE.muln(DEV_BUY_CAP_BPS).divn(10_000) // 3% base units

describe('launch_coin', () => {
    const provider = anchor.AnchorProvider.env(); anchor.setProvider(provider)
    const conn = provider.connection
    const authority = (provider.wallet as anchor.Wallet).payer
    const dbc = DynamicBondingCurveClient.create(conn, 'confirmed')
    const CONFIG = new PublicKey(fs.readFileSync('tests/fixtures/platform-config.txt', 'utf8').trim())
    const platformWallet = Keypair.generate().publicKey

    async function warmAlt(addresses: PublicKey[]): Promise<AddressLookupTableAccount> {
        const slot = await conn.getSlot('finalized')
        const [createIx, altAddr] = AddressLookupTableProgram.createLookupTable({ authority: authority.publicKey, payer: authority.publicKey, recentSlot: slot })
        const extendIx = AddressLookupTableProgram.extendLookupTable({ payer: authority.publicKey, authority: authority.publicKey, lookupTable: altAddr, addresses })
        const { blockhash } = await conn.getLatestBlockhash()
        const t = new VersionedTransaction(new TransactionMessage({ payerKey: authority.publicKey, recentBlockhash: blockhash, instructions: [createIx, extendIx] }).compileToV0Message()); t.sign([authority])
        await conn.confirmTransaction(await conn.sendTransaction(t), 'confirmed')
        // Wait until the extended ALT is active for lookups (its address count
        // matches, then a short settle) to avoid "invalid table lookup index".
        let alt: AddressLookupTableAccount | null = null
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 400))
            alt = (await conn.getAddressLookupTable(altAddr)).value
            if (alt && alt.state.addresses.length >= addresses.length) break
        }
        await new Promise(r => setTimeout(r, 1200))
        return alt!
    }

    async function sendV0(ixs: TransactionInstruction[], signers: Keypair[], alt?: AddressLookupTableAccount) {
        const { blockhash } = await conn.getLatestBlockhash()
        const msg = new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alt ? [alt] : [])
        const tx = new VersionedTransaction(msg); tx.sign(signers)
        const size = tx.serialize().length
        const sig = await conn.sendTransaction(tx)
        await conn.confirmTransaction(sig, 'confirmed')
        const meta = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
        return { sig, size, cu: meta?.meta?.computeUnitsConsumed }
    }

    /** Build a full launch (wrap? + launch + close?) and its ALT, and send it. */
    async function launch(accts: LaunchCoinAccounts, params: LaunchCoinParams, mintKp: Keypair) {
        const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]
        if (params.dev_buy_lamports.gtn(0)) ixs.push(...wrapSolIxs(accts.payer, params.dev_buy_lamports).ixs)
        ixs.push(launchCoinIx(params, accts))
        if (params.dev_buy_lamports.gtn(0)) ixs.push(closeWsolIx(accts.payer))
        const alt = await warmAlt(launchCoinAltAddresses(accts))
        return sendV0(ixs, [authority, mintKp], alt)
    }

    function acct(baseMint: PublicKey): LaunchCoinAccounts {
        return { payer: authority.publicKey, baseMint, config: CONFIG, platformWallet }
    }

    before('initialize GlobalConfig pinned to the cloned platform config', async () => {
        const ix = initializeGlobalIx({
            admin: authority.publicKey, keeper: Keypair.generate().publicKey,
            platform_wallet: platformWallet, platform_config_key: CONFIG, usdc_mint: Keypair.generate().publicKey,
            holder_bps: 6000, h2e_bps: 3000, platform_bps: 1000, dev_buy_cap_bps: DEV_BUY_CAP_BPS, holder_cap_bps: 300,
            epoch_seconds: new BN(86400), h2e_epoch_seconds: new BN(604800), max_slippage_bps: 100,
            min_sweep_lamports: new BN(1_000_000), pool_creation_fee_lamports: POOL_CREATION_FEE,
            paused: false, pause_launches: false,
        }, authority.publicKey)
        await sendV0([ix], [authority])
        // Task 1.9: launch_coin validates default_payout_mint against the standing
        // allowlist, so it must exist and contain the pairing asset (WSOL here).
        await sendV0([initPlatformAllowlistIx(authority.publicKey), setPlatformAllowlistIx(WSOL_MINT, true, authority.publicKey)], [authority])
    })

    // Reference pool used to size the dev buy (identical curve to every pool).
    let refPool: PublicKey
    let sizedUnder: BN, sizedOver: BN

    it('1. dev_buy = 0: pool created, CoinConfig correct, caller holds no tokens', async () => {
        const mint = Keypair.generate()
        const r = await launch(acct(mint.publicKey), { name: 'Coin One', symbol: 'C1', uri: 'https://x.io/1.json', dev_buy_lamports: new BN(0), default_payout_mint: WSOL_MINT }, mint)
        console.log(`      create-only: CU=${r.cu}  size=${r.size} bytes (limit 1232)`)

        const cc = decodeCoinConfig((await conn.getAccountInfo(pdas.coinConfig(mint.publicKey)))!.data)
        assert.ok(cc.mint.equals(mint.publicKey), 'mint')
        assert.ok(cc.creator_wallet.equals(authority.publicKey), 'creator_wallet')
        assert.isNull(cc.damm_pool, 'damm_pool None')
        assert.isNull(cc.locked_position, 'locked_position None')
        assert.equal(Object.keys(cc.status)[0], 'Bonding', 'status Bonding')
        // caller holds no base tokens (no ATA created)
        const ata = await conn.getAccountInfo(anchorAta(mint.publicKey, authority.publicKey))
        assert.isNull(ata, 'no dev base ATA / no tokens')
        refPool = new PublicKey(cc.dbc_pool)
    })

    it('sizes the dev buy from the reference pool', async () => {
        const poolState = await dbc.state.getPool(refPool)
        const cfgState = await dbc.state.getPoolConfig(CONFIG)
        const out = (lamports: number): BN => (dbc.pool.swapQuote({ virtualPool: poolState!, config: cfgState, swapBaseForQuote: false, amountIn: new BN(lamports), slippageBps: 5000, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint: new BN(Math.floor(Date.now() / 1000)) }) as any).outputAmount as BN
        const target = TOTAL_SUPPLY_BASE.muln(29).divn(1000) // 2.9%
        let lo = 1000, hi = 500_000_000, under = 1000
        for (let i = 0; i < 40 && lo <= hi; i++) { const mid = Math.floor((lo + hi) / 2); let o: BN; try { o = out(mid) } catch { hi = mid - 1; continue }; if (o.lte(target)) { under = mid; lo = mid + 1 } else hi = mid - 1 }
        sizedUnder = new BN(under)
        let over = under; for (let i = 0; i < 40; i++) { over = Math.floor(over * 1.15) + 1000; let o: BN; try { o = out(over) } catch { break }; if (o.gt(CAP)) break }
        sizedOver = new BN(over)
        console.log(`      under: ${under} lamports -> ${(out(under).toNumber() / TOTAL_SUPPLY_BASE.toNumber() * 100).toFixed(4)}%`)
        console.log(`      over : ${over} lamports -> ${(out(over).toNumber() / TOTAL_SUPPLY_BASE.toNumber() * 100).toFixed(4)}%`)
        assert.ok(out(under).lte(CAP), 'under <= cap'); assert.ok(out(over).gt(CAP), 'over > cap')
    })

    it('2. dev buy just under the cap: succeeds; prints exact percentage', async () => {
        const mint = Keypair.generate()
        const r = await launch(acct(mint.publicKey), { name: 'Coin Two', symbol: 'C2', uri: 'https://x.io/2.json', dev_buy_lamports: sizedUnder, default_payout_mint: WSOL_MINT }, mint)
        const bal = (await getAccount(conn, anchorAta(mint.publicKey, authority.publicKey))).amount
        const pct = Number(bal) / TOTAL_SUPPLY_BASE.toNumber() * 100
        console.log(`      create+buy: CU=${r.cu}  size=${r.size} bytes (limit 1232)`)
        console.log(`      dev acquired ${bal} base units = ${pct.toFixed(4)}% of supply (cap 3%)`)
        assert.isBelow(pct, 3.0, 'under 3%')
        assert.ok(new BN(bal.toString()).lte(CAP), 'acquired <= cap')
    })

    it('3. dev buy over the cap: whole tx reverts, no pool, no CoinConfig', async () => {
        const mint = Keypair.generate()
        let failed = false
        try { await launch(acct(mint.publicKey), { name: 'Coin Three', symbol: 'C3', uri: 'https://x.io/3.json', dev_buy_lamports: sizedOver, default_payout_mint: WSOL_MINT }, mint) }
        catch (e: any) { failed = true; assert.match(String(e.logs ?? e), /DevBuyExceedsCap|exceeds the supply cap|custom program error/, 'expected cap error') }
        assert.isTrue(failed, 'must revert')
        assert.isNull(await conn.getAccountInfo(pdas.coinConfig(mint.publicKey)), 'no CoinConfig')
        assert.isNull(await conn.getAccountInfo(deriveDbcPoolAddress(WSOL_MINT, mint.publicKey, CONFIG)), 'no pool')
    })

    it('4. launch against a config that is not platform_config_key: rejected', async () => {
        const mint = Keypair.generate()
        const wrongConfig = Keypair.generate().publicKey
        let failed = false
        try { await launch({ payer: authority.publicKey, baseMint: mint.publicKey, config: wrongConfig, platformWallet }, { name: 'Bad', symbol: 'BAD', uri: 'https://x.io/b.json', dev_buy_lamports: new BN(0), default_payout_mint: WSOL_MINT }, mint) }
        catch (e: any) { failed = true; assert.match(String(e.logs ?? e), /WrongConfig|not the platform config|custom program error/, 'expected WrongConfig') }
        assert.isTrue(failed, 'must revert')
        assert.isNull(await conn.getAccountInfo(pdas.coinConfig(mint.publicKey)), 'no CoinConfig')
    })

    it('6. pool_creation_fee_lamports non-zero: platform_wallet increases by exactly that', async () => {
        const before = await conn.getBalance(platformWallet)
        const mint = Keypair.generate()
        await launch(acct(mint.publicKey), { name: 'Coin Six', symbol: 'C6', uri: 'https://x.io/6.json', dev_buy_lamports: new BN(0), default_payout_mint: WSOL_MINT }, mint)
        const after = await conn.getBalance(platformWallet)
        assert.equal(after - before, POOL_CREATION_FEE.toNumber(), 'exact fee credited')
    })

    it('7. CoinConfig fields: Bonding, None pools, launch_ts within a sane window', async () => {
        const mint = Keypair.generate()
        const t0 = Math.floor(Date.now() / 1000)
        await launch(acct(mint.publicKey), { name: 'Coin Seven', symbol: 'C7', uri: 'https://x.io/7.json', dev_buy_lamports: new BN(0), default_payout_mint: WSOL_MINT }, mint)
        const cc = decodeCoinConfig((await conn.getAccountInfo(pdas.coinConfig(mint.publicKey)))!.data)
        assert.equal(Object.keys(cc.status)[0], 'Bonding', 'Bonding')
        assert.isNull(cc.damm_pool, 'damm_pool None'); assert.isNull(cc.locked_position, 'locked_position None')
        const ts = cc.launch_ts.toNumber()
        assert.isAtLeast(ts, t0 - 120, 'launch_ts not in the past'); assert.isAtMost(ts, t0 + 120, 'launch_ts not in the future')
    })

    it('8. created pool config.fee_claimer is the global ["fee"] PDA', async () => {
        // The platform config's fee_claimer is our fee PDA; the pool inherits it.
        const cfgState = await dbc.state.getPoolConfig(CONFIG)
        const feePda = pdas.feeClaimer()
        assert.ok(cfgState.feeClaimer.equals(feePda), 'config.fee_claimer == fee PDA')
    })

    // ---- Task 1.9: default_payout_mint ----
    it('1.9-4. default_payout_mint in the allowlist: launch succeeds, field reads back on-chain', async () => {
        const mint = Keypair.generate()
        await launch(acct(mint.publicKey), { name: 'Pair', symbol: 'PR', uri: 'https://x.io/pr.json', dev_buy_lamports: new BN(0), default_payout_mint: WSOL_MINT }, mint)
        const cc = decodeCoinConfig((await conn.getAccountInfo(pdas.coinConfig(mint.publicKey)))!.data)
        assert.ok(cc.default_payout_mint.equals(WSOL_MINT), 'permanent pairing stored on-chain')
    })

    it('1.9-5. default_payout_mint not in the allowlist: whole tx reverts, no CoinConfig', async () => {
        const mint = Keypair.generate()
        const notAllowed = Keypair.generate().publicKey
        let failed = false
        try {
            await launch(acct(mint.publicKey), { name: 'Bad', symbol: 'BD', uri: 'https://x.io/bd.json', dev_buy_lamports: new BN(0), default_payout_mint: notAllowed }, mint)
        } catch (e: any) {
            failed = true
            assert.match(String(e.logs ?? e), /OutMintNotAllowed|not in this round|custom program error/, 'expected allowlist rejection')
        }
        assert.isTrue(failed, 'must revert')
        assert.isNull(await conn.getAccountInfo(pdas.coinConfig(mint.publicKey)), 'no CoinConfig created')
    })

    it('1.9-7. launch still fits the 1232-byte tx budget with the extra allowlist account', async () => {
        const mint = Keypair.generate()
        const r = await launch(acct(mint.publicKey), { name: 'Budget', symbol: 'BG', uri: 'https://x.io/bg.json', dev_buy_lamports: new BN(0), default_payout_mint: WSOL_MINT }, mint)
        console.log(`      launch_coin with PlatformAllowlist account: CU=${r.cu}  size=${r.size} bytes (limit 1232)`)
        assert.isAtMost(r.size, 1232, 'fits the tx size limit with the extra account')
    })
})

// Local ATA derivation (avoid importing spl-token twice with different types).
function anchorAta(mint: PublicKey, owner: PublicKey): PublicKey {
    const { getAssociatedTokenAddressSync } = require('@solana/spl-token')
    return getAssociatedTokenAddressSync(mint, owner)
}
