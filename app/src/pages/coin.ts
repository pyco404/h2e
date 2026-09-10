import { PublicKey } from '@solana/web3.js'
import { h, mount, empty, short } from '../ui'
import { loadCoin, loadGlobal, loadCoins, loadEpochs, loadFeesAccrued, loadAllowlistMints } from '../chain'
import { assetLabel, assetColor, assetGlyph } from '../catalog'
import { artTile, artAvatar, setArtTicker } from '../placeholder'
import { loadCoinMeta } from '../coinmeta'
import { loadMarket, solPriceUsd, lamportsToUsd } from '../market'
import { cardBody, setTicker } from '../coincard'
import { usd, sol as solFmt, age } from '../format'
import { walletPubkey } from '../wallet'

const sol = (l: bigint | number | string) => (Number(l) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 })

// ---------- Explore / My coins card grid ----------
/**
 * A coin card. Built synchronously with the on-chain facts (payout asset, status,
 * age) and filled in as the two slow reads land: identity (metadata account → uri
 * → JSON) and market figures (DBC pool). Nothing renders a 0 in place of an
 * unknown — a missing figure is "—", because a zero reads as a dead coin.
 */
function coinCard(c: any): HTMLElement {
  const m = new PublicKey(c.mint)
  const mintStr = m.toBase58()
  const status = Object.keys(c.status)[0]

  const artWrap = h('div', { class: 'thumb' }, [
    artTile(mintStr, null),
    h('span', { class: 'pay' }, [h('i', { style: `background:${assetColor(c.default_payout_mint)}` }), '→ ' + assetLabel(c.default_payout_mint)]),
  ])
  // "…" while a read is in flight; "—" only once it has actually come back empty
  const b = cardBody({
    name: short(mintStr, 6), symbol: null,
    mc: '… MC', vol: '… vol', paid: '…',
    status, age: age(Number(c.launch_ts)), loading: true,
  })
  const { nameEl, tickerEl, mcEl, volEl, paidEl } = b

  const card = h('a', { class: 'coin', href: `#/coin/${mintStr}` }, [artWrap, b.el])

  // identity — name, ticker, image
  loadCoinMeta(m).then((meta) => {
    if (meta.name) nameEl.textContent = meta.name
    setTicker(tickerEl, meta.symbol)
    setArtTicker(artWrap.querySelector('.art'), mintStr, meta.symbol)
    if (meta.image) {
      const img = h('img', { src: meta.image, alt: '', loading: 'lazy' })
      img.addEventListener('error', () => img.remove())
      artWrap.prepend(img)
    }
  })

  // market — MC and volume from the DBC pool, paid-out from CoinConfig
  ;(async () => {
    const solUsd = await solPriceUsd()
    const paid = lamportsToUsd(c.total_paid_out, solUsd)
    paidEl.textContent = (paid == null ? solFmt(Number(c.total_paid_out) / 1e9) : usd(paid)) + ' to holders'
    paidEl.classList.remove('loading')
    if (!c.dbc_pool) { mcEl.textContent = '— MC'; volEl.textContent = '— vol'; mcEl.classList.remove('loading'); volEl.classList.remove('loading'); return }
    const mk = await loadMarket(m, new PublicKey(c.dbc_pool))
    mcEl.textContent = (mk.mcapUsd != null ? usd(mk.mcapUsd) : mk.mcapSol != null ? solFmt(mk.mcapSol) : '—') + ' MC'
    volEl.textContent = (mk.vol24hUsd != null ? usd(mk.vol24hUsd) : '—') + ' vol'
    if (mk.vol24hUsd == null) volEl.title = '24h volume needs the indexer — the DBC pool account carries no volume field'
    mcEl.classList.remove('loading'); volEl.classList.remove('loading')
  })()

  return card
}

async function renderCardGrid(root: HTMLElement, coins: any[], emptyNode: HTMLElement) {
  if (coins.length === 0) { root.append(emptyNode); return }
  const grid = h('div', { class: 'cards' }, [])
  root.append(grid)
  grid.replaceChildren(...coins.sort((a, b) => Number(b.launch_ts) - Number(a.launch_ts)).map(coinCard))
}

export async function renderCoin(root: HTMLElement, mintStr?: string) {
  if (!mintStr) {
    mount(root, h('div', { class: 'toprow' }, [
      h('input', { class: 'search', placeholder: 'Search coins by name, ticker or address', disabled: 'true' }),
      h('a', { class: 'create', href: '#/launch' }, ['+ Launch']),
    ]))
    let coins: any[] = []
    try { coins = await loadCoins() } catch (e: any) { root.append(empty('Could not reach the RPC.', `${e?.message || e}. Set ?rpc=<url>.`)); return }
    root.append(h('div', { class: 'headrow' }, [h('h1', {}, ['Explore', h('span', { class: 'count-pill mono' }, [`${coins.length} launched`])])]))
    await renderCardGrid(root, coins, empty('No coins launched yet on this RPC.', 'Coins are discovered on-chain (getProgramAccounts on CoinConfig). Launch one, or point ?rpc= at a chain that has some.'))
    return
  }

  let mint: PublicKey
  try { mint = new PublicKey(mintStr) } catch { mount(root, empty('That is not a valid mint address.', 'Check the address and try again.')); return }
  const cc = await loadCoin(mint)
  if (!cc) { mount(root, empty('No H2E coin found at this mint.', 'Either it was not launched through H2E, or you are on the wrong RPC.')); return }

  const meta = await loadCoinMeta(mint)
  const name = meta.name || short(mint.toBase58(), 6)
  const ticker = meta.symbol ? '$' + meta.symbol.replace(/^\$/, '') : null
  const status = Object.keys(cc.status)[0]
  const payout = new PublicKey(cc.default_payout_mint)

  // real values
  let fees = 0n; try { fees = await loadFeesAccrued(mint) } catch {}
  const gc = await loadGlobal()
  let nextTxt = '— needs GlobalConfig', epochTxt = ''
  if (gc) {
    const secs = Number(gc.epoch_seconds)
    const end = (Number(cc.launch_ts) + secs * (Number(cc.current_epoch) + 1)) * 1000
    nextTxt = new Date(end).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
    epochTxt = `epoch ${cc.current_epoch}`
  }

  mount(root,
    h('div', { class: 'coinhead' }, [
      h('div', { class: 'coinart' }, [artAvatar(mint.toBase58(), meta.symbol)]),
      h('div', {}, [h('h1', {}, [name]), h('p', { class: 'sub mono' }, [
        ticker ? ticker + ' · holders paid in ' : 'holders paid in ',
        h('span', { style: 'color:var(--mint)' }, [assetLabel(payout)]), ' · ' + status])]),
    ]),
    h('div', { class: 'stats' }, [
      statCard('Accrued this round', sol(fees), true, 'SOL · 60% share'),
      statCard('Next payout', nextTxt, false, epochTxt),
      statCard('Eligible holders', '—', false, 'needs indexer'),
      statCard('Paid out to date', String(cc.total_paid_out), true, 'lamports · on-chain'),
    ]),
    h('div', { class: 'two' }, [coinLeft(mint, cc), coinRight(mint, cc, payout)]),
  )
}

