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

async function route() {
  const hash = location.hash || '#/'
  const parts = hash.replace(/^#\//, '').split('/').filter(Boolean)
  const root = app()
  setActiveNav(parts[0] || 'home')
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

function setActiveNav(section: string) {
  document.querySelectorAll<HTMLElement>('#nav a').forEach((a) => {
    const r = a.getAttribute('data-route') || ''
    a.classList.toggle('on', r === '#/' + section)
    a.onclick = (e) => { e.preventDefault(); closeMenu(); location.hash = r }
  })
}

const menuBtn = () => document.getElementById('menu-btn')
const navEl = () => document.getElementById('nav')
function closeMenu() { navEl()?.classList.remove('open'); menuBtn()?.setAttribute('aria-expanded', 'false') }
function setupMenu() {
  const btn = menuBtn(); const nav = navEl(); if (!btn || !nav) return
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const open = nav.classList.toggle('open')
    btn.setAttribute('aria-expanded', open ? 'true' : 'false')
  })
  // close when tapping outside the menu or on Escape
  document.addEventListener('click', (e) => {
    if (!nav.classList.contains('open')) return
    const t = e.target as Node
    if (!nav.contains(t) && t !== btn) closeMenu()
  })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu() })
}

function renderWalletChip() {
  const slot = document.getElementById('wallet-slot')!
  const pk = walletPubkey()
  const host = (() => { try { return new URL(rpcUrl()).host } catch { return rpcUrl() } })()
  const rpc = h('span', { class: 'chip', style: 'cursor:default;color:var(--faint)' }, [host])
  const btn = pk
    ? h('button', { class: 'chip', title: 'Disconnect', onClick: () => disconnect() }, [`${pk.toBase58().slice(0, 4)}…${pk.toBase58().slice(-4)}`])
    : h('button', { class: 'chip', onClick: async () => { try { await connect() } catch (e: any) { alert(e?.message || String(e)) } } }, [available() ? 'Connect wallet' : 'No wallet'])
  slot.replaceChildren(rpc, btn)
}

window.addEventListener('hashchange', route)
window.addEventListener('h2e:wallet', () => { renderWalletChip(); route() })
setupMenu()
renderWalletChip()
loadCatalog().finally(route)
