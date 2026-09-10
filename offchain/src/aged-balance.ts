/**
 * Aged-balance engine (spec §1.1). The highest-risk off-chain logic in the
 * system: everything about who gets paid, and how much, is this one number.
 *
 * A wallet's aged balance at time `t` is the MINIMUM balance it held at any point
 * in `[t − 24h, t]`. Both eligibility and payout weight use it; never the current
 * balance (§1.1). A dust transfer that raises the current balance can never raise
 * the aged balance, which is the only reason the 3% cliff is safe (§1.2).
 *
 * Input model: a `BalanceEvent` is the wallet's token balance AFTER one
 * transaction (the indexer nets intra-transaction transfers into a single
 * post-balance). Between transactions the balance is a constant step, so the
 * minimum over the window is the minimum of: the balance carried in at the window
 * start, and every post-transaction balance inside the window.
 */

export interface BalanceEvent {
  /** post-transaction absolute balance (base units). */
  balance: bigint
  /** unix seconds of the transaction. */
  ts: number
  /** deterministic tiebreak for same-ts events (e.g. slot*N + txIndex). Ascending. */
  seq: number
}

/** Sort events into the canonical order the engine assumes: (ts, seq) ascending. */
export function sortEvents(events: BalanceEvent[]): BalanceEvent[] {
  return [...events].sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq))
}

/**
 * Aged balance for ONE wallet+mint over `[windowStart, at]`.
 * `events` must be that wallet's post-tx balances (any order; sorted here).
 */
export function agedBalance(events: BalanceEvent[], windowStart: number, at: number): bigint {
  const sorted = sortEvents(events)
  // Balance carried into the window: the balance after the last event at or
  // before windowStart. If the wallet had no balance yet, it is 0.
  let carried = 0n
  for (const e of sorted) {
    if (e.ts <= windowStart) carried = e.balance
    else break
  }
  let min = carried
  for (const e of sorted) {
    if (e.ts > windowStart && e.ts <= at) {
      if (e.balance < min) min = e.balance
    }
  }
  return min
}

export const HOLDER_CAP_BPS = 300 // ≤3% of supply (spec §1.2), mirrors GlobalConfig.holder_cap_bps

/** Eligible if the aged balance is positive (held ≥24h) and not over the 3% cap.
 *  Over-cap is EXCLUDED entirely, not capped (§1.2). Uses aged balance, so a
 *  dust transfer that pushes the *current* balance over 3% does nothing. */
export function isEligible(aged: bigint, supply: bigint, capBps = HOLDER_CAP_BPS): boolean {
  if (aged <= 0n) return false
  // aged/supply > capBps/10000  ⟺  aged*10000 > capBps*supply
  return aged * 10_000n <= BigInt(capBps) * supply
}

export interface AgedResult { wallet: string; aged: bigint; eligible: boolean }

/**
 * Compute aged balance + eligibility for every wallet in a round. `history` maps
 * wallet → its post-tx balance events for the tracked mint. `excluded` are
 * addresses dropped regardless (§7.2: pools, burn, vaults, denylist). Output is
 * sorted by wallet pubkey ascending, so two runs over the same inputs are
 * byte-identical (spec §7.4).
 */
export function computeRound(
  history: Map<string, BalanceEvent[]>,
  supply: bigint,
  windowStart: number,
  at: number,
  excluded: Set<string> = new Set(),
  capBps = HOLDER_CAP_BPS,
): AgedResult[] {
  const out: AgedResult[] = []
  for (const [wallet, events] of history) {
    if (excluded.has(wallet)) continue
    const aged = agedBalance(events, windowStart, at)
    out.push({ wallet, aged, eligible: isEligible(aged, supply, capBps) })
  }
  out.sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0))
  return out
}