function statCard(lb: string, big: string, acc: boolean, sm: string): HTMLElement {
  return h('div', { class: 'card stat' }, [h('div', { class: 'lb' }, [lb]), h('div', { class: 'big' + (acc ? ' acc' : '') }, [big]), h('div', { class: 'sm' }, [sm])])
}

function coinLeft(mint: PublicKey, cc: any): HTMLElement {
  const wrap = h('div', {}, [h('div', { class: 'secthead' }, [h('h2', {}, ['Payout history']), h('span', { id: 'ph-count' }, [''])])])
  const holder = h('div', {}, [])
  wrap.append(holder)
  ;(async () => {
    let epochs: any[] = []
    try { epochs = await loadEpochs(mint) } catch {}
    const cnt = document.getElementById('ph-count'); if (cnt) cnt.textContent = `${epochs.length} rounds`
    if (epochs.length === 0) {
      holder.replaceChildren(empty('No settled rounds yet.', 'settle_epoch / swap_payout / distribute_batch are built; a round appears the moment the keeper settles it. This reads real EpochState accounts.'))
      return
    }
    holder.replaceChildren(h('div', { class: 'card tablewrap' }, [h('table', {}, [
      h('thead', {}, [h('tr', {}, ['Round', 'Payout (SOL)', 'Swapped', 'Buckets', 'Settled', ''].map((t, i) => h('th', { class: i > 0 && i < 5 ? 'r' : '' }, [t])))]),
      h('tbody', {}, epochs.map((e) => h('tr', {}, [
        h('td', {}, [String(e.epoch_index)]),
        h('td', { class: 'r amt' }, [sol(e.payout_amount)]),
        h('td', { class: 'r' }, [sol(e.swapped_in)]),
        h('td', { class: 'r' }, [`${e.buckets_complete}/${e.bucket_count}`]),
        h('td', { class: 'r' }, [String(e.settled)]),
        h('td', { class: 'r' }, [h('a', { class: 'linkbtn', href: `#/round/${mint.toBase58()}/${e.epoch_index}` }, ['round →'])]),
      ]))),
    ])]))
  })()
  return wrap
}

function coinRight(mint: PublicKey, cc: any, payout: PublicKey): HTMLElement {
  const pos = h('div', { class: 'card panel' }, [
    h('h3', {}, ['Your position']),
    empty('Connect the indexer to see your aged balance.', 'Balance, aged balance and estimated payout come from the off-chain indexer (Task 2.1), which streams transfers — not built into this scaffold.'),
  ])
  const elect = h('div', { class: 'card panel', style: 'margin-top:1rem' }, [
    h('h3', {}, ['Get paid in']),
    h('div', { style: 'display:flex;align-items:center;gap:.6rem;margin:.2rem 0 .2rem' }, [
      h('span', { class: 'av', style: `background:${assetColor(payout)}` }, [assetGlyph(payout)]),
      h('span', {}, [assetLabel(payout), h('span', { style: 'color:var(--faint)' }, [' — the coin’s default'])]),
    ]),
    h('p', { class: 'hint' }, ['Any holder can override this for their own wallet, per round.']),
    h('a', { class: 'mint-btn', href: `#/coin/${mint.toBase58()}/election`, style: 'display:inline-block;margin-top:.6rem' }, ['Choose your payout →']),
  ])
  return h('aside', {}, [pos, elect])
}

// "Portfolio" — coins the connected wallet created.
export async function renderMine(root: HTMLElement) {
  mount(root, h('div', { class: 'headrow', style: 'margin-top:1.5rem' }, [h('h1', {}, ['Portfolio'])]))
  const pk = walletPubkey()
  if (!pk) { root.append(empty('Connect your wallet to see coins you launched.', 'This filters the on-chain coin list by creator_wallet.')); return }
  let coins: any[] = []
  try { coins = await loadCoins() } catch (e: any) { root.append(empty('Could not reach the RPC.', `${e?.message || e}.`)); return }
  const mine = coins.filter((c) => new PublicKey(c.creator_wallet).equals(pk))
  await renderCardGrid(root, mine, empty('You have not launched any coins on this RPC.', 'Launch one from the Launch tab — it appears here (creators earn nothing from launching; you earn only by holding).'))
}
