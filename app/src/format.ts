/**
 * Display formatting for money. Compact notation only ($1.2K / $14.2K / $1.5M) —
 * never raw lamports, never full decimals. Every figure rendered through here is
 * meant to sit in the monospace face with tabular-nums (.fig in styles.css).
 */

/** Compact USD: $0 / $239 / $1.2K / $14.2K / $1.5M / $2.3B. */
export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const neg = n < 0
  const v = Math.abs(n)
  let s: string
  if (v >= 1e9) s = trim(v / 1e9) + 'B'
  else if (v >= 1e6) s = trim(v / 1e6) + 'M'
  else if (v >= 1e3) s = trim(v / 1e3) + 'K'
  else s = String(Math.round(v))
  return (neg ? '-$' : '$') + s
}

/** One decimal, but no trailing .0 — 1.2 / 14.2 / 1.5 / 2 */
function trim(v: number): string {
  const s = v.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

/** Compact SOL, for when no USD price is available. */
export function sol(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n >= 1e3) return trim(n / 1e3) + 'K SOL'
  if (n >= 1) return n.toFixed(2) + ' SOL'
  return n.toFixed(4) + ' SOL'
}

/** Short relative age: 12m / 3h / 4d. */
export function age(ts: number): string {
  const s = Math.floor(Date.now() / 1000) - ts
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
