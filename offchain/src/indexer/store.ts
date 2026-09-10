import * as fs from 'fs'
import * as path from 'path'
import { BalanceEvent } from '../aged-balance'
import { StoredBalance, CoinRecord } from './types'

/**
 * Persistence for the indexer. Two implementations behind one interface so the
 * indexer logic is storage-agnostic and testable in memory.
 *
 * Storage choice (offline scaffold): an append-only JSONL log per record kind
 * plus a small meta file. Rationale — an indexer that loses history on a crash
 * cannot compute aged balances for the round in progress (§7.2), so the store
 * must be durable and replayable. Append-only is the simplest crash-safe shape:
 * a torn final line is dropped on reload and everything before it is intact; no
 * in-place mutation can corrupt earlier records. For production I'd move to
 * PostgreSQL (or a time-series store) behind this same interface — see the
 * report — but the durability argument is identical.
 */
export interface Store {
  appendBalance(b: StoredBalance): void
  /** All post-tx balance events for a mint at/after `since`, grouped by wallet. */
  historyFor(mint: string, since: number): Map<string, BalanceEvent[]>
  /** Latest known balance for a wallet+mint (for computing the next post-balance). */
  currentBalance(mint: string, wallet: string): bigint
  prune(before: number): void
  putCoin(c: CoinRecord): void
  coins(): CoinRecord[]
  getMeta(key: string): string | undefined
  setMeta(key: string, value: string): void
  flush(): void
  close(): void
}

interface Persisted { balances: StoredBalance[]; coins: CoinRecord[]; meta: Record<string, string> }

/** In-memory store with an optional JSONL file backing. Reloads by replaying the
 *  log, so a restart reproduces state exactly (the operational failure that
 *  actually happens — spec §7.2). */
export class FileStore implements Store {
  private balances: StoredBalance[] = []
  private coinsMap = new Map<string, CoinRecord>()
  private meta: Record<string, string> = {}
  // fast index: mint|wallet -> latest balance
  private latest = new Map<string, bigint>()
  private dir: string | null

  constructor(dir?: string) {
    this.dir = dir || null
    if (this.dir) { fs.mkdirSync(this.dir, { recursive: true }); this.reload() }
  }

  private file(name: string) { return path.join(this.dir!, name) }
  private key(mint: string, wallet: string) { return mint + '|' + wallet }

  private reload() {
    // Replay the append-only logs; tolerate a torn last line.
    const readJsonl = (name: string): any[] => {
      const p = this.file(name)
      if (!fs.existsSync(p)) return []
      const out: any[] = []
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { out.push(JSON.parse(line)) } catch { /* torn final record — drop it */ }
      }
      return out
    }
    for (const r of readJsonl('balances.jsonl')) {
      const b: StoredBalance = { mint: r.mint, wallet: r.wallet, balance: BigInt(r.balance), ts: r.ts, seq: r.seq }
      this.balances.push(b)
      this.latest.set(this.key(b.mint, b.wallet), b.balance)
    }
    for (const r of readJsonl('coins.jsonl')) this.coinsMap.set(r.mint, r as CoinRecord)
    const metaPath = this.dir ? this.file('meta.json') : null
    if (metaPath && fs.existsSync(metaPath)) { try { this.meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) } catch {} }
  }

  private appendLine(name: string, obj: any) {
    if (!this.dir) return
    fs.appendFileSync(this.file(name), JSON.stringify(obj) + '\n')
  }

  appendBalance(b: StoredBalance) {
    this.balances.push(b)
    this.latest.set(this.key(b.mint, b.wallet), b.balance)
    this.appendLine('balances.jsonl', { mint: b.mint, wallet: b.wallet, balance: b.balance.toString(), ts: b.ts, seq: b.seq })
  }

  currentBalance(mint: string, wallet: string): bigint { return this.latest.get(this.key(mint, wallet)) ?? 0n }

  historyFor(mint: string, since: number): Map<string, BalanceEvent[]> {
    const out = new Map<string, BalanceEvent[]>()
    for (const b of this.balances) {
      if (b.mint !== mint || b.ts < since) continue
      let arr = out.get(b.wallet); if (!arr) { arr = []; out.set(b.wallet, arr) }
      arr.push({ balance: b.balance, ts: b.ts, seq: b.seq })
    }
    return out
  }

  prune(before: number) {
    // Keep, per wallet+mint, the last event strictly before `before` (the
    // carried-in balance) plus everything at/after it — dropping older history
    // would corrupt the window's starting balance.
    const lastBefore = new Map<string, StoredBalance>()
    for (const b of this.balances) {
      if (b.ts < before) {
        const k = this.key(b.mint, b.wallet)
        const cur = lastBefore.get(k)
        if (!cur || b.ts > cur.ts || (b.ts === cur.ts && b.seq > cur.seq)) lastBefore.set(k, b)
      }
    }
    const keep: StoredBalance[] = []
    for (const b of this.balances) {
      if (b.ts >= before) keep.push(b)
      else if (lastBefore.get(this.key(b.mint, b.wallet)) === b) keep.push(b)
    }
    this.balances = keep
    if (this.dir) { // rewrite the log compacted
      fs.writeFileSync(this.file('balances.jsonl'), keep.map((b) => JSON.stringify({ mint: b.mint, wallet: b.wallet, balance: b.balance.toString(), ts: b.ts, seq: b.seq })).join('\n') + (keep.length ? '\n' : ''))
    }
  }

  putCoin(c: CoinRecord) { if (!this.coinsMap.has(c.mint)) { this.coinsMap.set(c.mint, c); this.appendLine('coins.jsonl', c) } }
  coins(): CoinRecord[] { return [...this.coinsMap.values()].sort((a, b) => (a.mint < b.mint ? -1 : 1)) }
  getMeta(key: string) { return this.meta[key] }
  setMeta(key: string, value: string) { this.meta[key] = value; if (this.dir) fs.writeFileSync(this.file('meta.json'), JSON.stringify(this.meta)) }
  flush() {}
  close() {}
}
