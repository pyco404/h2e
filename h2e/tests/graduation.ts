/**
 * Task 1.6 tests — sync_graduation, the graduated claim path, retire_coin.
 * Drives real migrations on the cloned DBC+cp-amm rail. Every state-writing test
 * asserts on-chain readback.
 */
import * as anchor from '@coral-xyz/anchor'
import {
    PublicKey, Keypair, TransactionMessage, VersionedTransaction, Transaction, TransactionInstruction,
    AddressLookupTableProgram, AddressLookupTableAccount, ComputeBudgetProgram, SystemProgram, LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token'
import { assert } from 'chai'
import fs from 'fs'
import BN from 'bn.js'
import {
    DynamicBondingCurveClient, deriveDbcPoolAddress, deriveDammV2MigrationMetadataAddress,
    deriveDammV2PoolAddress, deriveDammV2TokenVaultAddress, derivePositionAddress, derivePositionNftAccount,
    SwapMode, DAMM_V2_MIGRATION_FEE_ADDRESS, MigrationFeeOption,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import {
    pdas, initializeGlobalIx, launchCoinIx, launchCoinAltAddresses, decodeCoinConfig,
    syncGraduationIx, retireCoinIx, claimAndSweepIx, claimAndSweepAltAddresses, sweepAtas, sweepAtaIxs,
    initPlatformAllowlistIx, setPlatformAllowlistIx, WSOL_MINT, GraduatedRail,
} from '../client'

const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const DBC_POOL_AUTHORITY = new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM')

describe('graduation', () => {
    const provider = anchor.AnchorProvider.env(); anchor.setProvider(provider)
    const conn = provider.connection
    const admin = (provider.wallet as anchor.Wallet).payer
    const dbc = DynamicBondingCurveClient.create(conn, 'confirmed')
    const cpAmm = new CpAmm(conn)
    const CONFIG = new PublicKey(fs.readFileSync('tests/fixtures/platform-config.txt', 'utf8').trim())
    const DAMM_CFG = DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100]
    const platformWallet = Keypair.generate().publicKey
    const keeper = Keypair.generate(), unrelated = Keypair.generate()

    async function airdrop(pk: PublicKey, sol = 5) { await conn.confirmTransaction(await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL), 'confirmed') }
    async function sendLegacy(tx: Transaction, signers: Keypair[]) { tx.feePayer = signers[0].publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.sign(...signers); await conn.confirmTransaction(await conn.sendRawTransaction(tx.serialize()), 'confirmed') }
    async function sendV0(ixs: TransactionInstruction[], signers: Keypair[], alt?: AddressLookupTableAccount) {
        const { blockhash } = await conn.getLatestBlockhash()
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alt ? [alt] : []))
        tx.sign(signers); const sig = await conn.sendTransaction(tx); await conn.confirmTransaction(sig, 'confirmed')
        const meta = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
        return { sig, size: tx.serialize().length, cu: meta?.meta?.computeUnitsConsumed }
    }
    async function warmAlt(addresses: PublicKey[]): Promise<AddressLookupTableAccount> {
        const slot = await conn.getSlot('finalized')
        const [c, altAddr] = AddressLookupTableProgram.createLookupTable({ authority: admin.publicKey, payer: admin.publicKey, recentSlot: slot })
        await sendV0([c], [admin])
        // Extend in chunks so the extend tx itself never exceeds the size limit.
        for (let i = 0; i < addresses.length; i += 18) {
            await sendV0([AddressLookupTableProgram.extendLookupTable({ payer: admin.publicKey, authority: admin.publicKey, lookupTable: altAddr, addresses: addresses.slice(i, i + 18) })], [admin])
        }
        let alt: AddressLookupTableAccount | null = null
        for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 400)); alt = (await conn.getAddressLookupTable(altAddr)).value; if (alt && alt.state.addresses.length >= addresses.length) break }
        await new Promise(r => setTimeout(r, 1200)); return alt!
    }
    async function launch(): Promise<{ mint: Keypair, pool: PublicKey }> {
        const mint = Keypair.generate()
        const accts = { payer: admin.publicKey, baseMint: mint.publicKey, config: CONFIG, platformWallet }
        const alt = await warmAlt(launchCoinAltAddresses(accts))
        await sendV0([launchCoinIx({ name: 'G', symbol: 'G', uri: 'https://x.io/g.json', dev_buy_lamports: new BN(0), default_payout_mint: WSOL_MINT }, accts)], [admin, mint], alt)
        return { mint, pool: deriveDbcPoolAddress(WSOL_MINT, mint.publicKey, CONFIG) }
    }
    type Grad = { mint: PublicKey, pool: PublicKey, dammPool: PublicKey, firstPos: PublicKey, firstNftAcc: PublicKey, secondPos: PublicKey, secondNftAcc: PublicKey }
    async function migrate(): Promise<Grad> {
        const { mint, pool } = await launch()
        for (let i = 0; i < 40; i++) {
            if ((await dbc.state.getPool(pool))!.poolState.migrationProgress !== 0) break
            const tx: Transaction = await dbc.pool.swap2({ owner: admin.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null, swapMode: SwapMode.PartialFill, amountIn: new BN(0.5 * LAMPORTS_PER_SOL), minimumAmountOut: new BN(0) })
            await sendLegacy(tx, [admin])
        }
        await sendV0([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: DBC_POOL_AUTHORITY, lamports: 0.5 * LAMPORTS_PER_SOL })], [admin])
        const meta = deriveDammV2MigrationMetadataAddress(pool)
        const [dbcEv] = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], DBC_PROGRAM)
        await sendLegacy(new Transaction().add(new TransactionInstruction({ programId: DBC_PROGRAM, data: Buffer.from([109,189,19,36,195,183,222,82]), keys: [
            { pubkey: pool, isSigner: false, isWritable: false }, { pubkey: CONFIG, isSigner: false, isWritable: false }, { pubkey: meta, isSigner: false, isWritable: true },
            { pubkey: admin.publicKey, isSigner: true, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: dbcEv, isSigner: false, isWritable: false }, { pubkey: DBC_PROGRAM, isSigner: false, isWritable: false } ] })), [admin])
        const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await dbc.migration.migrateToDammV2({ pool, dammConfig: DAMM_CFG, payer: admin.publicKey })
        await sendLegacy(transaction, [admin, firstPositionNftKeypair, secondPositionNftKeypair])
        return {
            mint: mint.publicKey, pool, dammPool: deriveDammV2PoolAddress(DAMM_CFG, mint.publicKey, WSOL_MINT),
            firstPos: derivePositionAddress(firstPositionNftKeypair.publicKey), firstNftAcc: derivePositionNftAccount(firstPositionNftKeypair.publicKey),
            secondPos: derivePositionAddress(secondPositionNftKeypair.publicKey), secondNftAcc: derivePositionNftAccount(secondPositionNftKeypair.publicKey),
        }
    }
    const rail = (g: Grad): GraduatedRail => ({ dammPool: g.dammPool, position: g.firstPos, tokenAVault: deriveDammV2TokenVaultAddress(g.dammPool, g.mint), tokenBVault: deriveDammV2TokenVaultAddress(g.dammPool, WSOL_MINT), positionNftAccount: g.firstNftAcc })
    const syncArgs = (g: Grad, over?: Partial<{ dammPool: PublicKey, position: PublicKey, nftAcc: PublicKey }>) => ({ caller: admin.publicKey, mint: g.mint, dbcPool: g.pool, dammPool: over?.dammPool ?? g.dammPool, lockedPosition: over?.position ?? g.firstPos, positionNftAccount: over?.nftAcc ?? g.firstNftAcc })
    async function wsol(a: PublicKey): Promise<bigint> { try { return (await getAccount(conn, a)).amount } catch { return 0n } }

    let main: Grad, neg: Grad

    before(async function () {
        this.timeout(300000)
        for (const kp of [keeper, unrelated]) await airdrop(kp.publicKey)
        await sendV0([initializeGlobalIx({ admin: admin.publicKey, keeper: keeper.publicKey, platform_wallet: platformWallet, platform_config_key: CONFIG, usdc_mint: Keypair.generate().publicKey, holder_bps: 6000, h2e_bps: 3000, platform_bps: 1000, dev_buy_cap_bps: 300, holder_cap_bps: 300, epoch_seconds: new BN(86400), h2e_epoch_seconds: new BN(604800), max_slippage_bps: 100, min_sweep_lamports: new BN(1000), pool_creation_fee_lamports: new BN(0), paused: false, pause_launches: false }, admin.publicKey)], [admin])
        // Task 1.9: permit WSOL as a payout asset (default_payout_mint + allowed_mints)
        await sendV0([initPlatformAllowlistIx(admin.publicKey), setPlatformAllowlistIx(WSOL_MINT, true, admin.publicKey)], [admin])
        main = await migrate()
        neg = await migrate()
    })

    it('1. sync_graduation on a still-bonding coin is rejected', async () => {
        const { mint, pool } = await launch()
        const g: Grad = { mint: mint.publicKey, pool, dammPool: main.dammPool, firstPos: main.firstPos, firstNftAcc: main.firstNftAcc, secondPos: main.secondPos, secondNftAcc: main.secondNftAcc }
        let failed = false
        try { await sendV0([syncGraduationIx(syncArgs(g))], [admin]) } catch (e: any) { failed = true; assert.match(String(e.logs ?? e), /NotMigrated|not migrated|custom program error/, 'expected NotMigrated') }
        assert.isTrue(failed)
    })

    it('3. sync with a locked_position whose NFT authority is not the fee PDA is rejected', async () => {
        // neg's SECOND (creator) position: its NFT is owned by the creator, not the fee PDA
        let failed = false
        try { await sendV0([syncGraduationIx(syncArgs(neg, { position: neg.secondPos, nftAcc: neg.secondNftAcc }))], [admin]) }
        catch (e: any) { failed = true; assert.match(String(e.logs ?? e), /WrongPositionOwner|not held by the fee PDA|WrongLockedPosition|custom program error/, 'expected owner/position error') }
        assert.isTrue(failed)
    })

    it('4. sync with a damm_pool belonging to a different coin is rejected', async () => {
        let failed = false
        try { await sendV0([syncGraduationIx(syncArgs(neg, { dammPool: main.dammPool }))], [admin]) }
        catch (e: any) { failed = true; assert.match(String(e.logs ?? e), /WrongDammPool|does not belong|custom program error/, 'expected WrongDammPool') }
        assert.isTrue(failed)
        // neg is still Bonding (failed syncs do not mutate)
        assert.equal(Object.keys(decodeCoinConfig((await conn.getAccountInfo(pdas.coinConfig(neg.mint)))!.data).status)[0], 'Bonding')
    })

    it('2. sync_graduation on a migrated coin records damm_pool + locked_position', async () => {
        await sendV0([syncGraduationIx(syncArgs(main))], [admin])
        const cc = decodeCoinConfig((await conn.getAccountInfo(pdas.coinConfig(main.mint)))!.data)
        assert.equal(Object.keys(cc.status)[0], 'Graduated', 'status Graduated')
        assert.ok(cc.damm_pool.equals(main.dammPool), 'damm_pool recorded')
        assert.ok(cc.locked_position.equals(main.firstPos), 'locked_position recorded')
        // the recorded position's NFT is held by the fee PDA
        const nftAcc = await getAccount(conn, main.firstNftAcc, 'confirmed', require('@solana/spl-token').TOKEN_2022_PROGRAM_ID)
        assert.ok(nftAcc.owner.equals(pdas.feeClaimer()), 'position NFT owned by fee PDA')
    })

    it('9. the creator (second) locked position is empty', async () => {
        const info = await conn.getAccountInfo(main.secondPos)
        if (!info) { console.log('      creator position not minted (0 liquidity) — empty by absence'); return }
        const pos = await cpAmm.fetchPositionState(main.secondPos)
        assert.equal(pos.permanentLockedLiquidity.toString(), '0', 'creator permanent locked = 0')
        assert.equal(pos.unlockedLiquidity.toString(), '0', 'creator unlocked = 0')
        assert.equal(pos.vestedLiquidity.toString(), '0', 'creator vested = 0')
    })

    it('5. post-graduation trading + graduated claim_and_sweep splits 60/30/10', async () => {
        // trade on the DAMM pool to accrue fees to the locked position
        const dammState = await cpAmm.fetchPoolState(main.dammPool)
        for (let i = 0; i < 3; i++) {
            const inAmt = new BN(0.1 * LAMPORTS_PER_SOL)
            const q = await cpAmm.getQuote({ inAmount: inAmt, inputTokenMint: WSOL_MINT, slippage: 50, poolState: dammState, currentTime: Math.floor(Date.now() / 1000), currentSlot: await conn.getSlot(), tokenADecimal: 6, tokenBDecimal: 9 })
            const swapTx = await cpAmm.swap({ payer: admin.publicKey, pool: main.dammPool, inputTokenMint: WSOL_MINT, outputTokenMint: main.mint, amountIn: inAmt, minimumAmountOut: new BN(1), tokenAMint: main.mint, tokenBMint: WSOL_MINT, tokenAVault: deriveDammV2TokenVaultAddress(main.dammPool, main.mint), tokenBVault: deriveDammV2TokenVaultAddress(main.dammPool, WSOL_MINT), tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null })
            await sendLegacy(swapTx as unknown as Transaction, [admin])
        }
        const a = sweepAtas(main.mint, platformWallet)
        const [pay0, rev0, plat0] = [await wsol(a.payoutWsolAta), await wsol(a.revenueWsolAta), await wsol(a.platformWsolAta)]
        const g = rail(main)
        const accts = { caller: admin.publicKey, mint: main.mint, config: CONFIG, platformWallet }
        await sendV0(sweepAtaIxs(main.mint, platformWallet, admin.publicKey), [admin]) // pre-create ATAs (separate tx)
        const alt = await warmAlt(claimAndSweepAltAddresses(accts, g))
        const r = await sendV0([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), claimAndSweepIx(accts, g)], [admin], alt)
        const payD = (await wsol(a.payoutWsolAta)) - pay0, revD = (await wsol(a.revenueWsolAta)) - rev0, platD = (await wsol(a.platformWsolAta)) - plat0
        const claimed = payD + revD + platD
        console.log(`      graduated sweep: CU=${r.cu} size=${r.size}B  claimed=${claimed}`)
        assert.isAbove(Number(claimed), 0, 'claimed > 0 from cp-amm')
        const holder = claimed * BigInt(6000) / BigInt(10000), h2e = claimed * BigInt(3000) / BigInt(10000)
        assert.equal(payD, holder, 'payout = 60%'); assert.equal(revD, h2e, 'revenue = 30%'); assert.equal(platD, claimed - holder - h2e, 'platform = remainder')
        assert.equal(await wsol(a.feeWsolAta), 0n, 'fee ATA empty')
    })

    it('7. retire_coin is admin-gated (keeper and unrelated rejected)', async () => {
        for (const bad of [keeper, unrelated]) {
            let failed = false
            try { await sendV0([retireCoinIx(main.mint, bad.publicKey)], [bad]) } catch (e: any) { failed = true; assert.match(String(e.logs ?? e), /NotAdmin|not the admin|custom program error/) }
            assert.isTrue(failed, 'non-admin must be rejected')
        }
    })

    it('8. Retired blocks sweeps (distribution of vault funds is unaffected)', async () => {
        await sendV0([retireCoinIx(main.mint, admin.publicKey)], [admin])
        assert.equal(Object.keys(decodeCoinConfig((await conn.getAccountInfo(pdas.coinConfig(main.mint)))!.data).status)[0], 'Retired')
        const g = rail(main)
        const accts = { caller: admin.publicKey, mint: main.mint, config: CONFIG, platformWallet }
        await sendV0(sweepAtaIxs(main.mint, platformWallet, admin.publicKey), [admin])
        const alt = await warmAlt(claimAndSweepAltAddresses(accts, g))
        let failed = false
        try { await sendV0([claimAndSweepIx(accts, g)], [admin], alt) }
        catch (e: any) { failed = true; assert.match(String(e.logs ?? e), /CoinRetired|coin is retired|custom program error/, 'expected CoinRetired') }
        assert.isTrue(failed, 'sweep on a retired coin must be rejected')
    })
})
