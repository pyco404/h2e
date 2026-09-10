import { createHash } from 'crypto'
import { PublicKey } from '@solana/web3.js'
import { BalanceEvent, computeRound, HOLDER_CAP_BPS } from './aged-balance'

/**
 * Round builder (spec §7.4). Consumes Task 2.1's aged balances and produces the
 * per-asset buckets, the WSOL allocation, and the Merkle root that
 * `settle_epoch` anchors. Two runs over the same inputs are byte-identical.
 *
 * Hard gate (item 0): the caller MUST pass `windowComplete = true`. A missed
 * block range makes every aged balance wrong and nothing on-chain rejects it —
 * the program bounds how much leaves a bucket, not whether the right wallets are
 * in it. `build` throws `RoundNotReady` otherwise; the keeper backfills and
 * retries, never settling over a gap.
 */

export class RoundNotReady extends Error {}

export interface Election { wallet: string; outMint: string }

export interface RoundInput {
  mint: string
  epochIndex: number
  epochEndTs: number
  windowStart: number
  supply: bigint
  /** 60% WSOL frozen for holders at settle (the payout_amount EpochState will hold). */
  payoutAmount: bigint
  history: Map<string, BalanceEvent[]>
  excluded: Set<string>
  /** wallet -> elected out_mint (off-chain elections, §7.6). */
  elections: Map<string, string>
  /** the coin's permanent default for non-electors. */
  defaultPayoutMint: string
  usdcMint: string
  /** the round's on-chain allowlist snapshot (must be a subset of PlatformAllowlist). */
  allowlist: Set<string>
  /** true iff the indexer watermark has reached epochEndTs with no gaps. */
  windowComplete: boolean
  /** minimum WSOL-equivalent share worth sending (≈ ATA rent, ~0.002 SOL). */
  minShareLamports: bigint
  capBps?: number
}

export interface Recipient { wallet: string; weight: bigint; amountInWsol: bigint }
export interface Bucket { outMint: string; amountIn: bigint; recipientCount: number; recipients: Recipient[] }
export interface RoundPlan {
  mint: string
  epochIndex: number
  epochEndTs: number
  totalWeight: bigint
  payoutAmount: bigint
  buckets: Bucket[]           // sorted by outMint
  bucketCount: number
  merkleRoot: Uint8Array
  droppedSubRent: string[]        // wallets whose share was below rent — rolls over
  droppedShareLamports: bigint    // Σ of dropped shares; swap = payoutAmount − this, remainder rolls over
  entries: { wallet: string; outMint: string; weight: bigint }[] // full eligible set, leaf order (paid + dropped)
}

const cmpPubkey = (a: string, b: string): number => {
  const ba = new PublicKey(a).toBuffer(), bb = new PublicKey(b).toBuffer()
  return Buffer.compare(ba, bb)
}
const leBytes = (v: bigint, n = 16): Buffer => {
  const b = Buffer.alloc(n)
  let x = v
  for (let i = 0; i < n; i++) { b[i] = Number(x & 0xffn); x >>= 8n }
  return b
}
const sha256 = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest()

/** Sorted-leaf Merkle root (sha256). Leaf commits (wallet, out_mint, weight), so
 *  a holder can verify their own weight and hence amount = weight/Σ × amount_out. */
export function merkleRoot(leaves: Buffer[]): Uint8Array {
  if (leaves.length === 0) return new Uint8Array(32)
  let level = leaves
  while (level.length > 1) {
    const next: Buffer[] = []
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i], r = i + 1 < level.length ? level[i + 1] : level[i]
      // order the pair so the tree is independent of side (standard sorted pair)
      next.push(Buffer.compare(l, r) <= 0 ? sha256(l, r) : sha256(r, l))
    }
    level = next
  }
  return new Uint8Array(level[0])
}

