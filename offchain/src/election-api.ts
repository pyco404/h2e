import { createPublicKey, verify as edVerify } from 'crypto'
import { PublicKey } from '@solana/web3.js'

/**
 * Election API (spec §7.6). A holder signs `{mint, epoch_index, out_mint, nonce}`
 * with their wallet; we verify the ed25519 signature and store their choice.
 * Non-electors are not stored — the round builder defaults them silently and
 * permanently to the coin's `default_payout_mint`, no rollover.
 *
 * Elections for a mint not in the round's allowlist are rejected AT SUBMISSION,
 * so the holder gets an error now rather than a silent fallback at settle.
 *
 * ed25519 verification uses Node's built-in crypto (no tweetnacl needed): the raw
 * 32-byte pubkey is wrapped in the Ed25519 SPKI DER prefix.
 */

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
export function verifyEd25519(message: Buffer, signature: Buffer, pubkey32: Buffer): boolean {
  if (pubkey32.length !== 32 || signature.length !== 64) return false
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pubkey32]), format: 'der', type: 'spki' })
    return edVerify(null, message, key, signature)
  } catch { return false }
}

export interface ElectionMessage { mint: string; epochIndex: number; outMint: string; nonce: number }

/** Canonical bytes the wallet signs. Fixed, versioned, unambiguous — the client
 *  must produce exactly this so the signature verifies. */
export function electionMessageBytes(m: ElectionMessage): Buffer {
  return Buffer.from(`h2e-election:v1:${m.mint}:${m.epochIndex}:${m.outMint}:${m.nonce}`, 'utf8')
}

export interface StoredElection { wallet: string; mint: string; epochIndex: number; outMint: string; nonce: number; ts: number }

/** Provides the allowlist for a given round. Backed by the on-chain
 *  AllowlistState snapshot / electable list — never invented here. */
export type AllowlistProvider = (mint: string, epochIndex: number) => Set<string>

export class ElectionError extends Error {}

export class ElectionApi {
  // key: mint|epoch|wallet -> latest election
  private store = new Map<string, StoredElection>()

  constructor(private allowlistFor: AllowlistProvider, private now: () => number = () => Math.floor(Date.now() / 1000)) {}

  private key(mint: string, epoch: number, wallet: string) { return `${mint}|${epoch}|${wallet}` }

  /**
   * Submit a signed election. Throws ElectionError on: bad signature, out_mint
   * not in the round's allowlist, or a replayed/stale nonce.
   */
  submit(m: ElectionMessage, signature: Buffer, walletBase58: string): StoredElection {
    // 1. valid pubkeys
    let walletPk: PublicKey, outPk: PublicKey
    try { walletPk = new PublicKey(walletBase58); outPk = new PublicKey(m.outMint); new PublicKey(m.mint) }
    catch { throw new ElectionError('invalid pubkey in election') }

    // 2. signature over the exact canonical message, by this wallet
    if (!verifyEd25519(electionMessageBytes(m), signature, walletPk.toBuffer())) {
      throw new ElectionError('signature does not verify for this wallet')
    }

    // 3. out_mint must be in THIS round's allowlist — reject now, not at settle
    if (!this.allowlistFor(m.mint, m.epochIndex).has(outPk.toBase58())) {
      throw new ElectionError(`out_mint ${m.outMint} is not electable for ${m.mint} epoch ${m.epochIndex}`)
    }

    // 4. anti-replay: nonce must strictly increase per (wallet, mint, epoch), so a
    //    captured message cannot be replayed and a holder can still change choice.
    const k = this.key(m.mint, m.epochIndex, walletBase58)
    const prev = this.store.get(k)
    if (prev && m.nonce <= prev.nonce) throw new ElectionError('stale or replayed nonce')

    const rec: StoredElection = { wallet: walletBase58, mint: m.mint, epochIndex: m.epochIndex, outMint: outPk.toBase58(), nonce: m.nonce, ts: this.now() }
    this.store.set(k, rec)
    return rec
  }

  getElection(mint: string, epochIndex: number, wallet: string): StoredElection | undefined {
    return this.store.get(this.key(mint, epochIndex, wallet))
  }

  /** Feed the round builder: wallet -> elected out_mint for a round. */
  electionsForRound(mint: string, epochIndex: number): Map<string, string> {
    const out = new Map<string, string>()
    for (const rec of this.store.values()) if (rec.mint === mint && rec.epochIndex === epochIndex) out.set(rec.wallet, rec.outMint)
    return out
  }

  /** Per-asset tally for the transparency page (§7.5b election readback). */
  tally(mint: string, epochIndex: number): Map<string, number> {
    const out = new Map<string, number>()
    for (const rec of this.store.values()) if (rec.mint === mint && rec.epochIndex === epochIndex) out.set(rec.outMint, (out.get(rec.outMint) ?? 0) + 1)
    return out
  }
}
