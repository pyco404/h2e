import './shim-node'
import { h } from './ui'
import { rpcUrl } from './rpc'
import { loadCatalog } from './catalog'
import { available, connect, disconnect, walletPubkey } from './wallet'
import { renderHome } from './pages/home'
import { renderLaunch } from './pages/launch'
import { renderCoin, renderMine } from './pages/coin'
import { renderElection } from './pages/election'
import { renderRound } from './pages/round'

const app = () => document.getElementById('app')!

/** Sections that get the console chrome (nav + RPC + wallet). Everything else —
 *  today just the marketing landing at #/ — gets the plain marketing header:
 *  logo and one way in. A visitor who has just arrived sees no RPC and no wallet. */
const APP_SECTIONS = new Set(['coin', 'launch', 'mine', 'round'])
const section = () => (location.hash || '#/').replace(/^#\//, '').split('/').filter(Boolean)[0] || 'home'

async function route() {
  const parts = (location.hash || '#/').replace(/^#\//, '').split('/').filter(Boolean)
  const root = app()
  renderChrome()
  root.replaceChildren(h('p', { class: 'status', style: 'padding:2rem 0' }, ['Loading…']))
  try {
    if (parts.length === 0) await renderHome(root)
    else if (parts[0] === 'coin' && parts[2] === 'election') await renderElection(root, parts[1])
    else if (parts[0] === 'coin') await renderCoin(root, parts[1])
    else if (parts[0] === 'launch') await renderLaunch(root)
    else if (parts[0] === 'mine') await renderMine(root)
    else if (parts[0] === 'round') await renderRound(root, parts[1], parts[2])
    else location.hash = '#/'
  } catch (e: any) {
    root.replaceChildren(h('div', { class: 'empty', style: 'margin:1.5rem 0' }, [
      h('strong', {}, ['Could not load this screen.']),
      h('span', { class: 'why' }, [`${e?.message || e}. This scaffold defaults to a local validator — set ?rpc=<url> to point elsewhere.`]),
    ]))
  }
}

/** Header for the current route. No drawer and no toggle: on mobile the nav is a
 *  always-visible second row (see the 720px block in styles.css). */
function renderChrome() {
  const sec = section()
  const isApp = APP_SECTIONS.has(sec)

  const nav = document.getElementById('nav')!
  nav.hidden = !isApp
  nav.querySelectorAll<HTMLElement>('a').forEach((a) => {
    const r = a.getAttribute('data-route') || ''
    a.classList.toggle('on', r === '#/' + sec)
    a.onclick = (e) => { e.preventDefault(); location.hash = r }
  })

  const slot = document.getElementById('wallet-slot')!
  if (!isApp) {
    slot.replaceChildren(h('a', { class: 'applink', href: '#/coin' }, ['Launch app →']))
    return
  }
  const pk = walletPubkey()
  const host = (() => { try { return new URL(rpcUrl()).host } catch { return rpcUrl() } })()
  const rpc = h('span', { class: 'chip rpc-chip', title: rpcUrl(), style: 'cursor:default;color:var(--faint)' }, [host])
  const btn = pk
    ? h('button', { class: 'chip', title: 'Disconnect', onClick: () => disconnect() }, [`${pk.toBase58().slice(0, 4)}…${pk.toBase58().slice(-4)}`])
    : h('button', { class: 'chip', onClick: async () => { try { await connect() } catch (e: any) { alert(e?.message || String(e)) } } }, [available() ? 'Connect wallet' : 'No wallet'])
  slot.replaceChildren(rpc, btn)
}

window.addEventListener('hashchange', route)
window.addEventListener('h2e:wallet', () => { renderChrome(); route() })
renderChrome()
loadCatalog().finally(route)
