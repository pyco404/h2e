/**
 * Task 2.2 Part D — election API (§7.6): ed25519 verification, allowlist
 * rejection at submission, anti-replay nonce, and the round/tally readback.
 */
import { assert } from 'chai'
import { createPrivateKey, sign as edSign } from 'crypto'
import { Keypair, PublicKey } from '@solana/web3.js'
import { ElectionApi, ElectionError, electionMessageBytes, ElectionMessage } from '../src/election-api'

const WSOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const NVDA = Keypair.generate().publicKey.toBase58()
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

function signAs(kp: Keypair, m: ElectionMessage): Buffer {
  const seed = Buffer.from(kp.secretKey.slice(0, 32))
  const priv = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' })
  return edSign(null, electionMessageBytes(m), priv)
}

describe('election API (§7.6)', () => {
  const MINT = Keypair.generate().publicKey.toBase58()
  const allowlist = new Set([WSOL, USDC, NVDA])
  const api = () => new ElectionApi(() => allowlist, () => 1234)

  it('accepts a valid signed election and feeds the round builder', () => {
    const a = api()
    const holder = Keypair.generate()
    const m: ElectionMessage = { mint: MINT, epochIndex: 7, outMint: WSOL, nonce: 1 }
    const rec = a.submit(m, signAs(holder, m), holder.publicKey.toBase58())
    assert.equal(rec.outMint, WSOL)
    assert.equal(a.getElection(MINT, 7, holder.publicKey.toBase58())!.outMint, WSOL)
    assert.deepEqual([...a.electionsForRound(MINT, 7)], [[holder.publicKey.toBase58(), WSOL]])
  })

  it('rejects a bad signature (wrong signer)', () => {
    const a = api()
    const holder = Keypair.generate(), attacker = Keypair.generate()
    const m: ElectionMessage = { mint: MINT, epochIndex: 7, outMint: WSOL, nonce: 1 }
    // signature made by attacker, but claims to be holder
    assert.throws(() => a.submit(m, signAs(attacker, m), holder.publicKey.toBase58()), ElectionError, /signature/)
  })

  it('rejects a tampered message (signed for a different out_mint)', () => {
    const a = api()
    const holder = Keypair.generate()
    const signed: ElectionMessage = { mint: MINT, epochIndex: 7, outMint: WSOL, nonce: 1 }
    const sig = signAs(holder, signed)
    const tampered: ElectionMessage = { ...signed, outMint: USDC } // different from what was signed
    assert.throws(() => a.submit(tampered, sig, holder.publicKey.toBase58()), ElectionError, /signature/)
  })

  it('rejects an out_mint not in the round allowlist AT SUBMISSION', () => {
    const a = api()
    const holder = Keypair.generate()
    const notAllowed = Keypair.generate().publicKey.toBase58()
    const m: ElectionMessage = { mint: MINT, epochIndex: 7, outMint: notAllowed, nonce: 1 }
    assert.throws(() => a.submit(m, signAs(holder, m), holder.publicKey.toBase58()), ElectionError, /not electable/)
  })

  it('anti-replay: a replayed or stale nonce is rejected; a higher nonce updates the choice', () => {
    const a = api()
    const holder = Keypair.generate(), w = holder.publicKey.toBase58()
    const m1: ElectionMessage = { mint: MINT, epochIndex: 7, outMint: WSOL, nonce: 5 }
    const sig1 = signAs(holder, m1)
    a.submit(m1, sig1, w)
    // exact replay
    assert.throws(() => a.submit(m1, sig1, w), ElectionError, /nonce/)
    // lower nonce
    const mLow: ElectionMessage = { mint: MINT, epochIndex: 7, outMint: USDC, nonce: 4 }
    assert.throws(() => a.submit(mLow, signAs(holder, mLow), w), ElectionError, /nonce/)
    // higher nonce → updates
    const m2: ElectionMessage = { mint: MINT, epochIndex: 7, outMint: USDC, nonce: 6 }
    a.submit(m2, signAs(holder, m2), w)
    assert.equal(a.getElection(MINT, 7, w)!.outMint, USDC, 'choice updated')
  })

  it('tally reports per-asset counts for the transparency page', () => {
    const a = api()
    for (const [kp, mint] of [[Keypair.generate(), WSOL], [Keypair.generate(), WSOL], [Keypair.generate(), NVDA]] as [Keypair, string][]) {
      const m: ElectionMessage = { mint: MINT, epochIndex: 9, outMint: mint, nonce: 1 }
      a.submit(m, signAs(kp, m), kp.publicKey.toBase58())
    }
    const t = a.tally(MINT, 9)
    assert.equal(t.get(WSOL), 2); assert.equal(t.get(NVDA), 1)
  })
})
