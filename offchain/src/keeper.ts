/**
 * Keeper loop (spec §7.5). Orchestration is thin on purpose — the program
 * enforces the invariants, so the keeper's job is *when* to act and to resume
 * cleanly. The parts with real logic (activity tiering, launch_ts stagger, and
 * the resumable distribution driver) are pure and tested; the transaction
 * submission is a thin `DistChain` the tests fake and production wires to the
 * client builders + a live connection.
 */

// ---- bonding claim: threshold-gated, tiered by activity (§7.5) ----
export type Tier = 'hot' | 'quiet' | 'dormant'
export const TIER_INTERVAL_SEC: Record<Tier, number> = { hot: 60, quiet: 900, dormant: 3600 }

/** A coin earning nothing must cost nothing: tier by recent accrual so dormant
 *  coins are polled hourly and hot coins every minute. */
export function tierFor(accruedLastHourLamports: bigint, minSweep: bigint): Tier {
  if (accruedLastHourLamports >= minSweep * 4n) return 'hot'
  if (accruedLastHourLamports >= minSweep) return 'quiet'
  return 'dormant'
}
export function claimDue(lastCheckTs: number, tier: Tier, now: number): boolean {
  return now - lastCheckTs >= TIER_INTERVAL_SEC[tier]
}

/**
 * Post-graduation claims can't be gated on `Position.fee_b_pending` (reads 0
 * between interactions, §3.2). CHOSEN APPROACH: scheduled attempts gated by
 * SIMULATION. On each coin's schedule we simulate the claim (a free RPC call)
 * to read the real claimable delta, and submit a transaction only when it clears
 * `min_sweep`. This avoids both the fragile off-chain fee-growth math and on-chain
 * no-op fees — the cost is one simulate per check, one real tx only when it pays.
 */
export function shouldClaimGraduated(simulatedClaimableLamports: bigint, minSweep: bigint): boolean {
  return simulatedClaimableLamports >= minSweep
}

// ---- epoch stagger by launch_ts (§7.5) ----
/** The boundary at which `epochIndex` ends for a coin. Staggered by launch_ts, so
 *  coins do not all settle at 00:00 UTC and swamp Jupiter in one minute. */
export function epochBoundary(launchTs: number, epochSeconds: number, epochIndex: number): number {
  return launchTs + epochSeconds * (epochIndex + 1)
}
export function currentEpochIndex(launchTs: number, epochSeconds: number, now: number): number {
  return now < launchTs ? -1 : Math.floor((now - launchTs) / epochSeconds)
}
/** The most recent epoch that has fully ended and is ready to settle. */
export function settleableEpoch(launchTs: number, epochSeconds: number, now: number): number {
  return currentEpochIndex(launchTs, epochSeconds, now) - 1
}

// ---- swap with USDC fallback (§7.3; the stall Task 4.2 Part B exposes) ----
export type SwapFailKind = 'too-many-accounts' | 'slippage' | 'delisted' | 'transient'
export class SwapError extends Error {
  kind: SwapFailKind
  constructor(kind: SwapFailKind, msg?: string) { super(msg || kind); this.kind = kind }
}

/** The venue the keeper swaps through. `swap` throws a `SwapError` classifying
 *  the failure so the keeper can decide fall back vs. retry. */
export interface SwapVenue {
  swap(outMint: string, amountIn: bigint, minOut: bigint): Promise<{ amountOut: bigint }>
}

/**
 * Swap one bucket, falling back to USDC on a **degradation** the round can't
 * recover from otherwise (§7.3): the route exceeds `MAX_SWAP_REMAINING`
 * (`TooManySwapAccounts`), can't meet the slippage floor, or the mint was
 * delisted mid-round. Without this the bucket never becomes `swapped`, the epoch
 * stalls at `buckets_complete < bucket_count`, and those holders get nothing — a
 * stall that looks identical to a rug. It falls back ONCE, it does not retry a
 * degraded route forever. A `transient` error is rethrown for the caller's
 * bounded retry — it is not a reason to switch the payout asset.
 */
export async function swapBucketWithFallback(
  venue: SwapVenue, outMint: string, amountIn: bigint, minOut: bigint, usdcMint: string,
  log: (s: string) => void = () => {},
): Promise<{ outMint: string; amountOut: bigint; fellBack: boolean }> {
  try {
    const r = await venue.swap(outMint, amountIn, minOut)
    return { outMint, amountOut: r.amountOut, fellBack: false }
  } catch (e) {
    if (e instanceof SwapError && (e.kind === 'too-many-accounts' || e.kind === 'slippage' || e.kind === 'delisted')) {
      log(`bucket ${outMint} degraded (${e.kind}); falling back to USDC`)
      if (outMint === usdcMint) throw new SwapError(e.kind, `USDC itself degraded (${e.kind}) — cannot fall back further`)
      const r = await venue.swap(usdcMint, amountIn, 0n) // fallback quote; slippage re-checked by the program
      return { outMint: usdcMint, amountOut: r.amountOut, fellBack: true }
    }
    throw e // transient — caller retries; not a fallback trigger
  }
}

// ---- resumable distribution driver (§6 distribute_batch, §16 crash/resume) ----
export interface DistRecipient { wallet: string; amount: bigint }
export interface BucketDistribution { mint: string; epochIndex: number; outMint: string; recipients: DistRecipient[] }

/** The chain surface the driver needs. Production reads BucketState.cursor and
 *  sends distributeBatchIx; tests fake it. */
export interface DistChain {
  cursor(mint: string, epochIndex: number, outMint: string): Promise<number>
  sendBatch(mint: string, epochIndex: number, outMint: string, startIndex: number, recipients: string[], amounts: bigint[]): Promise<void>
}

/**
 * Distribute one bucket, resumably. The on-chain cursor is the single source of
 * truth: the driver re-reads it before every batch and always sends
 * `startIndex == cursor`, which the program enforces (CursorMismatch). A crash at
 * any point leaves the cursor where the last atomic batch committed, so a fresh
 * call simply continues — no bitmap, no double-payment.
 */
export async function distributeBucket(chain: DistChain, bucket: BucketDistribution, batchSize = 15): Promise<number> {
  const total = bucket.recipients.length
  let batches = 0
  for (;;) {
    const cursor = await chain.cursor(bucket.mint, bucket.epochIndex, bucket.outMint)
    if (cursor >= total) break
    const slice = bucket.recipients.slice(cursor, cursor + batchSize)
    await chain.sendBatch(
      bucket.mint, bucket.epochIndex, bucket.outMint, cursor,
      slice.map((r) => r.wallet), slice.map((r) => r.amount),
    )
    batches++
  }
  return batches
}
