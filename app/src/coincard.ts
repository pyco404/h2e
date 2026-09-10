import { h } from './ui'

/**
 * The Explore card body — rows 1-4 — in ONE place, so the launch page's
 * "how it shows on Explore" preview cannot drift from the real card again.
 *
 *   Row 1  Coin name        (one line, ellipsis)
 *   Row 2  $TICKER          (omitted entirely when there is no symbol)
 *   Row 3  MC · vol         (right-aligned as a pair)
 *   Row 4  paid to holders  |  status + age
 *
 * "…" means a read is in flight; "—" means it came back empty. Neither is ever 0:
 * a zero reads as a dead coin.
 */
export interface CardValues {
  name: string
  symbol: string | null
  mc: string        // e.g. "$12.4K MC", "— MC", "… MC"
  vol: string
  paid: string      // e.g. "$1.2K to holders"
  status: string    // Bonding / Graduated / …
  age: string       // 3h, 12h, new
  loading?: boolean
}

export interface CardBody {
  el: HTMLElement
  nameEl: HTMLElement
  tickerEl: HTMLElement
  mcEl: HTMLElement
  volEl: HTMLElement
  paidEl: HTMLElement
}

export function cardBody(v: CardValues): CardBody {
  const load = v.loading ? ' loading' : ''
  const nameEl = h('div', { class: 'nm' }, [v.name])
  const tickerEl = h('div', { class: 'tk fig', hidden: !v.symbol }, [v.symbol ? '$' + v.symbol.replace(/^\$/, '') : ''])
  const mcEl = h('span', { class: 'fig' + load }, [v.mc])
  const volEl = h('span', { class: 'fig' + load }, [v.vol])
  const paidEl = h('span', { class: 'fig paid' + load }, [v.paid])
  const el = h('div', { class: 'cbody' }, [
    nameEl,
    tickerEl,
    h('div', { class: 'crow figs' }, [mcEl, h('span', { class: 'sep' }, ['·']), volEl]),
    h('div', { class: 'crow foot' }, [
      paidEl,
      h('span', { class: 'foot-r' }, [
        h('span', { class: 'flow' }, [v.status]),
        h('span', { class: 'fig dim' }, [v.age]),
      ]),
    ]),
  ])
  return { el, nameEl, tickerEl, mcEl, volEl, paidEl }
}

/** Show a ticker that arrived after first render (row 2 starts hidden). */
export function setTicker(tickerEl: HTMLElement, symbol: string | null) {
  if (!symbol) return           // no symbol: row stays hidden, mint is never printed twice
  tickerEl.textContent = '$' + symbol.replace(/^\$/, '')
  tickerEl.hidden = false
}
