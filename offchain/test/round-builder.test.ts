/**
 * Task 2.2 Part B — round builder (§7.4): the hard watermark gate, deterministic
 * byte-identical output, elected-asset bucketing with default/USDC fallback, and
 * the sub-rent drop that rolls into the next round.
 */
import { assert } from 'chai'
import { PublicKey, Keypair } from '@solana/web3.js'
import { build, serializePlan, RoundNotReady, RoundInput, buildRoundFile, leafFor, merkleProof, verifyLeaf } from '../src/round-builder'
import { BalanceEvent } from '../src/aged-balance'

const WSOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const NVDA = new PublicKey(Keypair.generate().publicKey).toBase58()
const DAY = 86400, T = 1_000_000_000, WS = T - DAY
const ev = (balance: number | bigint, ts: number, seq = 0): BalanceEvent => ({ balance: BigInt(balance), ts, seq })
const W = () => Keypair.generate().publicKey.toBase58()

function baseInput(over: Partial<RoundInput> = {}): RoundInput {
  return {
    mint: W(), epochIndex: 5, epochEndTs: T, windowStart: WS, supply: 1_000_000n,
    payoutAmount: 100_000_000n, // 0.1 SOL to holders
    history: new Map(), excluded: new Set(), elections: new Map(),
    defaultPayoutMint: NVDA, usdcMint: USDC, allowlist: new Set([WSOL, USDC, NVDA]),
    windowComplete: true, minShareLamports: 2_000_000n, // ~0.002 SOL ATA rent
    ...over,
  }
}

