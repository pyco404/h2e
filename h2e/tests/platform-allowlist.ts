/**
 * Task 1.9 — PlatformAllowlist (offline parts: tests 1, 2, 3, 6).
 *
 * Runs on the same offline harness as swap.ts (synthetic Bonding CoinConfig, bare
 * validator, no DBC). launch_coin's default_payout_mint validation (tests 4, 5, 7)
 * needs a real DBC launch and lives in launch_coin.ts.
 *
 * Run with: bash scripts/swap-test.sh tests/platform-allowlist.ts
 */
import * as anchor from '@coral-xyz/anchor'
import {
    PublicKey, Keypair, TransactionMessage, VersionedTransaction, TransactionInstruction,
    SystemProgram, LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import {
    getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
    createSyncNativeInstruction, createMint,
} from '@solana/spl-token'
import { assert } from 'chai'
import fs from 'fs'
import {
    pdas, initializeGlobalIx, settleEpochIx, initPlatformAllowlistIx, setPlatformAllowlistIx,
    decodePlatformAllowlist, decodeAllowlistState, decodeCoinConfig, WSOL_MINT, BN,
} from '../client'

describe('PlatformAllowlist (Task 1.9)', () => {
    const provider = anchor.AnchorProvider.env(); anchor.setProvider(provider)
    const conn = provider.connection
    const keeper = (provider.wallet as anchor.Wallet).payer
    const admin = Keypair.generate(), unrelated = Keypair.generate()
    const CONFIG = new PublicKey(fs.readFileSync('tests/fixtures/platform-config.txt', 'utf8').trim())
    const platformWallet = Keypair.generate().publicKey
    const coinMint = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('tests/fixtures/swap/coin-mint.json', 'utf8')))).publicKey
    let mintA: PublicKey, mintB: PublicKey

    async function air(pk: PublicKey, s = 20) { await conn.confirmTransaction(await conn.requestAirdrop(pk, s * LAMPORTS_PER_SOL), 'confirmed') }
    async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
        const { blockhash } = await conn.getLatestBlockhash()
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message())
        tx.sign(signers); const sig = await conn.sendTransaction(tx); await conn.confirmTransaction(sig, 'confirmed'); return sig
    }
    async function expectFail(ixs: TransactionInstruction[], signers: Keypair[], re: RegExp) {
        let failed = false
        try { await send(ixs, signers) } catch (e: any) {
            failed = true
            let logs = e.logs; if (!logs && typeof e.getLogs === 'function') { try { logs = await e.getLogs(conn) } catch {} }
            assert.match([e.message, logs && logs.join(' ')].filter(Boolean).join(' | '), re, 'wrong error')
        }
        assert.isTrue(failed, 'expected rejection')
    }
    async function readAllow() { return decodePlatformAllowlist((await conn.getAccountInfo(pdas.platformAllowlist()))!.data) }
    async function fundPayout(lamports: number) {
        const pa = pdas.payoutAuthority(coinMint), ata = getAssociatedTokenAddressSync(WSOL_MINT, pa, true)
        await send([createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, ata, pa, WSOL_MINT), SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: ata, lamports }), createSyncNativeInstruction(ata)], [keeper])
    }
    const settle = (e: number, allowed: PublicKey[], bucketCount = allowed.length) =>
        settleEpochIx({ epochIndex: e, totalWeight: new BN(1), merkleRoot: Array(32).fill(0), bucketCount, allowedMints: allowed }, coinMint, keeper.publicKey)

    before(async function () {
        this.timeout(120000)
        for (const k of [admin, unrelated]) await air(k.publicKey)
        await send([initializeGlobalIx({
            admin: admin.publicKey, keeper: keeper.publicKey, platform_wallet: platformWallet, platform_config_key: CONFIG,
            usdc_mint: Keypair.generate().publicKey, holder_bps: 6000, h2e_bps: 3000, platform_bps: 1000,
            dev_buy_cap_bps: 300, holder_cap_bps: 300, epoch_seconds: new BN(2), h2e_epoch_seconds: new BN(604800),
            max_slippage_bps: 100, min_sweep_lamports: new BN(1000), pool_creation_fee_lamports: new BN(0),
            paused: false, pause_launches: false,
        }, keeper.publicKey)], [keeper])
        mintA = await createMint(conn, keeper, keeper.publicKey, null, 6)
        mintB = await createMint(conn, keeper, keeper.publicKey, null, 6)
        await fundPayout(10_000_000)
    })

    it('1. init + add/remove are admin-gated; keeper and unrelated rejected', async () => {
        // keeper cannot init (has_one = admin)
        await expectFail([initPlatformAllowlistIx(keeper.publicKey)], [keeper], /NotAdmin|not the admin|custom program error/)
        await send([initPlatformAllowlistIx(admin.publicKey)], [admin])
        // non-admins cannot mutate
        await expectFail([setPlatformAllowlistIx(mintA, true, keeper.publicKey)], [keeper], /NotAdmin|not the admin|custom program error/)
        await expectFail([setPlatformAllowlistIx(mintA, true, unrelated.publicKey)], [unrelated], /NotAdmin|not the admin|custom program error/)
        // admin add then remove
        await send([setPlatformAllowlistIx(mintA, true, admin.publicKey)], [admin])
        assert.isTrue((await readAllow()).mints.some((m: PublicKey) => m.equals(mintA)), 'added')
        await send([setPlatformAllowlistIx(mintA, false, admin.publicKey)], [admin])
        assert.isFalse((await readAllow()).mints.some((m: PublicKey) => m.equals(mintA)), 'removed')
    })

    it('2. settle_epoch rejects an allowed_mints entry not in PlatformAllowlist (security test)', async () => {
        await send([setPlatformAllowlistIx(mintA, true, admin.publicKey)], [admin]) // A permitted, B not
        await expectFail([settle(200, [mintA, mintB])], [keeper], /OutMintNotAllowed|not in this round|custom program error/)
    })

    it('3. settle_epoch succeeds when every entry is a subset', async () => {
        await send([setPlatformAllowlistIx(mintB, true, admin.publicKey)], [admin]) // now A and B both permitted
        await send([settle(201, [mintA, mintB])], [keeper])
        const al = decodeAllowlistState((await conn.getAccountInfo(pdas.allowlistState(coinMint, 201)))!.data)
        assert.equal(al.mints.length, 2, 'both snapshotted')
        assert.isTrue(al.mints.some((m: PublicKey) => m.equals(mintA)) && al.mints.some((m: PublicKey) => m.equals(mintB)))
    })

    it('6. removing a mint does not retroactively break an already-launched coin', async () => {
        // the synthetic coin was launched with default_payout_mint = WSOL (fixture)
        const before = decodeCoinConfig((await conn.getAccountInfo(pdas.coinConfig(coinMint)))!.data)
        assert.ok(before.default_payout_mint.equals(WSOL_MINT), 'coin carries its permanent pairing on-chain')
        // add then remove WSOL from the standing allowlist
        await send([setPlatformAllowlistIx(WSOL_MINT, true, admin.publicKey)], [admin])
        await send([setPlatformAllowlistIx(WSOL_MINT, false, admin.publicKey)], [admin])
        // the coin's default_payout_mint is untouched — history is not rewritten;
        // the round builder degrades to USDC at settle (off-chain, Phase 2).
        const after = decodeCoinConfig((await conn.getAccountInfo(pdas.coinConfig(coinMint)))!.data)
        assert.ok(after.default_payout_mint.equals(WSOL_MINT), 'unchanged after removal')
        // and a NEW round can no longer include WSOL in allowed_mints
        await expectFail([settle(202, [WSOL_MINT])], [keeper], /OutMintNotAllowed|not in this round|custom program error/)
    })
})
