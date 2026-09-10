import { PublicKey } from '@solana/web3.js'
import { short } from './ui'

/**
 * Front-end asset catalog (§7.5b). DESCRIPTIVE ONLY — which mints are permitted is
 * on-chain (PlatformAllowlist). The picker shows only mints that are actually in
 * the on-chain allowlist; this catalog just supplies their name, issuer, category
 * and brand colour. Ships a small known set (the deployment's initial allowlist +
 * common assets) and merges a configurable catalog JSON (?catalog=<url>).
 */
export type AssetCategory = 'stable' | 'crypto' | 'stock'
export interface AssetInfo { mint: string; name: string; symbol: string; issuer: string; category: AssetCategory; color: string }

// Keyed by mint. Colours/issuers are display metadata, not on-chain truth.
const KNOWN: Record<string, AssetInfo> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', name: 'USD Coin', symbol: 'USDC', issuer: 'Circle', category: 'stable', color: '#2775CA' },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', name: 'Tether', symbol: 'USDT', issuer: 'Tether', category: 'stable', color: '#26A17B' },
  So11111111111111111111111111111111111111112: { mint: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL', issuer: 'Solana', category: 'crypto', color: '#9945FF' },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', name: 'Jito Staked SOL', symbol: 'jitoSOL', issuer: 'Jito', category: 'crypto', color: '#2E7D5B' },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', name: 'Jupiter', symbol: 'JUP', issuer: 'Jupiter', category: 'crypto', color: '#4E9E86' },
  Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh: { mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', name: 'NVIDIA', symbol: 'NVDAx', issuer: 'xStocks', category: 'stock', color: '#76B900' },
  XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp: { mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', name: 'Apple', symbol: 'AAPLx', issuer: 'xStocks', category: 'stock', color: '#4A4A4A' },
}
const fetched = new Map<string, AssetInfo>()

export async function loadCatalog(): Promise<void> {
  const url = new URLSearchParams(location.search).get('catalog') || (() => { try { return localStorage.getItem('h2e.catalog') } catch { return null } })()
  if (!url) return
  try { localStorage.setItem('h2e.catalog', url) } catch {}
  try {
    const arr = (await (await fetch(url)).json()) as AssetInfo[]
    for (const a of arr) if (a?.mint) fetched.set(a.mint, a)
  } catch { /* optional; uncatalogued mints render by address */ }
}

export function assetInfo(mint: string | PublicKey): AssetInfo | null {
  const k = typeof mint === 'string' ? mint : mint.toBase58()
  return KNOWN[k] || fetched.get(k) || null
}
/** Symbol if catalogued, else a short address. Never full raw base58 in front of users. */
export function assetLabel(mint: string | PublicKey): string {
  const k = typeof mint === 'string' ? mint : mint.toBase58()
  return assetInfo(k)?.symbol || short(k, 4)
}
export function marketHoursWarning(mint: string | PublicKey): boolean {
  return assetInfo(mint)?.category === 'stock'
}
/** A deterministic brand colour: catalogued colour, else derived from the pubkey
 *  so uncatalogued mints still get a stable glyph (never invented identity). */
export function assetColor(mint: string | PublicKey): string {
  const info = assetInfo(mint)
  if (info) return info.color
  const k = typeof mint === 'string' ? mint : mint.toBase58()
  let h = 0; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 42% 46%)`
}
export function assetCategory(mint: string | PublicKey): AssetCategory | 'other' {
  return assetInfo(mint)?.category || 'other'
}
export function assetGlyph(mint: string | PublicKey): string {
  const info = assetInfo(mint)
  const s = info ? info.symbol : (typeof mint === 'string' ? mint : mint.toBase58())
  return s.slice(0, 2).toUpperCase()
}
