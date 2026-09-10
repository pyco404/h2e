import { Store } from './store'
import { TxTransfers, CoinRecord, BalanceEvent } from './types'

/** Addresses always excluded from payout (spec §7.2): pools, burn, H2E vaults,
 *  denylist. The caller adds per-mint pool/vault addresses via `exclude`. */
export const BURN_ADDRESSES = [
  '1nc1nerator11111111111111111111111111111111',
  '11111111111111111111111111111111', // system / null
]

const SEQ_MULT = 100_000 // < max txs per slot; seq = slot*SEQ_MULT + txIndex is unique & ordered

/**
 * Streams SPL transfers into durable per-wallet post-balance history, nets
 * intra-transaction legs, applies exclusions, discovers coins, and — critically —
 * tracks a contiguous-slot watermark so a missed range is DETECTED rather than
 * silently corrupting every payout after it (§7.2, report item 4).
 */
export class Indexer {
  private excluded = new Set<string>(BURN_ADDRESSES)
  private pending = new Map<number, number>() // slot -> ts, for processed slots above the watermark
  private highest = -1

  constructor(private store: Store) {
    // watermark + its block time persist, so a restart resumes from the right slot.
    if (this.store.getMeta('watermark') === undefined) { this.store.setMeta('watermark', '-1'); this.store.setMeta('watermarkTs', '0') }
  }

  get watermarkSlot(): number { return Number(this.store.getMeta('watermark')) }
  /** Block time up to which history is provably complete. A round whose window
   *  end is after this must NOT be settled — it would omit unindexed transfers. */
  get watermarkTs(): number { return Number(this.store.getMeta('watermarkTs')) }
  private setWatermark(slot: number, ts: number) { this.store.setMeta('watermark', String(slot)); this.store.setMeta('watermarkTs', String(ts)) }
  /** The indexer does not own the chain's genesis: the first slot it ever sees
   *  establishes the baseline, so nothing before its start counts as a gap. */
  private baseline(slot: number) {
    if (this.store.getMeta('started') === undefined) {
      this.store.setMeta('started', '1')
      this.setWatermark(slot - 1, 0)
      this.highest = slot - 1
    }
  }

  exclude(addr: string) { this.excluded.add(addr) }
  isExcluded(addr: string) { return this.excluded.has(addr) }

  /** Register a coin (from a CoinConfig-creation subscription) and exclude its
   *  pool + H2E vault ATAs from payout accounting. */
  trackCoin(c: CoinRecord, vaultAddresses: string[] = []) {
    this.store.putCoin(c)
    this.exclude(c.dbcPool)
    for (const v of vaultAddresses) this.exclude(v)
  }
  coins(): CoinRecord[] { return this.store.coins() }

  /** Ingest one transaction: net its legs per (wallet, mint), drop excluded
   *  wallets, and persist one post-balance event per affected wallet+mint. */
  ingestTx(tx: TxTransfers) {
    const net = new Map<string, bigint>() // "mint|wallet" -> net delta
    for (const leg of tx.legs) {
      if (this.excluded.has(leg.wallet)) continue
      const k = leg.mint + '|' + leg.wallet
      net.set(k, (net.get(k) ?? 0n) + leg.delta)
    }
    const seq = tx.slot * SEQ_MULT + tx.txIndex
    for (const [k, delta] of net) {
      if (delta === 0n) continue // net-zero tx: no balance point to record
      const [mint, wallet] = k.split('|')
      const post = this.store.currentBalance(mint, wallet) + delta
      this.store.appendBalance({ mint, wallet, balance: post < 0n ? 0n : post, ts: tx.ts, seq })
    }
  }

  /**
   * Process an entire slot (all its transactions). Advances the contiguous
   * watermark; a skipped range leaves the watermark behind the gap so it is
   * visible, while still ingesting this slot so backfill only needs the hole.
   */
  processSlot(slot: number, ts: number, txs: TxTransfers[]) {
    this.baseline(slot)
    if (slot <= this.watermarkSlot) return // idempotent replay
    for (const tx of txs) this.ingestTx(tx)
    this.pending.set(slot, ts)
    if (slot > this.highest) this.highest = slot
    this.advance()
  }

  /** Fill a previously-missed slot (backfill), then re-advance the watermark. */
  backfill(slot: number, ts: number, txs: TxTransfers[]) {
    if (slot <= this.watermarkSlot) return
    for (const tx of txs) this.ingestTx(tx)
    this.pending.set(slot, ts)
    if (slot > this.highest) this.highest = slot
    this.advance()
  }

  private advance() {
    let wm = this.watermarkSlot, wts = this.watermarkTs
    while (this.pending.has(wm + 1)) {
      wm += 1; wts = this.pending.get(wm)!; this.pending.delete(wm)
    }
    if (wm !== this.watermarkSlot) this.setWatermark(wm, wts)
  }

  /** Missing slot ranges between the watermark and the highest slot seen. A
   *  non-empty result means the in-progress round is not yet safe to settle. */
  gaps(): [number, number][] {
    const out: [number, number][] = []
    let s = this.watermarkSlot + 1
    while (s <= this.highest) {
      if (this.pending.has(s)) { s++; continue }
      let e = s
      while (e + 1 <= this.highest && !this.pending.has(e + 1)) e++
      out.push([s, e]); s = e + 1
    }
    return out
  }

  /** Is the window [.., at] fully indexed? False if the watermark hasn't reached
   *  `at` — the round builder must refuse to settle until it has. */
  windowComplete(at: number): boolean { return this.watermarkTs >= at && this.gaps().length === 0 }

  historyFor(mint: string, since: number): Map<string, BalanceEvent[]> { return this.store.historyFor(mint, since) }
}