export function build(input: RoundInput): RoundPlan {
  if (!input.windowComplete) throw new RoundNotReady(`indexer watermark behind epoch_end ${input.epochEndTs}; backfill before settling`)

  const capBps = input.capBps ?? HOLDER_CAP_BPS
  // Steps 2–3: aged balance, drop excluded / zero / >3%. computeRound sorts by pubkey.
  const aged = computeRound(input.history, input.supply, input.windowStart, input.epochEndTs, input.excluded, capBps)
    .filter((r) => r.eligible) // eligible == aged>0 and ≤3%

  // total_weight includes every eligible wallet, even those dropped for sub-rent:
  // their WSOL is simply not sent and rolls into the next round (nothing lost,
  // and no windfall redistribution to the others).
  let totalWeight = 0n
  for (const r of aged) totalWeight += r.aged
  if (totalWeight === 0n) {
    return { mint: input.mint, epochIndex: input.epochIndex, epochEndTs: input.epochEndTs, totalWeight: 0n, payoutAmount: input.payoutAmount, buckets: [], bucketCount: 0, merkleRoot: new Uint8Array(32), droppedSubRent: [], droppedShareLamports: 0n, entries: [] }
  }

  // Step 4: resolve each wallet's payout asset.
  const resolveAsset = (wallet: string): string => {
    const elected = input.elections.get(wallet)
    if (elected && input.allowlist.has(elected)) return elected
    // non-elector (or elected mint no longer allowlisted) → default, then USDC
    if (input.allowlist.has(input.defaultPayoutMint)) return input.defaultPayoutMint
    return input.usdcMint
  }

  // Steps 5–6 (dust fix, §7.4): DROP BEFORE SWAP. Every share derives from the
  // full total_weight; sub-rent wallets are committed to the Merkle tree (so the
  // dropped total is independently verifiable) but left out of the payout list.
  // Only `payout_amount − Σ(dropped shares)` is ever swapped; the remainder stays
  // as WSOL and is captured by the next settle_epoch. Dropping AFTER the swap
  // would strand value in the out-mint ATA (settle only snapshots WSOL);
  // recomputing total_weight over paid wallets only would redistribute the dust.
  const dropped: string[] = []
  let droppedShareLamports = 0n
  const byMint = new Map<string, Recipient[]>()
  const allEligible: { wallet: string; outMint: string; weight: bigint }[] = []
  for (const r of aged) {
    const outMint = resolveAsset(r.wallet)
    const amountInWsol = (r.aged * input.payoutAmount) / totalWeight
    allEligible.push({ wallet: r.wallet, outMint, weight: r.aged }) // committed to the root
    if (amountInWsol < input.minShareLamports) { dropped.push(r.wallet); droppedShareLamports += amountInWsol; continue }
    let arr = byMint.get(outMint); if (!arr) { arr = []; byMint.set(outMint, arr) }
    arr.push({ wallet: r.wallet, weight: r.aged, amountInWsol })
  }

  // Step 7: per bucket, sort recipients by pubkey ascending; buckets sorted by outMint.
  const buckets: Bucket[] = []
  for (const outMint of [...byMint.keys()].sort(cmpPubkey)) {
    const recips = byMint.get(outMint)!.sort((a, b) => cmpPubkey(a.wallet, b.wallet))
    let amountIn = 0n
    for (const r of recips) amountIn += r.amountInWsol
    buckets.push({ outMint, amountIn, recipientCount: recips.length, recipients: recips })
  }

  // The Merkle root commits to ALL eligible wallets (paid + dropped), globally
  // pubkey-sorted, so a verifier reconstructs total_weight and can confirm which
  // wallets were dropped and that their combined share matches droppedShareLamports.
  const orderedEntries = allEligible.sort((a, b) => cmpPubkey(a.wallet, b.wallet))
  const leaves = orderedEntries.map((e) => leafFor(e.wallet, e.outMint, e.weight))
  const root = merkleRoot(leaves)

  return {
    mint: input.mint, epochIndex: input.epochIndex, epochEndTs: input.epochEndTs,
    totalWeight, payoutAmount: input.payoutAmount, buckets, bucketCount: buckets.length,
    merkleRoot: root, droppedSubRent: dropped.sort(cmpPubkey), droppedShareLamports,
    entries: orderedEntries,
  }
}

