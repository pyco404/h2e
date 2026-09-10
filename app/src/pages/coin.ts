import { PublicKey } from '@solana/web3.js'
import { h, mount, empty, short } from '../ui'
import { loadCoin, loadGlobal, loadCoins, loadEpochs, loadFeesAccrued, loadAllowlistMints, loadTokenMeta } from '../chain'
import { assetLabel, assetColor, assetGlyph } from '../catalog'
import { placeholderFill, placeholderTile } from '../placeholder'
import { walletPubkey } from '../wallet'

const sol = (l: bigint | number | string) => (Number(l) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 })
const age = (ts: number) => {
  const s = Math.floor(Date.now() / 1000) - ts
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

// ---------- Explore / My coins card grid ----------
async function coinCard(c: any): Promise<HTMLElement> {
  const m = new PublicKey(c.mint)
  const meta = await loadTokenMeta(m)
  const name = meta?.name || short(m.toBase58(), 6)
  const ticker = meta?.symbol ? '$' + meta.symbol : short(m.toBase58(), 4)
  const status = Object.keys(c.status)[0]
  return h('a', { class: 'coin', href: `#/coin/${m.toBase58()}` }, [
    h('div', { class: 'thumb' }, [
      placeholderFill(m.toBase58()),
      h('span', { class: 'pay' }, [h('i', { style: `background:${assetColor(c.default_payout_mint)}` }), '→ ' + assetLabel(c.default_payout_mint)]),
      h('span', { class: 'flow' }, [status]),
    ]),
    h('div', { class: 'cbody' }, [
      h('div', { class: 'nm' }, [name]),
      h('div', { class: 'tk' }, [ticker]),
      h('div', { class: 'crow' }, [h('span', {}, ['launched ' + new Date(Number(c.launch_ts) * 1000).toISOString().slice(0, 10)]), h('span', {}, [age(Number(c.launch_ts))])]),
    ]),
  ])
}

async function renderCardGrid(root: HTMLElement, coins: any[], emptyNode: HTMLElement) {
  if (coins.length === 0) { root.append(emptyNode); return }
  const grid = h('div', { class: 'cards' }, [])
  root.append(grid)
  const cards = await Promise.all(coins.sort((a, b) => Number(b.launch_ts) - Number(a.launch_ts)).map(coinCard))
  grid.replaceChildren(...cards)
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

  const meta = await loadTokenMeta(mint)
  const name = meta?.name || short(mint.toBase58(), 6)
  const ticker = meta?.symbol ? '$' + meta.symbol : short(mint.toBase58(), 6)
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
      h('div', { class: 'coinart' }, [placeholderTile(mint.toBase58())]),
      h('div', {}, [h('h1', {}, [name]), h('p', { class: 'sub mono' }, [ticker + ' · holders paid in ', h('span', { style: 'color:var(--mint)' }, [assetLabel(payout)]), ' · ' + status])]),
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
