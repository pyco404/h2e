/**
 * Task 2.1 Part C — aged-balance engine, tested adversarially (spec §1.1/§1.2).
 * The ten cases the task names; 5 (dust grief) and 10 (restart) matter most.
 */
import { assert } from 'chai'
import { agedBalance, isEligible, computeRound, BalanceEvent } from '../src/aged-balance'

const DAY = 86400
const T = 1_000_000_000       // settle time
const WS = T - DAY            // window start
// event helper: balance after a tx at ts, with a deterministic tiebreak seq.
const ev = (balance: number | bigint, ts: number, seq = 0): BalanceEvent => ({ balance: BigInt(balance), ts, seq })

describe('aged-balance engine (§1.1)', () => {
  it('1. continuous hold across the whole window → full balance', () => {
    const e = [ev(1000, T - 2 * DAY)] // funded before the window, never changed
    assert.equal(agedBalance(e, WS, T), 1000n)
  })

  it('2. sell half mid-window then rebuy → the trough, not current or average', () => {
    const e = [ev(1000, T - 2 * DAY), ev(500, WS + 1000), ev(1000, WS + 2000)]
    assert.equal(agedBalance(e, WS, T), 500n, 'aged = the 500 trough')
  })

  it('3. funded 23h59m before settle → not eligible (aged 0)', () => {
    const e = [ev(1000, WS + 60)] // 60s into the window = 23h59m before T
    const aged = agedBalance(e, WS, T)
    assert.equal(aged, 0n, 'carried-in balance was 0 for part of the window')
    assert.isFalse(isEligible(aged, 100000n))
  })

  it('4. funded 24h01m before settle → eligible for the funded amount', () => {
    const e = [ev(1000, WS - 60)] // 60s before the window opened
    const aged = agedBalance(e, WS, T)
    assert.equal(aged, 1000n)
    assert.isTrue(isEligible(aged, 100000n))
  })

  it('5. DUST GRIEF: a transfer pushing current over 3% just before settle leaves aged unchanged and eligible', () => {
    const supply = 100_000n
    // wallet has held 2,900 (2.9%) across the window; attacker sends +200 at T-10,
    // making the CURRENT balance 3,100 (3.1%, over the 3% cap).
    const e = [ev(2900, T - 2 * DAY), ev(3100, T - 10)]
    const aged = agedBalance(e, WS, T)
    assert.equal(aged, 2900n, 'aged is the trough, unaffected by the raise')
    assert.isTrue(isEligible(aged, supply), 'still eligible: 2.9% aged ≤ 3%')
    // proof the grief targets current balance, which IS over the cap:
    assert.isFalse(isEligible(3100n, supply), 'current balance would be excluded — but we never use it')
  })

  it('6. full exit and return inside the window → aged 0', () => {
    const e = [ev(1000, T - 2 * DAY), ev(0, WS + 100), ev(1000, WS + 200)]
    assert.equal(agedBalance(e, WS, T), 0n)
  })

  it('7. same-slot (two txs) and same-tx (netted) changes', () => {
    // same-tx: the indexer nets intra-tx transfers into ONE post-balance, so an
    // in-and-out within a tx never shows an intermediate — a single event.
    const sameTx = [ev(1000, T - 2 * DAY), ev(1000, WS + 100)] // net-zero tx
    assert.equal(agedBalance(sameTx, WS, T), 1000n, 'intra-tx churn does not create a trough')
    // same-slot, two txs: both post-balances count, so a dip-and-recover in one
    // slot IS captured.
    const sameSlot = [ev(1000, T - 2 * DAY), ev(300, WS + 200, 0), ev(1000, WS + 200, 1)]
    assert.equal(agedBalance(sameSlot, WS, T), 300n, 'the between-tx dip is a held state')
  })

  it('8. receive/send/receive with no net change, never below base → aged = base', () => {
    const e = [ev(1000, T - 2 * DAY), ev(1500, WS + 10), ev(1000, WS + 20), ev(1300, WS + 30), ev(1000, WS + 40)]
    assert.equal(agedBalance(e, WS, T), 1000n)
  })

  it('9. determinism: shuffled input order → identical output', () => {
    const supply = 1_000_000n
    const mk = (): Map<string, BalanceEvent[]> => new Map([
      ['Wb', [ev(500, WS - 10), ev(200, WS + 5)]],
      ['Wa', [ev(1000, WS - 10)]],
      ['Wc', [ev(9999, WS + 100)]], // funded in-window → aged 0
    ])
    const a = computeRound(mk(), supply, WS, T)
    // shuffle the per-wallet event arrays and map order
    const shuffled = new Map<string, BalanceEvent[]>()
    for (const k of ['Wc', 'Wa', 'Wb']) shuffled.set(k, [...mk().get(k)!].reverse())
    const b = computeRound(shuffled, supply, WS, T)
    const ser = (r: any[]) => JSON.stringify(r.map((x) => ({ w: x.wallet, a: x.aged.toString(), e: x.eligible })))
    assert.equal(ser(a), ser(b), 'byte-identical')
    assert.deepEqual(a.map((x) => x.wallet), ['Wa', 'Wb', 'Wc'], 'sorted by pubkey ascending')
  })

  it('10. RESTART mid-window: reload persisted events → identical aged balances', () => {
    // Events split across a "crash": phase 1 persisted, then the indexer restarts
    // and ingests phase 2. The engine is a pure function of the union, so the
    // result must equal an uninterrupted run.
    const all = [ev(1000, WS - 100), ev(400, WS + 1000), ev(900, WS + 2000)]
    const uninterrupted = agedBalance(all, WS, T)

    const phase1 = [all[0], all[1]]
    const phase2 = [all[2]]
    // simulate persistence across restart: serialize phase1 (bigint-safe), reload
    const persisted = JSON.parse(JSON.stringify(phase1.map((e) => ({ ...e, balance: e.balance.toString() }))))
    const reloaded: BalanceEvent[] = persisted.map((e: any) => ({ balance: BigInt(e.balance), ts: e.ts, seq: e.seq }))
    const afterRestart = agedBalance([...reloaded, ...phase2], WS, T)

    assert.equal(afterRestart, uninterrupted, 'restart reproduces the uninterrupted aged balance')
    assert.equal(afterRestart, 400n, 'and it is the correct trough')
  })
})
