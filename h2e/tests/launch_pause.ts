/**
 * Task 1.3 test 5 — pause_launches. GlobalConfig is a singleton with no setter,
 * so pause=true needs its own session, distinct from launch_coin.ts (pause=false).
 * launch_coin reverts on the pause check before any CPI, so this runs on a bare
 * validator (no DBC clone needed).
 */
import * as anchor from '@coral-xyz/anchor'
import {
    PublicKey, Keypair, TransactionMessage, VersionedTransaction, TransactionInstruction,
} from '@solana/web3.js'
import { assert } from 'chai'
import fs from 'fs'
import { pdas, initializeGlobalIx, launchCoinIx, initPlatformAllowlistIx, setPlatformAllowlistIx, WSOL_MINT, BN } from '../client'

describe('launch_coin — pause_launches', () => {
    const provider = anchor.AnchorProvider.env(); anchor.setProvider(provider)
    const conn = provider.connection
    const authority = (provider.wallet as anchor.Wallet).payer
    const CONFIG = new PublicKey(fs.readFileSync('tests/fixtures/platform-config.txt', 'utf8').trim())
    const platformWallet = Keypair.generate().publicKey

    async function sendV0(ixs: TransactionInstruction[], signers: Keypair[]) {
        const { blockhash } = await conn.getLatestBlockhash()
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message())
        tx.sign(signers)
        await conn.confirmTransaction(await conn.sendTransaction(tx), 'confirmed')
    }

    before('initialize GlobalConfig with pause_launches = true', async () => {
        const ix = initializeGlobalIx({
            admin: authority.publicKey, keeper: Keypair.generate().publicKey,
            platform_wallet: platformWallet, platform_config_key: CONFIG, usdc_mint: Keypair.generate().publicKey,
            holder_bps: 6000, h2e_bps: 3000, platform_bps: 1000, dev_buy_cap_bps: 300, holder_cap_bps: 300,
            epoch_seconds: new BN(86400), h2e_epoch_seconds: new BN(604800), max_slippage_bps: 100,
            min_sweep_lamports: new BN(1_000_000), pool_creation_fee_lamports: new BN(0),
            paused: false, pause_launches: true,
        }, authority.publicKey)
        await sendV0([ix], [authority])
        // Task 1.9: the allowlist account must exist for launch_coin account
        // resolution (the launch still fails first on pause_launches).
        await sendV0([initPlatformAllowlistIx(authority.publicKey), setPlatformAllowlistIx(WSOL_MINT, true, authority.publicKey)], [authority])
    })

    it('5. pause_launches = true: launch rejected, no CoinConfig', async () => {
        const mint = Keypair.generate()
        let failed = false
        try {
            const ix = launchCoinIx({ name: 'Paused', symbol: 'PZ', uri: 'https://x.io/p.json', dev_buy_lamports: new BN(0), default_payout_mint: WSOL_MINT },
                { payer: authority.publicKey, baseMint: mint.publicKey, config: CONFIG, platformWallet })
            await sendV0([ix], [authority, mint])
        } catch (e: any) {
            failed = true
            assert.match(String(e.logs ?? e), /LaunchesPaused|launches are paused|custom program error/, 'expected LaunchesPaused')
        }
        assert.isTrue(failed, 'must revert')
        assert.isNull(await conn.getAccountInfo(pdas.coinConfig(mint.publicKey)), 'no CoinConfig created')
    })
})
