/**
 * Task 1.4 tests — admin instructions. Runs on the cloned-DBC validator so test
 * 6 (pause_launches blocks launch_coin) can exercise a real launch and then a
 * pause in a single session. Every state-writing test asserts on-chain readback.
 */
import * as anchor from '@coral-xyz/anchor'
import {
    PublicKey, Keypair, TransactionMessage, VersionedTransaction, TransactionInstruction,
    AddressLookupTableProgram, AddressLookupTableAccount, LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import { assert } from 'chai'
import fs from 'fs'
import {
    pdas, initializeGlobalIx, decodeGlobalConfig, decodeDenylist, WSOL_MINT,
    initPlatformAllowlistIx, setPlatformAllowlistIx,
    setParamsIx, setKeeperIx, setAdminIx, setH2eMintIx, pauseIx, setDenylistIx, DenyKind,
    setPlatformWalletIx, setPlatformConfigKeyIx, initDenylistIx,
    launchCoinIx, launchCoinAltAddresses, BN, SetParamsArgs,
} from '../client'

describe('admin instructions', () => {
    const provider = anchor.AnchorProvider.env(); anchor.setProvider(provider)
    const conn = provider.connection
    const admin = (provider.wallet as anchor.Wallet).payer // = upgrade authority = admin
    const CONFIG = new PublicKey(fs.readFileSync('tests/fixtures/platform-config.txt', 'utf8').trim())
    const platformWallet = Keypair.generate().publicKey
    const keeper = Keypair.generate()
    const unrelated = Keypair.generate()
    const newAdmin = Keypair.generate()
    const global = pdas.global()

    const baseParams = (): SetParamsArgs => ({
        holder_bps: 6000, h2e_bps: 3000, platform_bps: 1000, dev_buy_cap_bps: 300, holder_cap_bps: 300,
        epoch_seconds: new BN(86400), h2e_epoch_seconds: new BN(604800), max_slippage_bps: 100,
        min_sweep_lamports: new BN(1_000_000), pool_creation_fee_lamports: new BN(0),
        usdc_mint: Keypair.generate().publicKey,
    })

    async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
        const { blockhash } = await conn.getLatestBlockhash()
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message())
        tx.sign(signers); await conn.confirmTransaction(await conn.sendTransaction(tx), 'confirmed')
    }
    async function expectReject(ix: TransactionInstruction, signer: Keypair, pattern = /NotAdmin|not the admin|custom program error/) {
        let failed = false
        try { await send([ix], [signer]) } catch (e: any) { failed = true; assert.match(String(e.logs ?? e), pattern, 'wrong error') }
        assert.isTrue(failed, 'expected rejection')
    }
    const readGlobal = async () => decodeGlobalConfig((await conn.getAccountInfo(global))!.data)

    before('fund keys + initialize GlobalConfig', async () => {
        for (const kp of [keeper, unrelated, newAdmin]) await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL), 'confirmed')
        await send([initializeGlobalIx({
            admin: admin.publicKey, keeper: keeper.publicKey, platform_wallet: platformWallet,
            platform_config_key: CONFIG, usdc_mint: Keypair.generate().publicKey,
            holder_bps: 6000, h2e_bps: 3000, platform_bps: 1000, dev_buy_cap_bps: 300, holder_cap_bps: 300,
            epoch_seconds: new BN(86400), h2e_epoch_seconds: new BN(604800), max_slippage_bps: 100,
            min_sweep_lamports: new BN(1_000_000), pool_creation_fee_lamports: new BN(0),
            paused: false, pause_launches: false,
        }, admin.publicKey)], [admin])
        // Task 1.9: allow WSOL so the launch test's default_payout_mint validates
        await send([initPlatformAllowlistIx(admin.publicKey), setPlatformAllowlistIx(WSOL_MINT, true, admin.publicKey)], [admin])
    })

    // ix builders keyed by name, parameterised by the "admin" account they present.
    const builders: Record<string, (a: PublicKey) => TransactionInstruction> = {
        set_params: (a) => setParamsIx(baseParams(), a),
        set_keeper: (a) => setKeeperIx(Keypair.generate().publicKey, a),
        set_admin: (a) => setAdminIx(Keypair.generate().publicKey, a),
        set_h2e_mint: (a) => setH2eMintIx(Keypair.generate().publicKey, true, a),
        pause: (a) => pauseIx(true, true, a),
        set_denylist: (a) => setDenylistIx(DenyKind.PayoutAddress, Keypair.generate().publicKey, true, a),
        set_platform_wallet: (a) => setPlatformWalletIx(Keypair.generate().publicKey, a),
        set_platform_config_key: (a) => setPlatformConfigKeyIx(Keypair.generate().publicKey, a),
        init_denylist: (a) => initDenylistIx(a),
    }

    it('2+3. every admin instruction is rejected when signed by keeper or an unrelated wallet', async () => {
        for (const [name, build] of Object.entries(builders)) {
            await expectReject(build(keeper.publicKey), keeper)
            await expectReject(build(unrelated.publicKey), unrelated)
        }
    })

    it('4. set_params rejects a bps set that does not sum to 10,000', async () => {
        const over = baseParams(); over.platform_bps = 1001
        await expectReject(setParamsIx(over, admin.publicKey), admin, /InvalidSplit|must equal 10000|custom program error/)
        const under = baseParams(); under.holder_bps = 5999
        await expectReject(setParamsIx(under, admin.publicKey), admin, /InvalidSplit|must equal 10000|custom program error/)
    })

    it('1. set_params succeeds when signed by admin; readback exact', async () => {
        const p = baseParams(); p.dev_buy_cap_bps = 250; p.max_slippage_bps = 175; p.min_sweep_lamports = new BN(2_222_222)
        await send([setParamsIx(p, admin.publicKey)], [admin])
        const gc = await readGlobal()
        assert.equal(gc.dev_buy_cap_bps, 250); assert.equal(gc.max_slippage_bps, 175)
        assert.equal(gc.min_sweep_lamports.toNumber(), 2_222_222)
        assert.equal(gc.holder_bps + gc.h2e_bps + gc.platform_bps, 10000)
    })

    it('1. set_keeper succeeds when signed by admin; readback exact', async () => {
        const nk = Keypair.generate().publicKey
        await send([setKeeperIx(nk, admin.publicKey)], [admin])
        assert.ok((await readGlobal()).keeper.equals(nk), 'keeper updated')
    })

    it('5. set_h2e_mint: enabling with None is rejected; setting mint+enable works', async () => {
        await expectReject(setH2eMintIx(null, true, admin.publicKey), admin, /CannotEnableWithoutMint|while h2e_mint is None|custom program error/)
        const mint = Keypair.generate().publicKey
        await send([setH2eMintIx(mint, true, admin.publicKey)], [admin])
        const gc = await readGlobal()
        assert.ok(gc.h2e_mint.equals(mint), 'h2e_mint set'); assert.equal(gc.revenue_distribution_enabled, true, 'enabled')
        // clearing + disabling also works
        await send([setH2eMintIx(null, false, admin.publicKey)], [admin])
        const gc2 = await readGlobal()
        assert.isNull(gc2.h2e_mint, 'cleared'); assert.equal(gc2.revenue_distribution_enabled, false, 'disabled')
    })

    it('1. init_denylist + set_platform_wallet/config_key succeed when signed by admin', async () => {
        await send([initDenylistIx(admin.publicKey)], [admin])
        const nw = Keypair.generate().publicKey, nc = Keypair.generate().publicKey
        await send([setPlatformWalletIx(nw, admin.publicKey)], [admin])
        await send([setPlatformConfigKeyIx(nc, admin.publicKey)], [admin])
        const gc = await readGlobal()
        assert.ok(gc.platform_wallet.equals(nw), 'platform_wallet updated')
        assert.ok(gc.platform_config_key.equals(nc), 'platform_config_key updated')
        // restore platform_config_key so nothing downstream is surprised
        await send([setPlatformConfigKeyIx(CONFIG, admin.publicKey)], [admin])
        await send([setPlatformWalletIx(platformWallet, admin.publicKey)], [admin])
    })

    it('1. set_denylist add/remove succeeds when signed by admin; readback', async () => {
        const addr = Keypair.generate().publicKey, mint = Keypair.generate().publicKey
        await send([setDenylistIx(DenyKind.PayoutAddress, addr, true, admin.publicKey)], [admin])
        await send([setDenylistIx(DenyKind.PayoutMint, mint, true, admin.publicKey)], [admin])
        let dl = decodeDenylist((await conn.getAccountInfo(pdas.denylist()))!.data)
        assert.ok(dl.addresses.some((k: PublicKey) => k.equals(addr)), 'addr added')
        assert.ok(dl.mints.some((k: PublicKey) => k.equals(mint)), 'mint added')
        await send([setDenylistIx(DenyKind.PayoutAddress, addr, false, admin.publicKey)], [admin])
        dl = decodeDenylist((await conn.getAccountInfo(pdas.denylist()))!.data)
        assert.notOk(dl.addresses.some((k: PublicKey) => k.equals(addr)), 'addr removed')
        assert.ok(dl.mints.some((k: PublicKey) => k.equals(mint)), 'mint still present')
    })

    it('1. pause succeeds when signed by admin; readback', async () => {
        await send([pauseIx(true, false, admin.publicKey)], [admin])
        const gc = await readGlobal()
        assert.equal(gc.paused, true, 'paused'); assert.equal(gc.pause_launches, false, 'launches still allowed')
    })

    it('6. pause_launches via admin then blocks launch_coin (single session)', async () => {
        async function launch(mint: Keypair) {
            const accts = { payer: admin.publicKey, baseMint: mint.publicKey, config: CONFIG, platformWallet }
            const slot = await conn.getSlot('finalized')
            const [c, altAddr] = AddressLookupTableProgram.createLookupTable({ authority: admin.publicKey, payer: admin.publicKey, recentSlot: slot })
            const e = AddressLookupTableProgram.extendLookupTable({ payer: admin.publicKey, authority: admin.publicKey, lookupTable: altAddr, addresses: launchCoinAltAddresses(accts) })
            await send([c, e], [admin])
            let alt: AddressLookupTableAccount | null = null
            for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 400)); alt = (await conn.getAddressLookupTable(altAddr)).value; if (alt && alt.state.addresses.length >= launchCoinAltAddresses(accts).length) break }
            await new Promise(r => setTimeout(r, 1200))
            const ix = launchCoinIx({ name: 'PZ', symbol: 'PZ', uri: 'https://x.io/p.json', dev_buy_lamports: new BN(0), default_payout_mint: WSOL_MINT }, accts)
            const { blockhash } = await conn.getLatestBlockhash()
            const tx = new VersionedTransaction(new TransactionMessage({ payerKey: admin.publicKey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message([alt!]))
            tx.sign([admin, mint]); await conn.confirmTransaction(await conn.sendTransaction(tx), 'confirmed')
        }
        // launches allowed now (pause_launches=false) -> succeeds
        await launch(Keypair.generate())
        // admin turns launches off
        await send([pauseIx(false, true, admin.publicKey)], [admin])
        assert.equal((await readGlobal()).pause_launches, true, 'pause_launches on')
        // now a launch reverts
        const blocked = Keypair.generate()
        let failed = false
        try { await launch(blocked) } catch (e: any) { failed = true; assert.match(String(e.logs ?? e), /LaunchesPaused|launches are paused|custom program error/, 'expected LaunchesPaused') }
        assert.isTrue(failed, 'launch must be blocked')
        assert.isNull(await conn.getAccountInfo(pdas.coinConfig(blocked.publicKey)), 'no CoinConfig')
    })

    it('7. changing admin works; the old admin is rejected afterwards', async () => {
        await send([setAdminIx(newAdmin.publicKey, admin.publicKey)], [admin])
        assert.ok((await readGlobal()).admin.equals(newAdmin.publicKey), 'admin updated')
        // old admin can no longer call admin instructions
        await expectReject(pauseIx(true, true, admin.publicKey), admin)
        // new admin can
        await send([pauseIx(false, false, newAdmin.publicKey)], [newAdmin])
        const gc = await readGlobal()
        assert.equal(gc.paused, false); assert.equal(gc.pause_launches, false)
    })
})
