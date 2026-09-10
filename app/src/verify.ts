import { PublicKey } from '@solana/web3.js'

/**
 * In-browser round-file verification (§7.5c). Recomputes the Merkle root from the
 * published round file using the FROZEN leaf encoding and compares it to the
 * on-chain root read from EpochState. If they match, the file is authentic — a
 * tampered file cannot reproduce the on-chain root. Then the holder finds their
 * own entry and checks their amount. Uses Web Crypto (subtle), not node crypto,
 * but the encoding is byte-identical to the off-chain builder.
 *
 *   leaf  = sha256(wallet32 ‖ out_mint32 ‖ weight_u128_le)
 *   order = global ascending by wallet pubkey bytes
 *   tree  = sorted-pair sha256
 */
export interface RoundFileEntry { wallet: string; outMint: string; weight: string; dropped: boolean }
export interface RoundFile {
  mint: string; epochIndex: number; epochEndTs: number
  totalWeight: string; payoutAmount: string; droppedShareLamports: string
  merkleRoot: string; leafEncoding: string; entries: RoundFileEntry[]
}

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(n); let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const d = await crypto.subtle.digest('SHA-256', concat(parts) as unknown as ArrayBuffer)
  return new Uint8Array(d)
}
function u128le(v: bigint): Uint8Array {
  const b = new Uint8Array(16); let x = v
  for (let i = 0; i < 16; i++) { b[i] = Number(x & 0xffn); x >>= 8n }
  return b
}
const cmp = (a: Uint8Array, b: Uint8Array): number => {
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1 }
  return 0
}
async function pairHash(l: Uint8Array, r: Uint8Array): Promise<Uint8Array> {
  return cmp(l, r) <= 0 ? sha256(l, r) : sha256(r, l)
}
async function leafFor(e: RoundFileEntry): Promise<Uint8Array> {
  return sha256(new PublicKey(e.wallet).toBuffer(), new PublicKey(e.outMint).toBuffer(), u128le(BigInt(e.weight)))
}
const toHex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('')

/** Recompute the root from the file and compare to the on-chain root (hex). */
export async function verifyRoundFile(file: RoundFile, onChainRootHex: string): Promise<{ ok: boolean; computedRootHex: string }> {
  if (file.entries.length === 0) { const z = '00'.repeat(32); return { ok: onChainRootHex === z, computedRootHex: z } }
  let level = await Promise.all(file.entries.map(leafFor))
  while (level.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < level.length; i += 2) next.push(await pairHash(level[i], i + 1 < level.length ? level[i + 1] : level[i]))
    level = next
  }
  const computedRootHex = toHex(level[0])
  return { ok: computedRootHex === onChainRootHex.toLowerCase(), computedRootHex }
}

export function findEntry(file: RoundFile, wallet: string): RoundFileEntry | undefined {
  return file.entries.find((e) => e.wallet === wallet)
}