describe('round builder (§7.4)', () => {
  it('0. HARD GATE: refuses to build when the window is incomplete', () => {
    assert.throws(() => build(baseInput({ windowComplete: false })), RoundNotReady)
  })

  it('buckets by elected asset; non-electors get the default; unallowlisted election → default; unallowlisted default → USDC', () => {
    const elector = W(), nonElector = W(), staleElector = W()
    const history = new Map<string, BalanceEvent[]>([
      [elector, [ev(10000, WS - 10)]],
      [nonElector, [ev(10000, WS - 10)]],
      [staleElector, [ev(10000, WS - 10)]],
    ])
    const elections = new Map<string, string>([
      [elector, WSOL],                 // valid election
      [staleElector, 'DeListedMint1111111111111111111111111111111'], // no longer allowlisted → default
    ])
    const p = build(baseInput({ history, elections })) // default = NVDA (allowlisted)
    const byMint = Object.fromEntries(p.buckets.map((b) => [b.outMint, b.recipients.map((r) => r.wallet)]))
    assert.include(byMint[WSOL], elector, 'elector → WSOL')
    assert.include(byMint[NVDA], nonElector, 'non-elector → default NVDA')
    assert.include(byMint[NVDA], staleElector, 'stale election → default NVDA')

    // now make the default itself unallowlisted → non-electors fall back to USDC
    const p2 = build(baseInput({ history, elections, allowlist: new Set([WSOL, USDC]) }))
    const byMint2 = Object.fromEntries(p2.buckets.map((b) => [b.outMint, b.recipients.map((r) => r.wallet)]))
    assert.include(byMint2[USDC], nonElector, 'default unallowlisted → USDC fallback')
  })

  it('drops >3% wallets and sub-rent shares; keeps sub-rent weight in total (rolls over)', () => {
    const whale = W(), normal = W(), dust = W()
    const history = new Map<string, BalanceEvent[]>([
      [whale, [ev(40000, WS - 10)]],   // 4% > 3% → excluded entirely
      [normal, [ev(10000, WS - 10)]],  // eligible, above rent
      [dust, [ev(1, WS - 10)]],        // eligible but share < rent → dropped, rolls over
    ])
    const p = build(baseInput({ history }))
    const allRecips = p.buckets.flatMap((b) => b.recipients.map((r) => r.wallet))
    assert.notInclude(allRecips, whale, '>3% excluded')
    assert.include(allRecips, normal)
    assert.include(p.droppedSubRent, dust, 'sub-rent dropped')
    // total_weight includes normal + dust (10000 + 1), not whale (excluded pre-weight)
    assert.equal(p.totalWeight.toString(), '10001', 'sub-rent weight retained so its WSOL rolls over')
    // amountIn distributed is only for kept recipients — leftover stays as WSOL
    const distributed = p.buckets.reduce((s, b) => s + b.amountIn, 0n)
    assert.isBelow(Number(distributed), Number(100_000_000n), 'dropped share not swapped')
    // dust fix: swap = payoutAmount − Σ(dropped shares) (± integer rounding), remainder rolls over
    assert.isAbove(Number(p.droppedShareLamports), 0, 'dropped share total exposed')
    const rounding = 100_000_000n - (distributed + p.droppedShareLamports)
    assert.isAtMost(Number(rounding < 0n ? -rounding : rounding), p.buckets.length + 1, 'distributed + dropped ≈ payout (only integer-division dust)')
  })

  it('2. DETERMINISM: shuffled inputs → byte-identical plan (root + serialization)', () => {
    const wallets = Array.from({ length: 12 }, () => W())
    const mk = (): Map<string, BalanceEvent[]> => new Map(wallets.map((w, i) => [w, [ev(1000 + i * 100, WS - 5), ev(900 + i * 100, WS + 100)]]))
    const elections = new Map(wallets.slice(0, 6).map((w, i) => [w, i % 2 ? USDC : WSOL]))

    const fixedMint = W() // same coin for both runs (baseInput() otherwise regenerates it)
    const a = build(baseInput({ mint: fixedMint, history: mk(), elections }))
    // rebuild with map iteration order reversed and per-wallet events reversed
    const rev = new Map([...mk()].reverse().map(([k, v]) => [k, [...v].reverse()]))
    const b = build(baseInput({ mint: fixedMint, history: rev, elections: new Map([...elections].reverse()) }))

    assert.equal(Buffer.from(a.merkleRoot).toString('hex'), Buffer.from(b.merkleRoot).toString('hex'), 'roots match')
    assert.equal(serializePlan(a), serializePlan(b), 'byte-identical serialization')
    // recipients within each bucket are pubkey-ascending
    for (const bucket of a.buckets) {
      const pks = bucket.recipients.map((r) => new PublicKey(r.wallet).toBuffer())
      for (let i = 1; i < pks.length; i++) assert.isAtMost(Buffer.compare(pks[i - 1], pks[i]), 0, 'sorted by pubkey')
    }
  })

  it('empty eligible set → empty plan with zero root, no throw', () => {
    const p = build(baseInput({ history: new Map() }))
    assert.equal(p.bucketCount, 0)
    assert.equal(Buffer.from(p.merkleRoot).toString('hex'), '00'.repeat(32))
  })

  it('§7.5c round file: every holder can verify their own leaf against the root; a wrong weight fails', () => {
    const wallets = Array.from({ length: 15 }, () => W())
    const history = new Map<string, BalanceEvent[]>(wallets.map((w, i) => [w, [ev(1000 + i, WS - 5)]]))
    const elections = new Map(wallets.slice(0, 5).map((w) => [w, USDC]))
    const p = build(baseInput({ history, elections }))
    const file = buildRoundFile(p)
    assert.equal(file.entries.length, p.entries.length, 'file lists every eligible wallet')
    assert.equal(file.merkleRoot, Buffer.from(p.merkleRoot).toString('hex'))

    // Reconstruct leaves from the file, exactly as a browser verifier would.
    const leaves = file.entries.map((e) => leafFor(e.wallet, e.outMint, BigInt(e.weight)))
    for (let i = 0; i < file.entries.length; i++) {
      const e = file.entries[i]
      const proof = merkleProof(leaves, i)
      assert.isTrue(verifyLeaf(leafFor(e.wallet, e.outMint, BigInt(e.weight)), proof, p.merkleRoot), `holder ${i} verifies`)
      // a tampered weight must not verify against the frozen root
      assert.isFalse(verifyLeaf(leafFor(e.wallet, e.outMint, BigInt(e.weight) + 1n), proof, p.merkleRoot), 'tampered weight rejected')
    }
  })
})
