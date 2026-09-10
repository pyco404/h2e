import { PublicKey } from '@solana/web3.js'
import { setPlatformAllowlistIx } from '../../h2e/client'

/**
 * Electable-list builder (spec §7.3). Applies the filters in the exact required
 * order — the order is load-bearing, so the *reason* a mint is rejected is the
 * first gate it fails. Output is a PROPOSAL, never a transaction:
 * `set_platform_allowlist` is admin-gated, so this produces a reviewable diff plus
 * ready-to-sign admin instructions. Nothing here mutates the on-chain allowlist.
 */

export interface MintInfo { hasFreezeAuthority: boolean; isToken2022: boolean }
/** A Jupiter route quote at a representative payout size. */
export interface RouteQuote { quotable: boolean; accounts: number; priceImpactBps: number }

/** Pluggable data source — real impl reads the mint account (freeze authority,
 *  owner program) and Jupiter (volume, route). Tests inject synthetic data. */
export interface AssetSource {
  mintInfo(mint: string): MintInfo
  volume24hUsd(mint: string): number
  routeQuote(mint: string, payoutSizeUsd: number): RouteQuote
}

export interface ElectableConfig {
  minVolume24hUsd: number
  representativePayoutUsd: number   // e.g. $300 — the point of the depth check
  maxPriceImpactBps: number         // standard assets
  stockMaxPriceImpactBps: number    // wider tolerance for the pinned stock section
  maxRouteAccounts: number          // the maxAccounts cap (~40)
  denylist: Set<string>
  stockMints: Set<string>           // §7.3 pinned tokenised-stock section
}

export type Category = 'standard' | 'stock'
export interface Verdict { mint: string; electable: boolean; category: Category; reason: string }

/** Evaluate one mint. Filters in §7.3 order; the reason is the first failing gate. */
export function evaluate(mint: string, src: AssetSource, cfg: ElectableConfig): Verdict {
  const category: Category = cfg.stockMints.has(mint) ? 'stock' : 'standard'
  const info = src.mintInfo(mint)

  // 1. live freeze authority — it can lock the ATAs H2E just paid into. First.
  if (info.hasFreezeAuthority) return { mint, electable: false, category, reason: 'live freeze authority' }
  // 2. classic SPL only for v1
  if (info.isToken2022) return { mint, electable: false, category, reason: 'Token-2022 (v1 is classic SPL only)' }
  // 3. Jupiter 24h volume AND route depth at a representative payout size
  if (src.volume24hUsd(mint) < cfg.minVolume24hUsd) return { mint, electable: false, category, reason: 'below 24h volume floor' }
  const q = src.routeQuote(mint, cfg.representativePayoutUsd)
  if (!q.quotable) return { mint, electable: false, category, reason: 'no route at representative payout size' }
  const impactCap = category === 'stock' ? cfg.stockMaxPriceImpactBps : cfg.maxPriceImpactBps
  if (q.priceImpactBps > impactCap) return { mint, electable: false, category, reason: `price impact ${q.priceImpactBps}bps over ${impactCap}bps cap` }
  // 4. must quote under the maxAccounts cap, or it cannot fit swap_payout
  if (q.accounts > cfg.maxRouteAccounts) return { mint, electable: false, category, reason: `route needs ${q.accounts} accounts, over the ${cfg.maxRouteAccounts} cap` }
  // 5. manual denylist override (honeypots, transfer-tax) — reasoning published
  if (cfg.denylist.has(mint)) return { mint, electable: false, category, reason: 'manual denylist override' }
  // 6. stock section already handled via the wider impact cap above
  return { mint, electable: true, category, reason: category === 'stock' ? 'electable (stock section, wider slippage)' : 'electable' }
}

export interface AllowlistProposal {
  add: string[]
  remove: string[]
  verdicts: Verdict[]
  /** Ready-to-sign admin instructions — the admin reviews the diff and signs. */
  instructions: import('@solana/web3.js').TransactionInstruction[]
  summary: string
}

/**
 * Build the proposal: evaluate candidates, diff against the current on-chain
 * allowlist, and emit the add/remove set plus the exact admin instructions.
 * USDC is always kept (the mandatory default) if provided.
 */
export function buildProposal(candidates: string[], current: Set<string>, src: AssetSource, cfg: ElectableConfig, admin: PublicKey, opts: { usdcMint?: string } = {}): AllowlistProposal {
  const verdicts = candidates.map((m) => evaluate(m, src, cfg))
  const electable = new Set(verdicts.filter((v) => v.electable).map((v) => v.mint))
  if (opts.usdcMint) electable.add(opts.usdcMint) // never drop the default payout asset

  const add = [...electable].filter((m) => !current.has(m)).sort()
  const remove = [...current].filter((m) => !electable.has(m) && m !== opts.usdcMint).sort()

  const instructions = [
    ...add.map((m) => setPlatformAllowlistIx(new PublicKey(m), true, admin)),
    ...remove.map((m) => setPlatformAllowlistIx(new PublicKey(m), false, admin)),
  ]
  const lines = [
    `Allowlist proposal — ${add.length} to add, ${remove.length} to remove.`,
    ...add.map((m) => `  + ${m}`),
    ...remove.map((m) => `  - ${m}  (${verdicts.find((v) => v.mint === m)?.reason ?? 'no longer electable'})`),
    ...verdicts.filter((v) => !v.electable).map((v) => `  · rejected ${v.mint}: ${v.reason}`),
  ]
  return { add, remove, verdicts, instructions, summary: lines.join('\n') }
}
