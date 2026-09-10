import { PublicKey } from '@solana/web3.js'
import { conn } from './rpc'
import { deriveMintMetadata } from '@meteora-ag/dynamic-bonding-curve-sdk'

/**
 * Coin identity: name, ticker and image.
 *
 * NOTE ON SOURCE. `CoinConfig` has no `uri` field — the launch metadata URI lives
 * in the token's Metaplex metadata account (that is where `launch_coin` writes
 * name/symbol/uri). So the path is: metadata account → `uri` → fetch that JSON →
 * `.name` / `.symbol` / `.image`. The on-chain name/symbol are used when the JSON
 * is unreachable, and a coin with neither falls back to a truncated mint with NO
 * ticker row — the mint is never printed twice.
 */
export interface CoinMeta { name: string | null; symbol: string | null; image: string | null }

const cache = new Map<string, CoinMeta>()
const inflight = new Map<string, Promise<CoinMeta>>()
const EMPTY: CoinMeta = { name: null, symbol: null, image: null }

/** Cached by mint. Never throws — an unreadable coin resolves to all-nulls. */
export function loadCoinMeta(mint: PublicKey): Promise<CoinMeta> {
  const k = mint.toBase58()
  const hit = cache.get(k)
  if (hit) return Promise.resolve(hit)
  const running = inflight.get(k)
  if (running) return running
  const p = fetchMeta(mint).catch(() => EMPTY).then((m) => { cache.set(k, m); inflight.delete(k); return m })
  inflight.set(k, p)
  return p
}

/** Synchronous peek — for re-renders that must not re-fetch. */
export function cachedMeta(mint: PublicKey): CoinMeta | null { return cache.get(mint.toBase58()) || null }

async function fetchMeta(mint: PublicKey): Promise<CoinMeta> {
  const onchain = await readMetadataAccount(mint)
  if (!onchain) return EMPTY
  let json: any = null
  if (onchain.uri) {
    try {
      const r = await fetch(onchain.uri, { signal: AbortSignal.timeout(6000) })
      if (r.ok) json = await r.json()
    } catch { /* offline, CORS, 404 — fall back to the on-chain fields */ }
  }
  return {
    name: str(json?.name) || onchain.name || null,
    symbol: str(json?.symbol) || onchain.symbol || null,
    image: str(json?.image) || null,
  }
}

const str = (v: any) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Metaplex Metadata: key(1) + update_authority(32) + mint(32), then three
 *  borsh strings — name, symbol, uri — each u32 length-prefixed. */
async function readMetadataAccount(mint: PublicKey): Promise<{ name: string; symbol: string; uri: string } | null> {
  const info = await conn().getAccountInfo(deriveMintMetadata(mint))
  if (!info) return null
  const d = info.data as Buffer
  let o = 1 + 32 + 32
  const readStr = () => {
    if (o + 4 > d.length) return ''
    const len = d.readUInt32LE(o); o += 4
    if (len > 512 || o + len > d.length) return ''
    const s = d.slice(o, o + len).toString('utf8').replace(/\0+$/, '').trim(); o += len
    return s
  }
  return { name: readStr(), symbol: readStr(), uri: readStr() }
}