// ---- §7.5c round file + Merkle proofs (frozen encoding) ----
/** The pinned leaf: sha256(wallet ‖ out_mint ‖ weight_u128_le). Public spec. */
export function leafFor(wallet: string, outMint: string, weight: bigint): Buffer {
  return sha256(new PublicKey(wallet).toBuffer(), new PublicKey(outMint).toBuffer(), leBytes(weight, 16))
}
const pairHash = (l: Buffer, r: Buffer) => (Buffer.compare(l, r) <= 0 ? sha256(l, r) : sha256(r, l))

/** Sibling path for the leaf at `index` (sorted-pair tree, duplicate-last on odd). */
export function merkleProof(leaves: Buffer[], index: number): Buffer[] {
  const proof: Buffer[] = []
  let idx = index, level = leaves
  while (level.length > 1) {
    const sibIdx = idx % 2 === 1 ? idx - 1 : idx + 1
    proof.push(sibIdx < level.length ? level[sibIdx] : level[idx]) // duplicate self on odd tail
    const next: Buffer[] = []
    for (let i = 0; i < level.length; i += 2) next.push(pairHash(level[i], i + 1 < level.length ? level[i + 1] : level[i]))
    idx = Math.floor(idx / 2); level = next
  }
  return proof
}

/** Verify a leaf against the root using its proof. Sorted-pair, so side-agnostic. */
export function verifyLeaf(leaf: Buffer, proof: Buffer[], root: Uint8Array): boolean {
  let h = leaf
  for (const sib of proof) h = pairHash(h, sib)
  return Buffer.compare(h, Buffer.from(root)) === 0
}

export interface RoundFileEntry { wallet: string; outMint: string; weight: string; dropped: boolean }
export interface RoundFile {
  mint: string; epochIndex: number; epochEndTs: number
  totalWeight: string; payoutAmount: string; droppedShareLamports: string
  merkleRoot: string
  leafEncoding: string
  entries: RoundFileEntry[]   // every eligible wallet, in leaf order (pubkey-ascending)
}

/**
 * The publishable round file (§7.5c). Contains every eligible wallet including
 * sub-rent drops, in the exact leaf order, so any holder can recompute their leaf
 * and a proof and check it against the on-chain root. Served per round at a
 * stable URL; the root on-chain makes a tampered file non-reproducible.
 */
export function buildRoundFile(p: RoundPlan): RoundFile {
  const dropped = new Set(p.droppedSubRent)
  return {
    mint: p.mint, epochIndex: p.epochIndex, epochEndTs: p.epochEndTs,
    totalWeight: p.totalWeight.toString(), payoutAmount: p.payoutAmount.toString(),
    droppedShareLamports: p.droppedShareLamports.toString(),
    merkleRoot: Buffer.from(p.merkleRoot).toString('hex'),
    leafEncoding: 'sha256(wallet32 ‖ out_mint32 ‖ weight_u128_le); global pubkey-byte ascending; sorted-pair sha256',
    // p.entries is the full eligible set (paid + dropped) already in leaf order.
    entries: p.entries.map((e) => ({ wallet: e.wallet, outMint: e.outMint, weight: e.weight.toString(), dropped: dropped.has(e.wallet) })),
  }
}

/** Stable serialization, for the determinism test and for publishing the round. */
export function serializePlan(p: RoundPlan): string {
  return JSON.stringify({
    mint: p.mint, epochIndex: p.epochIndex, epochEndTs: p.epochEndTs,
    totalWeight: p.totalWeight.toString(), payoutAmount: p.payoutAmount.toString(),
    bucketCount: p.bucketCount,
    buckets: p.buckets.map((b) => ({ outMint: b.outMint, amountIn: b.amountIn.toString(), recipientCount: b.recipientCount, recipients: b.recipients.map((r) => ({ wallet: r.wallet, weight: r.weight.toString(), amountInWsol: r.amountInWsol.toString() })) })),
    merkleRoot: Buffer.from(p.merkleRoot).toString('hex'),
    droppedSubRent: p.droppedSubRent,
    droppedShareLamports: p.droppedShareLamports.toString(),
  })
}
