/**
 * Deterministic placeholder art — one image per mint.
 *
 * PURE. No DOM, no imports: `placeholderSvg(mint, ticker)` returns an SVG string,
 * and the same mint always returns byte-identical output. That is what makes it
 * unit-testable in Node (test/placeholder-art.test.ts) and safe to call during
 * render. Used ONLY when a coin has no image in its metadata — a real uploaded
 * image always wins.
 *
 *   hash  = sha256(mint address)
 *   hue   = bytes[0..1] → 0–360
 *   shape = bytes[2] % 5  → archetype
 *   seed  = bytes[3..7]   → per-pattern variation
 */

export const ART_BG = '#1D1B19'
const INK = '#E8E3DA'
export const ARCHETYPES = ['arcs', 'bars', 'dots', 'bands', 'squares'] as const
export type Archetype = (typeof ARCHETYPES)[number]

export function placeholderSvg(mint: string, ticker?: string | null): string {
  const hb = sha256(utf8(mint))
  const hue = Math.round((((hb[0] << 8) | hb[1]) / 65535) * 360)
  const shape = hb[2] % 5
  const rand = xorshift(((hb[3] << 24) | (hb[4] << 16) | (hb[5] << 8) | hb[6]) ^ (hb[7] << 3))

  // two tones off one hue — background texture, not a logo, so both stay muted
  const fill = `hsl(${hue} 38% 42%)`
  const accent = `hsl(${hue} 55% 62%)`

  const body = [arcs, bars, dots, bands, squares][shape](rand, fill, accent)
  const mono = monogram(ticker, mint)

  return `<svg viewBox="0 0 200 200" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`
    + `<rect width="200" height="200" fill="${ART_BG}"/>`
    + body
    + `<text x="100" y="100" text-anchor="middle" dominant-baseline="central" fill="${INK}"`
    + ` font-family="Archivo,system-ui,sans-serif" font-size="28" font-weight="700" letter-spacing="0.5">${esc(mono)}</text>`
    + `</svg>`
}

/** Which archetype a mint maps to — exported for tests and debugging. */
export function archetypeOf(mint: string): Archetype { return ARCHETYPES[sha256(utf8(mint))[2] % 5] }
/** The hue a mint maps to, 0–360 — exported for tests. */
export function hueOf(mint: string): number {
  const hb = sha256(utf8(mint))
  return Math.round((((hb[0] << 8) | hb[1]) / 65535) * 360)
}

/** Ticker's first two characters, else the mint's first two. Always 2 chars. */
export function monogram(ticker: string | null | undefined, mint: string): string {
  const src = (ticker || '').replace(/^\$/, '').trim() || mint
  return src.slice(0, 2).toUpperCase()
}

// ---------------------------------------------------------------- archetypes
// Every archetype draws into a 200×200 box and keeps its ink low-contrast, so
// the centred monogram stays the most legible thing on the tile.

/** 0 — 3–6 arcs, varying radius and stroke width, off-centre. */
function arcs(r: () => number, fill: string, accent: string): string {
  const n = 3 + Math.floor(r() * 4)
  const cx = 55 + r() * 90
  const cy = 55 + r() * 90
  let out = ''
  for (let i = 0; i < n; i++) {
    const rad = 26 + i * (14 + r() * 10)
    const sw = 2 + r() * 6
    const a0 = r() * Math.PI * 2
    const sweep = (100 + r() * 170) * (Math.PI / 180)
    const x0 = cx + rad * Math.cos(a0), y0 = cy + rad * Math.sin(a0)
    const x1 = cx + rad * Math.cos(a0 + sweep), y1 = cy + rad * Math.sin(a0 + sweep)
    const large = sweep > Math.PI ? 1 : 0
    out += `<path d="M${f(x0)} ${f(y0)} A${f(rad)} ${f(rad)} 0 ${large} 1 ${f(x1)} ${f(y1)}"`
      + ` fill="none" stroke="${i % 2 ? accent : fill}" stroke-width="${f(sw)}" stroke-linecap="round" opacity="${f(0.35 + r() * 0.3)}"/>`
  }
  return out
}

/** 1 — 5–9 left-aligned horizontal bars of varying width. */
function bars(r: () => number, fill: string, accent: string): string {
  const n = 5 + Math.floor(r() * 5)
  const gap = 200 / n
  let out = ''
  for (let i = 0; i < n; i++) {
    const hgt = gap * (0.35 + r() * 0.4)
    const w = 40 + r() * 145
    const y = i * gap + (gap - hgt) / 2
    out += `<rect x="0" y="${f(y)}" width="${f(w)}" height="${f(hgt)}" fill="${i % 3 === 0 ? accent : fill}" opacity="${f(0.3 + r() * 0.35)}"/>`
  }
  return out
}

