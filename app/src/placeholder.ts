import { h } from './ui'
import { placeholderSvg, monogram } from './placeholder-art'

/**
 * DOM wrappers around the pure art generator (placeholder-art.ts). The art is
 * deterministic per mint, so a grid of coins never looks like one coin repeated —
 * and it deliberately does NOT echo the H2E mark: a coin we know nothing about
 * must not wear our logo. Used only when the coin has no image in its metadata.
 */
export { placeholderSvg, monogram }

/** Full-bleed art for .thumb / .pimg (both are position:relative). */
export function artTile(mint: string, ticker?: string | null): HTMLElement {
  return h('div', { class: 'art', 'aria-hidden': 'true', style: 'position:absolute;inset:0', html: placeholderSvg(mint, ticker) })
}

/** Re-draw in place once the ticker arrives (metadata lands after first paint). */
export function setArtTicker(el: HTMLElement | null, mint: string, ticker: string | null) {
  if (el) el.innerHTML = placeholderSvg(mint, ticker)
}

/** Standalone tile for the coin-detail avatar. */
export function artAvatar(mint: string, ticker?: string | null): HTMLElement {
  return h('div', { class: 'art', 'aria-hidden': 'true', style: 'position:absolute;inset:0', html: placeholderSvg(mint, ticker) })
}
