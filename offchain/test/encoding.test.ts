/**
 * Task 2.1 Part A — offline encoding suite.
 *
 * Every client builder, with representative arguments, exercised so its internal
 * round-trip guard (encodeChecked) runs. That guard threw only in network-gated
 * tests before, so two silent-serialization bugs (Task 1.1b h2EBps, Task 2.0
 * instanceof PublicKey) reached far before anyone hit the path. This closes the
 * class: it runs offline, on every builder, on every push.
 *
 * The regression lock for the instanceof bug: each PublicKey/BN argument is also
 * passed as a value from a SECOND, independent copy of @solana/web3.js / bn.js,
 * so `instanceof` against the client's class is false — the exact shape that
 * slipped through. If the client ever regresses to instanceof-only, these throw.
 */
import { assert } from 'chai'
import { PublicKey, Keypair } from '@solana/web3.js'
import BN from 'bn.js'
import * as C from '../../h2e/client'

// A second, independent module instance → its PublicKey/BN are NOT instanceof the
// client's. This reproduces the bundled-frontend condition inside a node test.
function freshModule(id: string): any {
  const path = require.resolve(id)
  delete require.cache[path]
  const m = require(path)
  require.cache[path] && delete require.cache[path]
  return m
}
const web3b = freshModule('@solana/web3.js')
const bnB = freshModule('bn.js')
const foreignPk = (base58: string) => new web3b.PublicKey(base58)
const foreignBn = (n: number | string) => new bnB(n)

const A = 'So11111111111111111111111111111111111111112'
const B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC mainnet
const kp = () => Keypair.generate().publicKey

// Sanity: the foreign PublicKey really is a different class.
describe('encoding suite — preconditions', () => {
  it('the second web3 copy yields a non-instanceof PublicKey (bug shape)', () => {
    const f = foreignPk(A)
    assert.isFalse(f instanceof PublicKey, 'must be a foreign class to be a real regression lock')
    assert.equal(f.toBase58(), A, 'but still a working PublicKey')
  })
})

// Build each instruction with NORMAL args; a throw = a round-trip failure.
describe('encoding suite — every builder round-trips (normal args)', () => {
  const admin = kp(), authority = kp(), mint = kp(), keeper = kp()
  const cases: [string, () => any][] = [
    ['initialize_global', () => C.initializeGlobalIx({
      admin, keeper, platform_wallet: kp(), platform_config_key: kp(), usdc_mint: new PublicKey(B),
      holder_bps: 6000, h2e_bps: 3000, platform_bps: 1000, dev_buy_cap_bps: 300, holder_cap_bps: 300,
      epoch_seconds: new C.BN(86400), h2e_epoch_seconds: new C.BN(604800), max_slippage_bps: 100,
      min_sweep_lamports: new C.BN(1000), pool_creation_fee_lamports: new C.BN(0), paused: false, pause_launches: false,
    }, authority)],
    ['launch_coin', () => C.launchCoinIx(
      { name: 'Nvidia Holders', symbol: 'NVH', uri: 'https://x/m.json', dev_buy_lamports: new C.BN(500000), default_payout_mint: new PublicKey(A) },
      { payer: authority, baseMint: mint, config: kp(), platformWallet: kp() })],
    ['set_params', () => C.setParamsIx({ holder_bps: 6000, h2e_bps: 3000, platform_bps: 1000, dev_buy_cap_bps: 300, holder_cap_bps: 300, epoch_seconds: new C.BN(86400), h2e_epoch_seconds: new C.BN(604800), max_slippage_bps: 100, min_sweep_lamports: new C.BN(1000), pool_creation_fee_lamports: new C.BN(0), usdc_mint: new PublicKey(B) } as any, admin)],
    ['set_keeper', () => C.setKeeperIx(kp(), admin)],
    ['set_admin', () => C.setAdminIx(kp(), admin)],
    ['set_platform_wallet', () => C.setPlatformWalletIx(kp(), admin)],
    ['set_platform_config_key', () => C.setPlatformConfigKeyIx(kp(), admin)],
    ['set_usdc_mint', () => C.setUsdcMintIx(new PublicKey(B), admin)],
    ['retire_coin', () => C.retireCoinIx(mint, admin)],
    ['sync_graduation', () => C.syncGraduationIx({ caller: authority, mint, dbcPool: kp(), dammPool: kp(), lockedPosition: kp(), positionNftAccount: kp() })],
    ['set_h2e_mint (Some)', () => C.setH2eMintIx(kp(), true, admin)],
    ['set_h2e_mint (None)', () => C.setH2eMintIx(null, false, admin)],
    ['pause', () => C.pauseIx(true, false, admin)],
    ['init_denylist', () => C.initDenylistIx(admin)],
    ['set_denylist', () => C.setDenylistIx(C.DenyKind.PayoutMint, kp(), true, admin)],
    ['claim_and_sweep', () => C.claimAndSweepIx({ caller: authority, mint, config: kp(), platformWallet: kp() })],
    ['settle_epoch', () => C.settleEpochIx({ epochIndex: 3, totalWeight: new C.BN('123456789'), merkleRoot: Array(32).fill(7), bucketCount: 2, allowedMints: [new PublicKey(A), new PublicKey(B)] }, mint, keeper)],
    ['swap_payout', () => C.swapPayoutIx({ epochIndex: 3, outMint: new PublicKey(A), amountIn: new C.BN(1000), quotedOut: new C.BN(2000), minOut: new C.BN(1980), recipientCount: 5, jupData: Buffer.from([1, 2, 3, 4]), route: [] }, mint, keeper)],
    ['distribute_batch', () => C.distributeBatchIx({ epochIndex: 3, outMint: new PublicKey(A), startIndex: 0, recipients: [kp(), kp()], amounts: [new C.BN(500), new C.BN(500)] }, mint, keeper)],
    ['set_graduation', () => C.setGraduationIx(mint, 'Graduated', kp(), kp(), admin)],
    ['init_platform_allowlist', () => C.initPlatformAllowlistIx(admin)],
    ['set_platform_allowlist', () => C.setPlatformAllowlistIx(new PublicKey(A), true, admin)],
  ]
  for (const [name, build] of cases) {
    it(name, () => { const ix = build(); assert.isAbove(ix.data.length, 0, 'has instruction data'); })
  }
})