/** 2 — 8×8 grid, ~40% of dots present, chosen from the seeded stream. */
function dots(r: () => number, fill: string, accent: string): string {
  const step = 200 / 8
  let out = ''
  for (let gy = 0; gy < 8; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      if (r() > 0.4) continue
      const cx = gx * step + step / 2
      const cy = gy * step + step / 2
      out += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(3 + r() * 4)}" fill="${(gx + gy) % 4 === 0 ? accent : fill}" opacity="${f(0.35 + r() * 0.3)}"/>`
    }
  }
  return out
}

/** 3 — 4–7 diagonal bands at 30–60°, varying thickness. */
function bands(r: () => number, fill: string, accent: string): string {
  const n = 4 + Math.floor(r() * 4)
  const angle = 30 + r() * 30
  const span = 360 / n
  let out = `<g transform="rotate(${f(angle)} 100 100)">`
  for (let i = 0; i < n; i++) {
    const w = span * (0.25 + r() * 0.45)
    const x = -80 + i * span + r() * 10
    out += `<rect x="${f(x)}" y="-80" width="${f(w)}" height="360" fill="${i % 2 ? accent : fill}" opacity="${f(0.28 + r() * 0.3)}"/>`
  }
  return out + `</g>`
}

/** 4 — 3–5 rotated squares, decreasing in size. */
function squares(r: () => number, fill: string, accent: string): string {
  const n = 3 + Math.floor(r() * 3)
  let out = ''
  for (let i = 0; i < n; i++) {
    const size = 170 - i * (28 + r() * 14)
    if (size <= 8) break
    const rot = r() * 90
    const off = (200 - size) / 2 + (r() - 0.5) * 18
    out += `<rect x="${f(off)}" y="${f(off)}" width="${f(size)}" height="${f(size)}" rx="${f(2 + r() * 6)}"`
      + ` transform="rotate(${f(rot)} 100 100)" fill="none" stroke="${i % 2 ? accent : fill}"`
      + ` stroke-width="${f(2 + r() * 5)}" opacity="${f(0.32 + r() * 0.3)}"/>`
  }
  return out
}

// ------------------------------------------------------------------ helpers
/** Fixed 2dp — keeps output byte-identical across engines (no float drift in text). */
const f = (n: number) => n.toFixed(2)
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

/** xorshift32 — deterministic, seeded from the hash. */
function xorshift(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

const utf8 = (s: string): Uint8Array => {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return Uint8Array.from(out)
}

// --------------------------------------------------------- sha256 (sync)
// Web Crypto's digest is async; this must be callable during render, so a small
// synchronous SHA-256 lives here. Verified against the standard "abc" vector.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])
const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0

export function sha256(msg: Uint8Array): Uint8Array {
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const l = msg.length
  const total = l + 1 + (((56 - ((l + 1) % 64)) + 64) % 64) + 8
  const buf = new Uint8Array(total)
  buf.set(msg)
  buf[l] = 0x80
  const dv = new DataView(buf.buffer)
  dv.setUint32(total - 8, Math.floor((l * 8) / 4294967296))
  dv.setUint32(total - 4, (l * 8) >>> 0)
  const w = new Uint32Array(64)
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const a1 = w[i - 15], b1 = w[i - 2]
      const s0 = rotr(a1, 7) ^ rotr(a1, 18) ^ (a1 >>> 3)
      const s1 = rotr(b1, 17) ^ rotr(b1, 19) ^ (b1 >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], g0 = H[5], g1 = H[6], g2 = H[7]
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & g0) ^ (~e & g1)
      const t1 = (g2 + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      g2 = g1; g1 = g0; g0 = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + g0) >>> 0; H[6] = (H[6] + g1) >>> 0; H[7] = (H[7] + g2) >>> 0
  }
  const out = new Uint8Array(32)
  new DataView(out.buffer).setUint32(0, H[0]); new DataView(out.buffer).setUint32(4, H[1])
  new DataView(out.buffer).setUint32(8, H[2]); new DataView(out.buffer).setUint32(12, H[3])
  new DataView(out.buffer).setUint32(16, H[4]); new DataView(out.buffer).setUint32(20, H[5])
  new DataView(out.buffer).setUint32(24, H[6]); new DataView(out.buffer).setUint32(28, H[7])
  return out
}
