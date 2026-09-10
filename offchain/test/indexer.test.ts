/**
 * Task 2.1 Part B — indexer: durability across restart, intra-tx netting,
 * exclusions, coin discovery, pruning, and missed-block gap detection (§7.2).
 */
import { assert } from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { FileStore } from '../src/indexer/store'
import { Indexer } from '../src/indexer/indexer'
import { TxTransfers, CoinRecord } from '../src/indexer/types'
import { agedBalance, computeRound } from '../src/aged-balance'

const MINT = 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const tx = (txSig: string, slot: number, ts: number, txIndex: number, legs: [string, number][]): TxTransfers =>
  ({ txSig, slot, ts, txIndex, legs: legs.map(([wallet, delta]) => ({ mint: MINT, wallet, delta: BigInt(delta) })) })

function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'h2e-idx-')) }

describe('indexer (§7.2)', () => {
  it('ingests transfers into per-wallet post-balance history', () => {
    const ix = new Indexer(new FileStore())
    ix.processSlot(100, 1000, [tx('a', 100, 1000, 0, [['Alice', 500], ['Bob', 500]])])
    ix.processSlot(101, 1060, [tx('b', 101, 1060, 0, [['Alice', -200]])])
    const h = ix.historyFor(MINT, 0)
    assert.deepEqual(h.get('Alice')!.map((e) => e.balance.toString()), ['500', '300'])
    assert.deepEqual(h.get('Bob')!.map((e) => e.balance.toString()), ['500'])
  })

  it('nets intra-transaction legs into a single post-balance event', () => {
    const ix = new Indexer(new FileStore())
    // Alice in one tx receives 500 then sends 500 (net 0) → no event; Bob nets +300
    ix.processSlot(1, 10, [tx('t', 1, 10, 0, [['Alice', 500], ['Alice', -500], ['Bob', 200], ['Bob', 100]])])
    const h = ix.historyFor(MINT, 0)
    assert.isUndefined(h.get('Alice'), 'net-zero tx records nothing')
    assert.deepEqual(h.get('Bob')!.map((e) => e.balance.toString()), ['300'])
  })

  it('drops excluded addresses (pools, burn, vaults, denylist)', () => {
    const ix = new Indexer(new FileStore())
    ix.exclude('PoolXXXX')
    ix.processSlot(1, 10, [tx('t', 1, 10, 0, [['PoolXXXX', 9999], ['Alice', 100], ['1nc1nerator11111111111111111111111111111111', 5]])])
    const h = ix.historyFor(MINT, 0)
    assert.isUndefined(h.get('PoolXXXX'), 'excluded pool not tracked')
    assert.isUndefined(h.get('1nc1nerator11111111111111111111111111111111'), 'burn excluded by default')
    assert.deepEqual(h.get('Alice')!.map((e) => e.balance.toString()), ['100'])
  })

  it('discovers and lists coins by CoinConfig creation', () => {
    const ix = new Indexer(new FileStore())
    const c: CoinRecord = { mint: MINT, dbcPool: 'PoolAAA', launchTs: 500, defaultPayoutMint: 'So11111111111111111111111111111111111111112', createdSlot: 3 }
    ix.trackCoin(c, ['VaultAAA'])
    assert.deepEqual(ix.coins().map((x) => x.mint), [MINT])
    assert.isTrue(ix.isExcluded('PoolAAA') && ix.isExcluded('VaultAAA'), 'pool + vaults excluded on track')
  })

  it('prune keeps the carried-in balance so window starts stay correct', () => {
    const ix = new Indexer(new FileStore())
    ix.processSlot(1, 100, [tx('a', 1, 100, 0, [['Alice', 1000]])])   // old
    ix.processSlot(2, 100000, [tx('b', 2, 100000, 0, [['Alice', -400]])]) // recent
    const store = (ix as any).store as FileStore
    store.prune(100000) // prune everything before ts=100000
    const h = ix.historyFor(MINT, 0)
    // the old 1000 event is the carried-in balance for any window at/after it → kept
    assert.deepEqual(h.get('Alice')!.map((e) => e.balance.toString()), ['1000', '600'])
  })

  it('RESTART: a new store over the same dir reproduces history, watermark and aged balance', () => {
    const dir = tmpDir()
    try {
      const T = 1_000_000_000, WS = T - 86400
      const ix1 = new Indexer(new FileStore(dir))
      ix1.processSlot(10, WS - 100, [tx('a', 10, WS - 100, 0, [['Alice', 1000]])])
      ix1.processSlot(11, WS + 1000, [tx('b', 11, WS + 1000, 0, [['Alice', -600]])]) // trough 400
      ix1.processSlot(12, WS + 2000, [tx('c', 12, WS + 2000, 0, [['Alice', 500]])])   // back to 900
      const agedBefore = agedBalance(ix1.historyFor(MINT, 0).get('Alice')!, WS, T)
      const wmBefore = ix1.watermarkSlot

      // "crash" — construct a fresh store + indexer over the same directory
      const ix2 = new Indexer(new FileStore(dir))
      assert.equal(ix2.watermarkSlot, wmBefore, 'watermark restored')
      const agedAfter = agedBalance(ix2.historyFor(MINT, 0).get('Alice')!, WS, T)
      assert.equal(agedAfter, agedBefore, 'aged balance identical after restart')
      assert.equal(agedAfter, 400n, 'and correct (the trough)')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('DETECTS a missed slot range and backfill closes it', () => {
    const ix = new Indexer(new FileStore())
    ix.processSlot(1, 10, [tx('a', 1, 10, 0, [['Alice', 100]])])
    ix.processSlot(2, 20, [tx('b', 2, 20, 0, [['Alice', 50]])])
    // slots 3,4 missed; 5 arrives
    ix.processSlot(5, 50, [tx('e', 5, 50, 0, [['Alice', 25]])])
    assert.deepEqual(ix.gaps(), [[3, 4]], 'gap detected')
    assert.equal(ix.watermarkSlot, 2, 'watermark stalls before the gap')
    assert.isFalse(ix.windowComplete(50), 'round over this window must not settle')
    // backfill the hole
    ix.backfill(3, 30, [tx('c', 3, 30, 0, [['Alice', 10]])])
    ix.backfill(4, 40, [tx('d', 4, 40, 0, [['Alice', 10]])])
    assert.deepEqual(ix.gaps(), [], 'gap closed')
    assert.equal(ix.watermarkSlot, 5, 'watermark advances to the highest slot')
    assert.isTrue(ix.windowComplete(50), 'now safe')
  })

  it('feeds computeRound end-to-end (history → aged → eligibility)', () => {
    const T = 1_000_000_000, WS = T - 86400, supply = 100_000n
    const ix = new Indexer(new FileStore())
    ix.processSlot(1, WS - 10, [tx('a', 1, WS - 10, 0, [['Alice', 2000], ['Whale', 5000]])]) // Whale = 5% > 3%
    ix.processSlot(2, WS + 5, [tx('b', 2, WS + 5, 0, [['Bob', 1000]])]) // Bob funded in-window → aged 0
    const res = computeRound(ix.historyFor(MINT, 0), supply, WS, T)
    const byW = Object.fromEntries(res.map((r) => [r.wallet, r]))
    assert.equal(byW['Alice'].aged.toString(), '2000'); assert.isTrue(byW['Alice'].eligible)
    assert.equal(byW['Whale'].aged.toString(), '5000'); assert.isFalse(byW['Whale'].eligible, '>3% excluded')
    assert.equal(byW['Bob'].aged.toString(), '0'); assert.isFalse(byW['Bob'].eligible, 'held <24h')
  })
})