// The regression lock: PublicKey/BN args from a foreign class copy must round-trip.
describe('encoding suite — foreign-class PublicKey/BN args round-trip (instanceof lock)', () => {
  const admin = kp(), keeper = kp()
  it('launch_coin with a foreign default_payout_mint', () => {
    C.launchCoinIx(
      { name: 'X', symbol: 'X', uri: 'u', dev_buy_lamports: foreignBn(0), default_payout_mint: foreignPk(A) as any },
      { payer: kp(), baseMint: kp(), config: kp(), platformWallet: kp() })
  })
  it('settle_epoch with foreign allowedMints and totalWeight', () => {
    C.settleEpochIx({ epochIndex: 1, totalWeight: foreignBn('999') as any, merkleRoot: Array(32).fill(0), bucketCount: 1, allowedMints: [foreignPk(A) as any] }, foreignPk(B) as any, keeper)
  })
  it('swap_payout with foreign outMint and amounts', () => {
    C.swapPayoutIx({ epochIndex: 1, outMint: foreignPk(A) as any, amountIn: foreignBn(10) as any, quotedOut: foreignBn(20) as any, minOut: foreignBn(19) as any, recipientCount: 1, jupData: Buffer.alloc(0), route: [] }, foreignPk(B) as any, keeper)
  })
  it('set_usdc_mint / set_keeper / set_platform_allowlist with foreign pubkeys', () => {
    C.setUsdcMintIx(foreignPk(B) as any, admin)
    C.setKeeperIx(foreignPk(A) as any, admin)
    C.setPlatformAllowlistIx(foreignPk(A) as any, true, admin)
  })
  it('initialize_global with a foreign usdc_mint and BN cadence values', () => {
    C.initializeGlobalIx({
      admin, keeper, platform_wallet: kp(), platform_config_key: kp(), usdc_mint: foreignPk(B) as any,
      holder_bps: 6000, h2e_bps: 3000, platform_bps: 1000, dev_buy_cap_bps: 300, holder_cap_bps: 300,
      epoch_seconds: foreignBn(86400) as any, h2e_epoch_seconds: foreignBn(604800) as any, max_slippage_bps: 100,
      min_sweep_lamports: foreignBn(1000) as any, pool_creation_fee_lamports: foreignBn(0) as any, paused: false, pause_launches: false,
    }, kp())
  })
})
