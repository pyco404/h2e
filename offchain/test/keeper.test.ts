/**
 * Task 2.2 Part C — keeper: activity tiering, launch_ts stagger, and the
 * resumable distribution driver killed mid-distribution and cleanly resumed.
 */
import { assert } from 'chai'
import {
  tierFor, claimDue, TIER_INTERVAL_SEC, shouldClaimGraduated,
  epochBoundary, currentEpochIndex, settleableEpoch,
  distributeBucket, DistChain, BucketDistribution,
  swapBucketWithFallback, SwapError, SwapVenue, SwapFailKind,
} from '../src/keeper'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const NVDA = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh'

// A venue that fails a specific mint with a given error, and succeeds otherwise.
// Records every mint it was asked to swap, so we can assert "one attempt, then USDC".
class FakeVenue implements SwapVenue {
  attempts: string[] = []
  failMint: string | null
  kind: SwapFailKind
  constructor(failMint: string | null, kind: SwapFailKind) { this.failMint = failMint; this.kind = kind }
  async swap(outMint: string, amountIn: bigint): Promise<{ amountOut: bigint }> {
    this.attempts.push(outMint)
    if (outMint === this.failMint) throw new SwapError(this.kind)
    return { amountOut: amountIn * 2n }
  }
}

describe('keeper cadence (§7.5)', () => {
  it('tiers coins by recent accrual; a coin earning nothing is dormant', () => {
    const minSweep = 1_000_000n
    assert.equal(tierFor(5_000_000n, minSweep), 'hot')
    assert.equal(tierFor(1_500_000n, minSweep), 'quiet')
    assert.equal(tierFor(0n, minSweep), 'dormant')
    assert.isTrue(claimDue(0, 'hot', 60)); assert.isFalse(claimDue(0, 'hot', 59))
    assert.equal(TIER_INTERVAL_SEC.dormant, 3600)
  })

  it('post-graduation claim gated by simulated claimable vs min_sweep', () => {
    assert.isTrue(shouldClaimGraduated(2_000_000n, 1_000_000n))
    assert.isFalse(shouldClaimGraduated(500_000n, 1_000_000n), 'below min_sweep → no tx, no no-op fee')
  })

  it('staggers epochs by launch_ts', () => {
    const day = 86400
    // two coins launched 6h apart settle 6h apart, not together at 00:00
    const a = 1_000_000_000, b = a + 6 * 3600
    assert.equal(epochBoundary(a, day, 0), a + day)
    assert.equal(epochBoundary(b, day, 0), b + day)
    assert.notEqual(epochBoundary(a, day, 0) % day, epochBoundary(b, day, 0) % day)
    assert.equal(currentEpochIndex(a, day, a + day + 10), 1)
    assert.equal(settleableEpoch(a, day, a + 2 * day + 10), 1, 'epoch 1 fully ended → settleable')
  })
})

// Fake chain mirroring the on-chain cursor semantics: startIndex must equal the
// stored cursor (else CursorMismatch), each recipient paid at most once, and a
// programmable crash after N successful batches.
class FakeChain implements DistChain {
  private cursors = new Map<string, number>()
  paidCount = new Map<string, number>()
  sends = 0
  crashAfter: number
  constructor(crashAfter = Infinity) { this.crashAfter = crashAfter }
  private key(m: string, e: number, o: string) { return `${m}|${e}|${o}` }
  async cursor(m: string, e: number, o: string) { return this.cursors.get(this.key(m, e, o)) ?? 0 }
  async sendBatch(m: string, e: number, o: string, startIndex: number, recipients: string[], _amounts: bigint[]) {
    const k = this.key(m, e, o)
    const cur = this.cursors.get(k) ?? 0
    if (startIndex !== cur) throw new Error(`CursorMismatch: sent ${startIndex}, on-chain ${cur}`)
    if (this.sends >= this.crashAfter) throw new Error('KEEPER CRASH (mid-distribution)')
    for (const w of recipients) this.paidCount.set(w, (this.paidCount.get(w) ?? 0) + 1)
    this.cursors.set(k, cur + recipients.length)
    this.sends++
  }
}

