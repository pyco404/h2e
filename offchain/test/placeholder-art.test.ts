import { strict as assert } from 'assert'
import { createHash, randomBytes } from 'crypto'
import { PublicKey } from '@solana/web3.js'
import {
  placeholderSvg, archetypeOf, hueOf, monogram, sha256, ARCHETYPES,
} from '../../app/src/placeholder-art'

/**
 * The card placeholder art (app/src/placeholder-art.ts). It is a pure function so
 * it can be tested here, in Node, with no DOM — the same reason it is safe to
 * call during render.
 */
describe('placeholder art', () => {
  const mints = Array.from({ length: 100 }, () => new PublicKey(randomBytes(32)).toBase58())

  it('sha256 matches the standard vector and Node crypto', () => {
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
    assert.equal(hex(sha256(Buffer.from('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    assert.equal(hex(sha256(Buffer.from(''))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    for (const m of mints.slice(0, 20)) {
      assert.equal(hex(sha256(Buffer.from(m, 'utf8'))), createHash('sha256').update(m, 'utf8').digest('hex'))
    }
  })

  it('is deterministic — the same mint yields byte-identical output', () => {
    for (const m of mints) {
      const a = placeholderSvg(m, 'ABC')
      const b = placeholderSvg(m, 'ABC')
      assert.equal(a, b)
      assert.equal(Buffer.compare(Buffer.from(a), Buffer.from(b)), 0)
    }
    // stable across a fresh call ordering too (no hidden global state)
    const shuffled = [...mints].reverse().map((m) => placeholderSvg(m, 'ABC'))
    const inOrder = mints.map((m) => placeholderSvg(m, 'ABC'))
    assert.deepEqual(shuffled, [...inOrder].reverse())
  })

  it('100 mints produce at least 4 distinct archetypes', () => {
    const seen = new Set(mints.map(archetypeOf))
    assert.ok(seen.size >= 4, `only ${seen.size} archetypes over 100 mints: ${[...seen]}`)
    for (const a of seen) assert.ok((ARCHETYPES as readonly string[]).includes(a))
  })

  it('100 mints produce visibly different hues', () => {
    const hues = mints.map(hueOf)
    // 100 samples over 361 possible hues collide by the birthday paradox — the
    // expected number of distinct values is ~87, so anything near that is correct.
    // "Visibly different" is really about SPREAD, which the two checks below test.
    assert.ok(new Set(hues).size >= 80, `only ${new Set(hues).size} distinct hues`)
    const buckets = new Set(hues.map((h) => Math.floor(h / 45)))   // 8 × 45° sectors
    assert.ok(buckets.size >= 6, `hues clustered into ${buckets.size}/8 sectors`)
    // and neighbouring mints are not near-identical in hue
    let close = 0
    for (let i = 1; i < hues.length; i++) if (Math.abs(hues[i] - hues[i - 1]) < 10) close++
    assert.ok(close < 15, `${close}/99 consecutive pairs within 10° of each other`)
  })

  it('renders every archetype as valid, self-contained SVG', () => {
    const byArch = new Map<string, string>()
    for (const m of mints) if (!byArch.has(archetypeOf(m))) byArch.set(archetypeOf(m), placeholderSvg(m, 'ZZ'))
    for (const [arch, svg] of byArch) {
      assert.ok(svg.startsWith('<svg viewBox="0 0 200 200"'), arch)
      assert.ok(svg.endsWith('</svg>'), arch)
      assert.ok(svg.includes('fill="#1D1B19"'), `${arch} must paint the card background`)
      assert.ok(!svg.includes('NaN') && !svg.includes('undefined'), `${arch} emitted NaN/undefined`)
      assert.equal((svg.match(/<svg/g) || []).length, 1)
      // balanced tags
      assert.equal((svg.match(/<g/g) || []).length, (svg.match(/<\/g>/g) || []).length, arch)
    }
    assert.ok(byArch.size >= 4)
  })

  it('overlays the ticker, falling back to the mint', () => {
    const m = mints[0]
    assert.ok(placeholderSvg(m, 'CORREY').includes('>CO</text>'))
    assert.ok(placeholderSvg(m, '$nvh').includes('>NV</text>'))
    assert.ok(placeholderSvg(m, null).includes(`>${m.slice(0, 2).toUpperCase()}</text>`))
    assert.ok(placeholderSvg(m, '').includes(`>${m.slice(0, 2).toUpperCase()}</text>`))
    assert.equal(monogram('  ab ', m), 'AB')
  })

  it('escapes a hostile ticker rather than injecting markup', () => {
    const svg = placeholderSvg(mints[0], '<script>alert(1)</script>')
    assert.ok(!svg.includes('<script'))
    assert.ok(svg.includes('&lt;'))
  })

  it('different mints produce different art', () => {
    const svgs = new Set(mints.map((m) => placeholderSvg(m, 'AA')))
    assert.equal(svgs.size, mints.length, 'two mints collided on identical art')
  })
})
