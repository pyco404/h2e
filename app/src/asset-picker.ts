import { PublicKey } from '@solana/web3.js'
import { h, short } from './ui'
import { assetInfo, assetGlyph, assetColor, assetCategory, AssetCategory } from './catalog'

/**
 * The payout-asset picker (dark grid). Renders only mints actually in the on-chain
 * PlatformAllowlist (passed in); the catalog supplies display metadata. Tabs +
 * search are pure view over that real set — never a hardcoded asset list.
 */
export interface PickerOptions {
  mints: PublicKey[]
  selected?: string
  onSelect: (mint: string) => void
}

const TABS: { key: AssetCategory | 'all'; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'stable', label: 'Stablecoins' },
  { key: 'crypto', label: 'Crypto' }, { key: 'stock', label: 'Stocks' },
]

export function assetPicker(opts: PickerOptions): HTMLElement {
  let cat: AssetCategory | 'all' = 'all'
  let q = ''
  let selected = opts.selected || (opts.mints[0] && opts.mints[0].toBase58())

  const grid = h('div', { class: 'grid' })
  const cnt = h('span', { class: 'cnt mono' })
  const tabsEl = h('div', { class: 'tabs' },
    TABS.map((t) => h('button', { class: t.key === 'all' ? 'on' : '', 'data-cat': t.key, onClick: () => setCat(t.key) }, [t.label])))
  const searchEl = h('input', { class: 'in', placeholder: 'Search asset, ticker or issuer' }) as HTMLInputElement
  searchEl.addEventListener('input', () => { q = searchEl.value.toLowerCase(); render() })

  function shown(): string[] {
    return opts.mints.map((m) => m.toBase58()).filter((mint) => {
      const c = assetCategory(mint)
      if (cat !== 'all' && c !== cat) return false
      if (!q) return true
      const info = assetInfo(mint)
      const hay = ((info?.symbol || '') + (info?.name || '') + (info?.issuer || '') + mint).toLowerCase()
      return hay.includes(q)
    })
  }
  function setCat(c: AssetCategory | 'all') {
    cat = c
    ;[...tabsEl.children].forEach((b) => (b as HTMLElement).classList.toggle('on', (b as HTMLElement).getAttribute('data-cat') === c))
    render()
  }
  function render() {
    const list = shown()
    cnt.textContent = `${list.length} / ${opts.mints.length}`
    grid.replaceChildren(...list.map((mint) => {
      const info = assetInfo(mint)
      const name = info ? info.name : short(mint, 6)
      const sub = info ? `${info.symbol} · ${info.issuer}` : mint.slice(0, 12) + '…'
      return h('button', { class: 'as' + (mint === selected ? ' on' : ''), onClick: () => { selected = mint; opts.onSelect(mint); render() } }, [
        h('span', { class: 'av', style: `background:${assetColor(mint)}` }, [assetGlyph(mint)]),
        h('span', {}, [h('span', { class: 'n' }, [name]), h('br'), h('span', { class: 't' }, [sub])]),
        h('span', { class: 'k' }, ['✓']),
      ])
    }))
    if (list.length === 0) grid.replaceChildren(h('div', { class: 'empty', style: 'grid-column:1/-1' }, [
      h('strong', {}, ['No assets in this category.']),
      h('span', { class: 'why' }, ['Only mints in the on-chain PlatformAllowlist appear here.']),
    ]))
  }

  render()
  return h('div', {}, [tabsEl, h('div', { class: 'srow' }, [searchEl, cnt]), grid])
}
