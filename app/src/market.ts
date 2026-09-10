import { PublicKey } from '@solana/web3.js'
import { conn } from './rpc'
import { DynamicBondingCurveClient, getPriceFromSqrtPrice } from '@meteora-ag/dynamic-bonding-curve-sdk'

/**
 * Market figures for a coin, read from the DBC virtual pool it launched on.
 *
 * WHAT IS REAL HERE. Market cap is a real read: curve price (from the pool's
 * sqrtPrice) × mint supply, quoted through the SOL/USD price.
 *
 * WHAT IS NOT AVAILABLE. 24h volume cannot come from the pool. The DBC virtual
 * pool account carries no volume field at all — its only cumulative trade figures
 * are `poolMetrics.total{Trading,Protocol}{Base,Quote}Fee`, which are all-time,
 * not a 24h window. Deriving "24h volume" from them would be inventing a number,
 * so `vol24hUsd` stays null and the card renders "—" until the indexer (Task 2.1),
 * which streams trades with timestamps, can supply a real windowed figure.
 */
export interface Market {
  mcapUsd: number | null
  mcapSol: number | null
  vol24hUsd: number | null
  priceSol: number | null
}
const NONE: Market = { mcapUsd: null, mcapSol: null, vol24hUsd: null, priceSol: null }

const SOL_MINT = 'So11111111111111111111111111111111111111112'
const cache = new Map<string, Market>()
const inflight = new Map<string, Promise<Market>>()

/** Cached per mint. Never throws — an unreadable pool resolves to all-nulls, which
 *  the card renders as "—" (never 0: a zero reads as a dead coin). */
export function loadMarket(mint: PublicKey, dbcPool: PublicKey): Promise<Market> {
  const k = mint.toBase58()
  const hit = cache.get(k)
  if (hit) return Promise.resolve(hit)
  const running = inflight.get(k)
  if (running) return running
  const p = read(mint, dbcPool).catch(() => NONE).then((m) => { cache.set(k, m); inflight.delete(k); return m })
  inflight.set(k, p)
  return p
}

async function read(mint: PublicKey, dbcPool: PublicKey): Promise<Market> {
  const c = conn()
  const dbc = DynamicBondingCurveClient.create(c, 'confirmed')
  const [pool, supply, solUsd] = await Promise.all([
    dbc.state.getPool(dbcPool).catch(() => null),
    c.getTokenSupply(mint).then((r) => r.value).catch(() => null),
    solPriceUsd(),
  ])
  if (!pool || !supply) return NONE
  const baseDec = supply.decimals
  // price is quote (SOL) per whole base token
  const priceSol = Number(getPriceFromSqrtPrice((pool as any).sqrtPrice, baseDec as any, 9 as any).toString())
  if (!Number.isFinite(priceSol)) return NONE
  const supplyTokens = Number(supply.amount) / 10 ** baseDec
  const mcapSol = priceSol * supplyTokens
  return {
    priceSol,
    mcapSol,
    mcapUsd: solUsd == null ? null : mcapSol * solUsd,
    vol24hUsd: null, // see the note above — the pool carries no 24h window
  }
}

// ---- SOL/USD, cached for 5 minutes ----
let priceCache: { v: number | null; at: number } | null = null

/** Jupiter lite-api (quote-api is dead). Null when there is no egress — callers
 *  then show the SOL-denominated figure rather than a fabricated dollar value. */
export async function solPriceUsd(): Promise<number | null> {
  if (priceCache && Date.now() - priceCache.at < 300_000) return priceCache.v
  let v: number | null = null
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`, { signal: AbortSignal.timeout(5000) })
    if (r.ok) {
      const j = await r.json()
      const p = j?.[SOL_MINT]?.usdPrice
      if (typeof p === 'number' && Number.isFinite(p) && p > 0) v = p
    }
  } catch { /* offline — USD figures degrade to SOL */ }
  priceCache = { v, at: Date.now() }
  return v
}

/** Lamports of SOL → USD, or null if there is no price. */
export function lamportsToUsd(lamports: bigint | number | string, solUsd: number | null): number | null {
  if (solUsd == null) return null
  return (Number(lamports) / 1e9) * solUsd
}
