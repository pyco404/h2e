/**
 * Task 4.1 Part D — round-file publish → fetch → verify, end to end. Proves the
 * published file recomputes to the same root a holder reads on-chain, through a
 * JSON round-trip (what the browser actually fetches).
 */
import { assert } from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { Keypair } from '@solana/web3.js'
import { build, RoundInput, leafFor, merkleProof, verifyLeaf } from '../src/round-builder'
import { RoundStore, roundHandler } from '../src/round-publisher'
import { BalanceEvent } from '../src/aged-balance'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const WSOL = 'So11111111111111111111111111111111111111112'
const DAY = 86400, T = 1_000_000_000, WS = T - DAY
const ev = (b: number, ts: number): BalanceEvent => ({ balance: BigInt(b), ts, seq: 0 })
const W = () => Keypair.generate().publicKey.toBase58()

describe('round-file publication (§7.5c)', () => {
  it('publish → GET /round → recompute root → verify a holder leaf', () => {
    const wallets = Array.from({ length: 9 }, () => W())
    const history = new Map<string, BalanceEvent[]>(wallets.map((w, i) => [w, [ev(1000 + i, WS - 5)]]))
    const input: RoundInput = {
      mint: W(), epochIndex: 4, epochEndTs: T, windowStart: WS, supply: 1_000_000n, payoutAmount: 50_000_000n,
      history, excluded: new Set(), elections: new Map(wallets.slice(0, 3).map((w) => [w, WSOL])),
      defaultPayoutMint: USDC, usdcMint: USDC, allowlist: new Set([WSOL, USDC]), windowComplete: true, minShareLamports: 1n,
    }
    const plan = build(input)

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2e-round-'))
    try {
      const store = new RoundStore(dir)
      store.publish(plan)
      const handler = roundHandler(store)

      // miss + bad request
      assert.equal(handler(`/round?mint=${plan.mint}&epoch=999`).status, 404)
      assert.equal(handler('/round').status, 400)

      // real fetch (JSON round-trip, exactly what the browser gets)
      const res = handler(`/round?mint=${plan.mint}&epoch=${plan.epochIndex}`)
      assert.equal(res.status, 200)
      const file = JSON.parse(res.body)
      assert.equal(file.merkleRoot, Buffer.from(plan.merkleRoot).toString('hex'))
      assert.equal(file.entries.length, plan.entries.length)

      // recompute the root from the fetched file and verify each leaf against the plan root
      const leaves = file.entries.map((e: any) => leafFor(e.wallet, e.outMint, BigInt(e.weight)))
      for (let i = 0; i < file.entries.length; i++) {
        const e = file.entries[i]
        assert.isTrue(verifyLeaf(leafFor(e.wallet, e.outMint, BigInt(e.weight)), merkleProof(leaves, i), plan.merkleRoot), `leaf ${i} verifies from the fetched file`)
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
