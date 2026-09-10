/**
 * Task 2.2 Part A — electable list (ordering + proposal), asset catalog (on-chain
 * is the authority), and the metadata pipeline.
 */
import { assert } from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { Keypair, PublicKey } from '@solana/web3.js'
import { evaluate, buildProposal, AssetSource, ElectableConfig } from '../src/electable-list'
import { AssetCatalog, LocalMetadataHost } from '../src/asset-catalog'

const mk = () => Keypair.generate().publicKey.toBase58()
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

// synthetic source: per-mint overrides, healthy defaults
function source(over: Record<string, any> = {}): AssetSource {
  const d = (m: string) => over[m] || {}
  return {
    mintInfo: (m) => ({ hasFreezeAuthority: false, isToken2022: false, ...(d(m).mintInfo || {}) }),
    volume24hUsd: (m) => (d(m).volume ?? 1_000_000),
    routeQuote: (m) => ({ quotable: true, accounts: 20, priceImpactBps: 50, ...(d(m).route || {}) }),
  }
}
const cfg = (over: Partial<ElectableConfig> = {}): ElectableConfig => ({
  minVolume24hUsd: 100_000, representativePayoutUsd: 300, maxPriceImpactBps: 200,
  stockMaxPriceImpactBps: 800, maxRouteAccounts: 40, denylist: new Set(), stockMints: new Set(), ...over,
})

describe('electable list (§7.3)', () => {
  it('applies filters in order — reason is the first gate failed', () => {
    const m = mk()
    // freeze authority AND low volume → the FREEZE reason wins (runs first)
    let v = evaluate(m, source({ [m]: { mintInfo: { hasFreezeAuthority: true }, volume: 0 } }), cfg())
    assert.isFalse(v.electable); assert.match(v.reason, /freeze/)

    v = evaluate(m, source({ [m]: { mintInfo: { isToken2022: true } } }), cfg())
    assert.match(v.reason, /Token-2022/)

    v = evaluate(m, source({ [m]: { volume: 500 } }), cfg())
    assert.match(v.reason, /volume floor/)

    v = evaluate(m, source({ [m]: { route: { priceImpactBps: 500 } } }), cfg())
    assert.match(v.reason, /price impact/)

    v = evaluate(m, source({ [m]: { route: { accounts: 60 } } }), cfg())
    assert.match(v.reason, /over the 40 cap/)

    v = evaluate(m, source(), cfg({ denylist: new Set([m]) }))
    assert.match(v.reason, /denylist/)

    v = evaluate(m, source(), cfg())
    assert.isTrue(v.electable)
  })

  it('stock section gets wider slippage tolerance', () => {
    const stock = mk()
    const impact = { route: { priceImpactBps: 500 } } // over standard 200, under stock 800
    assert.isFalse(evaluate(stock, source({ [stock]: impact }), cfg()).electable, 'fails as standard')
    const v = evaluate(stock, source({ [stock]: impact }), cfg({ stockMints: new Set([stock]) }))
    assert.isTrue(v.electable); assert.equal(v.category, 'stock')
  })

  it('buildProposal diffs against the on-chain allowlist and emits admin instructions (a proposal, not a tx)', () => {
    const admin = Keypair.generate().publicKey
    const good = mk(), bad = mk(), staying = mk()
    const src = source({ [bad]: { volume: 0 } })
    const current = new Set([staying, bad, USDC]) // bad is currently on, should be removed; staying stays
    const p = buildProposal([good, bad, staying], current, src, cfg(), admin, { usdcMint: USDC })
    assert.include(p.add, good, 'newly electable added')
    assert.include(p.remove, bad, 'no-longer-electable removed')
    assert.notInclude(p.remove, USDC, 'USDC (default) never removed')
    assert.equal(p.instructions.length, p.add.length + p.remove.length, 'one admin ix per change')
    assert.match(p.summary, /Allowlist proposal/)
  })
})

describe('asset catalog (§7.5b) — on-chain is the authority', () => {
  it('annotates the allowlist; ignores catalog entries not on-chain; flags missing', () => {
    const onA = mk(), onB = mk(), offChain = mk()
    const cat = new AssetCatalog()
    cat.put({ mint: onA, name: 'Nvidia', symbol: 'NVDAx', logoUri: 'x', category: 'stock' })
    cat.put({ mint: offChain, name: 'Ghost', symbol: 'GHOST', logoUri: 'x', category: 'standard' }) // NOT allowlisted
    const allowlist = new Set([onA, onB]) // onB has no catalog entry
    const { entries, missing } = cat.forAllowlist(allowlist)
    assert.equal(entries.length, 1, 'only the allowlisted, catalogued mint')
    assert.equal(entries[0].mint, onA)
    assert.deepEqual(missing, [onB], 'allowlisted-but-uncatalogued shown by address')
    assert.isFalse([...allowlist].includes(offChain), 'off-chain catalog entry cannot grant permission')
    assert.isTrue(cat.marketHoursWarning(onA), 'stock market-hours warning')
  })
})

describe('metadata pipeline (§7.5b)', () => {
  it('hosts an image and produces valid metadata JSON with the image URI', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2e-meta-'))
    try {
      const host = new LocalMetadataHost(dir, 'https://cdn.example/h2e')
      const res = await host.put({ name: 'Nvidia Holders', symbol: 'NVH', description: 'pays in NVDAx', imageBytes: Buffer.from([1, 2, 3, 4]), imageExt: 'png' })
      assert.match(res.uri, /\.json$/); assert.match(res.imageUri, /\.png$/)
      // the JSON is real and points at the hosted image
      const jsonFile = path.join(dir, path.basename(res.uri))
      const meta = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
      assert.equal(meta.name, 'Nvidia Holders'); assert.equal(meta.symbol, 'NVH'); assert.equal(meta.image, res.imageUri)
      assert.isTrue(fs.existsSync(path.join(dir, path.basename(res.imageUri))), 'image hosted')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
