import { h } from './ui'

/**
 * On-brand placeholder for coins/previews with no image — a muted lightning mark
 * echoing the H2E logo, on a dark tile. Subtly hue-shifted per `seed` (the mint or
 * ticker) so different coins read as different without inventing any identity.
 */
export function placeholderSvg(seed = ''): string {
  let hv = 2166136261
  for (let i = 0; i < seed.length; i++) { hv ^= seed.charCodeAt(i); hv = Math.imul(hv, 16777619) }
  const hue = 96 + (Math.abs(hv) % 84)          // 96–180: green → teal, around the mint
  const bolt = `hsl(${hue} 30% 46%)`
  const glow = `hsl(${hue} 40% 60%)`
  return `<svg viewBox="0 0 200 200" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="200" height="200" fill="#1A1917"/>
  <g opacity="0.10" fill="none" stroke="${glow}" stroke-width="1">
    <circle cx="100" cy="100" r="78"/><circle cx="100" cy="100" r="54"/>
  </g>
  <path d="M114 32 L68 112 L96 112 L84 168 L138 88 L108 88 Z" fill="${bolt}" opacity="0.6"/>
  <path d="M114 32 L68 112 L96 112 L84 168 L138 88 L108 88 Z" fill="none" stroke="${glow}" stroke-width="1.5" opacity="0.35"/>
</svg>`
}

/** A full-bleed placeholder element to drop behind badges in .thumb / .pimg. */
export function placeholderFill(seed = ''): HTMLElement {
  return h('div', { style: 'position:absolute;inset:0', html: placeholderSvg(seed) })
}

/** A standalone placeholder tile (e.g. the coin detail avatar). */
export function placeholderTile(seed = ''): HTMLElement {
  return h('div', { style: 'width:100%;height:100%', html: placeholderSvg(seed) })
}