describe('swap fallback to USDC (§7.3, Task 4.2 Part B)', () => {
  it('route over MAX_SWAP_REMAINING (TooManySwapAccounts) → falls back to USDC, exactly one degraded attempt', async () => {
    const venue = new FakeVenue(NVDA, 'too-many-accounts')
    const r = await swapBucketWithFallback(venue, NVDA, 1_000_000n, 990_000n, USDC)
    assert.isTrue(r.fellBack); assert.equal(r.outMint, USDC)
    assert.deepEqual(venue.attempts, [NVDA, USDC], 'tried NVDA once, then USDC — no retry loop')
  })
  it('slippage-floor failure → falls back to USDC', async () => {
    const venue = new FakeVenue(NVDA, 'slippage')
    const r = await swapBucketWithFallback(venue, NVDA, 1_000_000n, 990_000n, USDC)
    assert.isTrue(r.fellBack); assert.equal(r.outMint, USDC)
  })
  it('mint delisted mid-round → falls back to USDC', async () => {
    const venue = new FakeVenue(NVDA, 'delisted')
    const r = await swapBucketWithFallback(venue, NVDA, 1_000_000n, 990_000n, USDC)
    assert.isTrue(r.fellBack); assert.equal(r.outMint, USDC)
  })
  it('a transient error is NOT a fallback trigger — it rethrows for a bounded retry', async () => {
    const venue = new FakeVenue(NVDA, 'transient')
    let threw = false
    try { await swapBucketWithFallback(venue, NVDA, 1_000_000n, 990_000n, USDC) } catch (e: any) { threw = true; assert.instanceOf(e, SwapError) }
    assert.isTrue(threw, 'transient bubbles up; the payout asset is not switched on a blip')
    assert.deepEqual(venue.attempts, [NVDA], 'no USDC fallback on a transient error')
  })
  it('a successful primary swap does not fall back', async () => {
    const venue = new FakeVenue(null, 'transient')
    const r = await swapBucketWithFallback(venue, NVDA, 1_000_000n, 990_000n, USDC)
    assert.isFalse(r.fellBack); assert.equal(r.outMint, NVDA); assert.deepEqual(venue.attempts, [NVDA])
  })
  it('USDC itself degrading cannot fall back further (surfaced, not silently looped)', async () => {
    const venue = new FakeVenue(USDC, 'too-many-accounts')
    let threw = false
    try { await swapBucketWithFallback(venue, USDC, 1_000_000n, 0n, USDC) } catch { threw = true }
    assert.isTrue(threw, 'no infinite USDC→USDC fallback')
  })
})

describe('resumable distribution (§6 / §16)', () => {
  const bucket = (n: number): BucketDistribution => ({
    mint: 'MintAAA', epochIndex: 3, outMint: 'OutAAA',
    recipients: Array.from({ length: n }, (_, i) => ({ wallet: `wallet-${String(i).padStart(3, '0')}`, amount: 1000n })),
  })

  it('completes a bucket in batches of 15', async () => {
    const chain = new FakeChain()
    const b = bucket(37)
    const batches = await distributeBucket(chain, b, 15)
    assert.equal(batches, 3, '15+15+7')
    for (const r of b.recipients) assert.equal(chain.paidCount.get(r.wallet), 1, 'each paid exactly once')
    assert.equal(await chain.cursor(b.mint, b.epochIndex, b.outMint), 37, 'cursor complete')
  })

  it('KILL mid-distribution then clean resume — every recipient paid exactly once', async () => {
    const b = bucket(40)
    // run 1: crash after 2 successful batches (cursor at 30)
    const chain = new FakeChain(2)
    let crashed = false
    try { await distributeBucket(chain, b, 15) } catch (e: any) { crashed = true; assert.match(e.message, /CRASH/) }
    assert.isTrue(crashed, 'the keeper died mid-distribution')
    assert.equal(await chain.cursor(b.mint, b.epochIndex, b.outMint), 30, 'cursor persisted at the last committed batch')

    // run 2: a fresh driver call resumes from the on-chain cursor (no crash now)
    chain.crashAfter = Infinity
    const more = await distributeBucket(chain, b, 15)
    assert.equal(more, 1, 'only the remaining 10 recipients, one batch')
    assert.equal(await chain.cursor(b.mint, b.epochIndex, b.outMint), 40, 'now complete')
    for (const r of b.recipients) assert.equal(chain.paidCount.get(r.wallet), 1, 'exactly once — no double-payment across the crash')
  })
})
