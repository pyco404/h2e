/**
 * Task 1.2 tests — PDA derivations and the FeeAuthority WSOL ATA helper.
 *
 * Pure client-side derivation checks: no validator, no provider. Each expected
 * value is computed INDEPENDENTLY here (raw findProgramAddressSync /
 * getAssociatedTokenAddressSync) and compared to the client helper — the helper
 * under test is never used to compute its own expectation.
 *
 * CoinConfig's serialized layout and the CoinStatus enum are covered by the Rust
 * unit tests in programs/h2e/src/lib.rs (the account is pruned from the IDL until
 * launch_coin references it, so its layout is tested against the real Rust borsh
 * rather than a hand-written TS schema).
 */
import { PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token'
import { assert } from 'chai'
import { PROGRAM_ID, pdas, feeAuthorityWsolAta, SEEDS } from '../client'

const mintA = new PublicKey('So11111111111111111111111111111111111111112')
const mintB = PublicKey.unique()
const mintC = PublicKey.unique()

// Independent derivations (do NOT call the client helpers).
const exp = {
    global: () => PublicKey.findProgramAddressSync([Buffer.from('global')], PROGRAM_ID)[0],
    coin: (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('coin'), m.toBuffer()], PROGRAM_ID)[0],
    fee: () => PublicKey.findProgramAddressSync([Buffer.from('fee')], PROGRAM_ID)[0],
    vault: (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('vault'), m.toBuffer()], PROGRAM_ID)[0],
    payout: (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('payout'), m.toBuffer()], PROGRAM_ID)[0],
    revenue: () => PublicKey.findProgramAddressSync([Buffer.from('revenue')], PROGRAM_ID)[0],
}

describe('Task 1.2 — PDA derivations', () => {
    it('1. every derivation matches an independently computed address', () => {
        assert.ok(pdas.global().equals(exp.global()), 'global')
        assert.ok(pdas.coinConfig(mintB).equals(exp.coin(mintB)), 'coinConfig')
        assert.ok(pdas.feeClaimer().equals(exp.fee()), 'feeClaimer')
        assert.ok(pdas.feeAuthority(mintB).equals(exp.vault(mintB)), 'feeAuthority')
        assert.ok(pdas.payoutAuthority(mintB).equals(exp.payout(mintB)), 'payoutAuthority')
        assert.ok(pdas.revenueAuthority().equals(exp.revenue()), 'revenueAuthority')
    })

    it('2. FeeClaimer and RevenueAuthority are global (mint does not affect them)', () => {
        // They take no mint; assert they are stable and independent of any mint.
        assert.ok(pdas.feeClaimer().equals(pdas.feeClaimer()), 'feeClaimer stable')
        assert.ok(pdas.revenueAuthority().equals(pdas.revenueAuthority()), 'revenueAuthority stable')
        assert.ok(pdas.feeClaimer().equals(exp.fee()), 'feeClaimer == independent')
        assert.ok(pdas.revenueAuthority().equals(exp.revenue()), 'revenueAuthority == independent')
        // And they differ from any per-mint authority.
        assert.notOk(pdas.feeClaimer().equals(pdas.feeAuthority(mintA)), 'feeClaimer != feeAuthority')
        assert.notOk(pdas.revenueAuthority().equals(pdas.payoutAuthority(mintA)), 'revenue != payout')
    })

    it('3. FeeAuthority and PayoutAuthority differ per mint and never collide for same mint', () => {
        assert.notOk(pdas.feeAuthority(mintA).equals(pdas.feeAuthority(mintB)), 'feeAuthority per-mint distinct')
        assert.notOk(pdas.payoutAuthority(mintA).equals(pdas.payoutAuthority(mintB)), 'payoutAuthority per-mint distinct')
        assert.notOk(pdas.feeAuthority(mintC).equals(pdas.payoutAuthority(mintC)), 'fee != payout for same mint')
        // coinConfig also per-mint distinct.
        assert.notOk(pdas.coinConfig(mintA).equals(pdas.coinConfig(mintB)), 'coinConfig per-mint distinct')
    })

    it('4. FeeAuthority WSOL ATA helper matches an independently derived ATA', () => {
        const independent = getAssociatedTokenAddressSync(NATIVE_MINT, exp.vault(mintB), true)
        assert.ok(feeAuthorityWsolAta(mintB).equals(independent), 'ATA matches')
        // Sanity: it is the ATA of the fee authority, not of the mint or payout authority.
        assert.notOk(feeAuthorityWsolAta(mintB).equals(getAssociatedTokenAddressSync(NATIVE_MINT, exp.payout(mintB), true)), 'not payout ATA')
        // Per-mint distinct.
        assert.notOk(feeAuthorityWsolAta(mintA).equals(feeAuthorityWsolAta(mintB)), 'ATA per-mint distinct')
    })

    it('seed strings match the program', () => {
        assert.deepEqual(
            { ...SEEDS },
            { global: 'global', coin: 'coin', fee: 'fee', vault: 'vault', payout: 'payout', revenue: 'revenue' },
        )
    })
})
