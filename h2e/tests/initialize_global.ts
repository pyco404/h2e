/**
 * Task 1.1 tests — initialize_global.
 *
 * Every instruction is built through the shared client module (../client), the
 * single place that encodes program data. Callers pass spec-exact field names;
 * the client round-trips each encode so mis-serialization throws instead of
 * shipping zeros. See client/index.ts for why program.methods is not used.
 *
 * Uses versioned transactions with an address lookup table (spec §3.2) from the
 * start so later size-bound instructions inherit the pattern.
 *
 * Ordering matters: GlobalConfig is a singleton PDA (seeds ["global"]), so once
 * created it cannot be created again. The rejection cases run BEFORE the
 * successful init so each fails for its own reason, not "account already in use".
 */
import * as anchor from '@coral-xyz/anchor'
import {
    PublicKey, Keypair, SystemProgram, TransactionMessage, VersionedTransaction,
    AddressLookupTableProgram, AddressLookupTableAccount, LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import { assert } from 'chai'
import {
    PROGRAM_ID, pdas, initializeGlobalIx, decodeGlobalConfig, InitializeGlobalParams, BN,
} from '../client'

const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')

describe('initialize_global', () => {
    const provider = anchor.AnchorProvider.env()
    anchor.setProvider(provider)
    const connection = provider.connection
    const authority = (provider.wallet as anchor.Wallet).payer // = deployer = upgrade authority

    const globalConfig = pdas.global()
    const programData = pdas.programData()
    let lookupTable: AddressLookupTableAccount

    // Baseline valid params: bps sum to 10_000. Spec-exact snake_case keys.
    const baseParams = (): InitializeGlobalParams => ({
        admin: Keypair.generate().publicKey,
        keeper: Keypair.generate().publicKey,
        platform_wallet: Keypair.generate().publicKey,
        platform_config_key: Keypair.generate().publicKey,
        usdc_mint: Keypair.generate().publicKey,
        holder_bps: 6000,
        h2e_bps: 3000,
        platform_bps: 1000,
        dev_buy_cap_bps: 300,
        holder_cap_bps: 300,
        epoch_seconds: new BN(86400),
        h2e_epoch_seconds: new BN(604800),
        max_slippage_bps: 100,
        min_sweep_lamports: new BN(1_000_000),
        pool_creation_fee_lamports: new BN(0),
        paused: false,
        pause_launches: false,
    })

    /** Canonical call pattern: build ix via the client, send as a v0 tx + ALT. */
    async function sendInit(params: InitializeGlobalParams, signer: Keypair): Promise<string> {
        const ix = initializeGlobalIx(params, signer.publicKey)
        const { blockhash } = await connection.getLatestBlockhash()
        const msg = new TransactionMessage({
            payerKey: signer.publicKey, recentBlockhash: blockhash, instructions: [ix],
        }).compileToV0Message([lookupTable])
        const tx = new VersionedTransaction(msg)
        tx.sign([signer])
        const sig = await connection.sendTransaction(tx)
        await connection.confirmTransaction(sig, 'confirmed')
        return sig
    }

    const fetchGlobal = async () =>
        decodeGlobalConfig((await connection.getAccountInfo(globalConfig))!.data)

    before('create + warm up an address lookup table', async () => {
        const slot = await connection.getSlot('finalized')
        const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
            authority: authority.publicKey, payer: authority.publicKey, recentSlot: slot,
        })
        const extendIx = AddressLookupTableProgram.extendLookupTable({
            payer: authority.publicKey, authority: authority.publicKey, lookupTable: altAddress,
            addresses: [PROGRAM_ID, programData, SystemProgram.programId, BPF_LOADER_UPGRADEABLE],
        })
        const { blockhash } = await connection.getLatestBlockhash()
        const setupTx = new VersionedTransaction(new TransactionMessage({
            payerKey: authority.publicKey, recentBlockhash: blockhash, instructions: [createIx, extendIx],
        }).compileToV0Message())
        setupTx.sign([authority])
        await connection.confirmTransaction(await connection.sendTransaction(setupTx), 'confirmed')

        let acct = null
        for (let i = 0; i < 40 && !acct; i++) {
            await new Promise(r => setTimeout(r, 400))
            acct = (await connection.getAddressLookupTable(altAddress)).value
        }
        assert.isNotNull(acct, 'lookup table did not activate')
        lookupTable = acct!
        console.log(`      ALT: ${altAddress.toBase58()} (${lookupTable.state.addresses.length} addresses)`)
    })

    it('rejects when bps sum is over 10000', async () => {
        const p = baseParams(); p.platform_bps = 1001 // 6000+3000+1001 = 10001
        try {
            await sendInit(p, authority); assert.fail('expected InvalidSplit')
        } catch (e: any) {
            assert.match(String(e.logs ?? e), /InvalidSplit|must equal 10000/, 'wrong error')
        }
        assert.isNull(await connection.getAccountInfo(globalConfig), 'account must not exist')
    })

    it('rejects when bps sum is under 10000', async () => {
        const p = baseParams(); p.platform_bps = 999 // 6000+3000+999 = 9999
        try {
            await sendInit(p, authority); assert.fail('expected InvalidSplit')
        } catch (e: any) {
            assert.match(String(e.logs ?? e), /InvalidSplit|must equal 10000/, 'wrong error')
        }
        assert.isNull(await connection.getAccountInfo(globalConfig), 'account must not exist')
    })

    it('rejects when the signer is not the upgrade authority', async () => {
        const attacker = Keypair.generate()
        await connection.confirmTransaction(
            await connection.requestAirdrop(attacker.publicKey, 2 * LAMPORTS_PER_SOL), 'confirmed')
        try {
            await sendInit(baseParams(), attacker); assert.fail('expected NotUpgradeAuthority')
        } catch (e: any) {
            assert.match(String(e.logs ?? e), /NotUpgradeAuthority|not the program upgrade authority/, 'wrong error')
        }
        assert.isNull(await connection.getAccountInfo(globalConfig), 'account must not exist')
    })

    it('initializes successfully; every field reads back exactly', async () => {
        const p = baseParams()
        console.log(`      init tx: ${await sendInit(p, authority)}`)
        const gc = await fetchGlobal()

        assert.ok(gc.admin.equals(p.admin), 'admin')
        assert.ok(gc.keeper.equals(p.keeper), 'keeper')
        assert.ok(gc.platform_wallet.equals(p.platform_wallet), 'platform_wallet')
        assert.ok(gc.platform_config_key.equals(p.platform_config_key), 'platform_config_key')
        assert.ok(gc.usdc_mint.equals(p.usdc_mint), 'usdc_mint')
        assert.equal(gc.holder_bps, p.holder_bps, 'holder_bps')
        assert.equal(gc.h2e_bps, p.h2e_bps, 'h2e_bps')
        assert.equal(gc.platform_bps, p.platform_bps, 'platform_bps')
        assert.equal(gc.dev_buy_cap_bps, p.dev_buy_cap_bps, 'dev_buy_cap_bps')
        assert.equal(gc.holder_cap_bps, p.holder_cap_bps, 'holder_cap_bps')
        assert.equal(gc.epoch_seconds.toNumber(), p.epoch_seconds.toNumber(), 'epoch_seconds')
        assert.equal(gc.h2e_epoch_seconds.toNumber(), p.h2e_epoch_seconds.toNumber(), 'h2e_epoch_seconds')
        assert.equal(gc.max_slippage_bps, p.max_slippage_bps, 'max_slippage_bps')
        assert.equal(gc.min_sweep_lamports.toNumber(), p.min_sweep_lamports.toNumber(), 'min_sweep_lamports')
        assert.equal(gc.pool_creation_fee_lamports.toNumber(), p.pool_creation_fee_lamports.toNumber(), 'pool_creation_fee_lamports')
        assert.equal(gc.paused, p.paused, 'paused')
        assert.equal(gc.pause_launches, p.pause_launches, 'pause_launches')
        assert.isAbove(gc.bump, 0, 'bump set')
    })

    it('forces h2e_mint = None and revenue_distribution_enabled = false', async () => {
        const gc = await fetchGlobal()
        assert.isNull(gc.h2e_mint, 'h2e_mint must be None')
        assert.equal(gc.revenue_distribution_enabled, false, 'revenue_distribution_enabled must be false')
    })

    it('rejects re-initialization of an existing GlobalConfig', async () => {
        try {
            await sendInit(baseParams(), authority); assert.fail('expected re-init to fail')
        } catch (e: any) {
            assert.match(String(e.logs ?? e), /already in use|custom program error/, 'expected already-in-use')
        }
    })
})
