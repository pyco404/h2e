import { PublicKey } from '@solana/web3.js'
import { h, mount, empty } from '../ui'
import { loadGlobal, loadAllowlistMints } from '../chain'
import { assetInfo, assetGlyph, assetColor, assetLabel } from '../catalog'
import { assetPicker } from '../asset-picker'
import { placeholderFill } from '../placeholder'
import { walletPubkey } from '../wallet'
import { submitLaunch, LaunchForm } from '../launchtx'

function metadataApi(): string | null {
  const q = new URLSearchParams(location.search).get('metadataApi')
  if (q) { try { localStorage.setItem('h2e.metadataApi', q) } catch {} return q }
  try { return localStorage.getItem('h2e.metadataApi') } catch { return null }
}

interface St { name: string; symbol: string; uri: string; imageFile: File | null; payout: string }

export async function renderLaunch(root: HTMLElement) {
  const gc = await loadGlobal()
  if (!gc) { mount(root, empty('The launch form appears once the program is configured.', 'No GlobalConfig on this RPC. Run initialize_global, then reload.')); return }
  const allow = await loadAllowlistMints()
  if (!allow || allow.length === 0) { mount(root, empty('The payout-asset picker needs the platform allowlist.', 'PlatformAllowlist is empty. An admin adds payout mints via set_platform_allowlist, then reload.')); return }

  const usdc = gc.usdc_mint ? new PublicKey(gc.usdc_mint).toBase58() : allow[0].toBase58()
  const st: St = { name: '', symbol: '', uri: '', imageFile: null, payout: allow.find((m) => m.toBase58() === usdc)?.toBase58() || allow[0].toBase58() }
  let screen: 'form' | 'launch' = 'form'
  const hasMeta = !!metadataApi()

  render()
  function render() { screen === 'form' ? renderForm() : renderLaunchScreen() }

  function steps(active: 0 | 1 | 2): HTMLElement {
    const ready = !!st.name.trim() && !!st.symbol.trim()
    const cls = (i: number) => i === active ? 'st on' : (i < active || (i === 0 && ready) ? 'st done' : 'st')
    const step = (i: number, label: string) => h('button', { class: cls(i), onClick: () => tryGo(i) }, [h('b', {}, [`0${i + 1}`]), ' ' + label])
    return h('div', { class: 'steps' }, [
      step(0, 'Your coin'), h('span', { class: 'line' }),
      step(1, 'Payout asset'), h('span', { class: 'line' }),
      step(2, 'Launch'),
    ])
  }
  function tryGo(i: number) {
    if (i === 2) { if (!st.name.trim() || !st.symbol.trim()) { alert('Add a coin name and ticker first.'); return } screen = 'launch'; render() }
    else { screen = 'form'; render() }
  }

  function renderForm() {
    const nameEl = h('input', { class: 'in', value: st.name, placeholder: 'Correy the Cat' }) as HTMLInputElement
    nameEl.oninput = () => { st.name = nameEl.value; renderSide() }
    const symEl = h('input', { class: 'in mono', value: st.symbol, placeholder: 'CORREY' }) as HTMLInputElement
    symEl.oninput = () => { st.symbol = symEl.value.toUpperCase(); symEl.value = st.symbol; renderSide() }

    const coinCard = h('div', { class: 'card formcard' }, [
      h('div', { class: 'ch' }, [h('span', { class: 'ico' }, ['✎']), h('div', {}, [h('h2', {}, ['Your coin']), h('p', {}, ['A name and a ticker. Everything else is optional.'])]), h('span', { class: 'no' }, ['01'])]),
      h('div', { class: 'fld' }, [h('label', {}, ['Coin name']), nameEl]),
      h('div', { class: 'fld' }, [h('label', {}, ['Ticker']), symEl]),
      hasMeta ? imageField() : null,
    ])
    const payoutCard = h('div', { class: 'card formcard' }, [
      h('div', { class: 'ch' }, [h('span', { class: 'ico' }, ['⇄']), h('div', {}, [h('h2', {}, ['Payout asset']), h('p', {}, ['What holders receive. Any holder can override this for themselves.'])]), h('span', { class: 'no' }, ['02'])]),
      assetPicker({ mints: allow, selected: st.payout, onSelect: (m) => { st.payout = m; renderSide() } }),
    ])

    const side = h('aside', { class: 'side', id: 'launch-side' })
    mount(root,
      h('p', { class: 'eyebrow' }, ['Built on Solana']),
      h('h1', {}, ['Launch a coin']),
      h('div', { class: 'intro' }, [
        h('p', {}, ['Fixed supply of 1,000,000,000 on a Meteora curve. Every trade pays a fee, and that fee goes to the people holding your coin — converted into an asset you choose, sent every 24 hours. You take no cut.']),
        h('a', { class: 'ghost', href: '#/coin' }, ['Explore coins →']),
      ]),
      steps(1),
      h('div', { class: 'cols' }, [h('div', {}, [coinCard, payoutCard]), side]),
    )
    renderSide()
  }

  function imageField(): HTMLElement {
    const fileEl = h('input', { class: 'in', type: 'file', accept: 'image/*' }) as HTMLInputElement
    fileEl.onchange = () => { st.imageFile = fileEl.files && fileEl.files[0]; renderSide() }
    return h('div', { class: 'fld' }, [h('label', {}, ['Image']), fileEl])
  }

  function renderSide() {
    const side = document.getElementById('launch-side'); if (!side) return
    const info = assetInfo(st.payout)
    const img = st.imageFile ? h('img', { src: URL.createObjectURL(st.imageFile), alt: '' }) : null
    const pcard = h('div', { class: 'pcard' }, [
      h('div', { class: 'pimg' }, [img || placeholderFill(st.symbol || st.name || st.payout), h('span', { class: 'ptag' }, [h('i', { style: `background:${assetColor(st.payout)}` }), assetLabel(st.payout)])]),
      h('div', { class: 'pbody' }, [
        h('div', { class: 'nm' }, [st.name || 'Your coin']),
        h('div', { class: 'tk' }, ['$' + (st.symbol || 'TICKER')]),
        h('div', { class: 'prow' }, [h('span', {}, ['$0.00 ', h('span', { style: 'color:var(--faint)' }, ['MC'])]), h('span', {}, ['$0 vol'])]),
        h('div', { class: 'prow' }, [h('span', {}, ['—']), h('span', {}, ['new'])]),
      ]),
    ])
    const spec = h('dl', { class: 'spec' }, [
      specRow('Network', 'Solana'),
      specRow('Holders paid in', info ? info.symbol : assetLabel(st.payout), true),
      specRow('Payout every', '24 hours'),
      specRow('Your fees go', 'to holders', true),
      specRow('Fee split', '60 / 30 / 10'),
      specRow('Dev buy', 'none · cap 3%'),
      specRow('Supply', '1,000,000,000'),
    ])
    const cont = h('button', { class: 'go', onClick: () => tryGo(2) }, ['Continue →'])
    side.replaceChildren(
      h('p', { class: 'plabel' }, [h('i', { class: 'dot' }), 'Live preview', h('span', {}, ['how it shows on Explore'])]),
      pcard, spec, cont,
      h('p', { class: 'fine' }, ['Payout asset and fee routing are permanent.']),
    )
  }

  function renderLaunchScreen() {
    const pk = walletPubkey()
    const status = h('div', { class: 'status' }, [])
    const logBox = h('pre', { class: 'log hidden' }, [])
    const log = (s: string) => { logBox.classList.remove('hidden'); logBox.textContent += (logBox.textContent ? '\n' : '') + s }
    const setStatus = (m: string, k = '') => { status.textContent = m; status.className = 'status' + (k ? ' ' + k : '') }

    const launchBtn = h('button', { class: 'go', style: 'max-width:16rem', onClick: onLaunch }, [pk ? 'Launch coin' : 'Connect a wallet to launch'])
    if (!pk) launchBtn.setAttribute('disabled', 'true')

    mount(root,
      h('p', { class: 'eyebrow' }, ['Built on Solana']),
      h('h1', {}, ['Launch']),
      steps(2),
      h('div', { class: 'card formcard', style: 'max-width:40rem' }, [
        h('div', { class: 'ch' }, [h('span', { class: 'ico' }, ['↑']), h('div', {}, [h('h2', {}, ['Review & launch']), h('p', {}, ['Creates an address lookup table, then the pool and CoinConfig in one transaction.'])]), h('span', { class: 'no' }, ['03'])]),
        h('dl', { class: 'spec', style: 'margin-top:0' }, [
          specRow('Coin', `${st.name} ($${st.symbol})`),
          specRow('Holders paid in', assetLabel(st.payout), true),
          specRow('Dev buy', 'none · cap 3%'),
          specRow('Supply', '1,000,000,000'),
        ]),
        h('div', { style: 'display:flex;gap:.75rem;align-items:center;margin-top:1rem;flex-wrap:wrap' }, [
          h('button', { class: 'chip', onClick: () => { screen = 'form'; render() } }, ['← Back']),
          launchBtn, status,
        ]),
        logBox,
      ]),
    )

    async function onLaunch() {
      const payer = walletPubkey(); if (!payer) { setStatus('Connect a wallet first.', 'err'); return }
      launchBtn.setAttribute('disabled', 'true'); logBox.textContent = ''
      setStatus('Launching… approve each wallet prompt.')
      try {
        const uri = await resolveUri()
        const form: LaunchForm = { name: st.name.trim(), symbol: st.symbol.trim(), uri, devBuyLamports: 0n, defaultPayoutMint: new PublicKey(st.payout) }
        const { mint, launchSig } = await submitLaunch(payer, gc.platform_config_key, gc.platform_wallet, form, log)
        setStatus('Launched.', 'ok')
        log(`\nDone. Coin ${mint.toBase58()} · sig ${launchSig.slice(0, 8)}…`)
        root.append(h('div', { class: 'card panel', style: 'max-width:40rem;margin-top:1rem' }, [
          h('h3', {}, ['Coin launched']),
          h('p', { class: 'mono', style: 'color:var(--dim);word-break:break-all' }, [mint.toBase58()]),
          h('a', { class: 'mint-btn', href: `#/coin/${mint.toBase58()}` }, ['Open coin page']),
        ]))
      } catch (e: any) { setStatus('Launch failed: ' + (e?.message || String(e)), 'err'); log('ERROR: ' + (e?.message || String(e))); launchBtn.removeAttribute('disabled') }
    }
    async function resolveUri(): Promise<string> {
      const api = metadataApi()
      if (api && st.imageFile) {
        const fd = new FormData(); fd.append('image', st.imageFile); fd.append('name', st.name); fd.append('symbol', st.symbol)
        const res = await fetch(`${api}/metadata`, { method: 'POST', body: fd })
        if (!res.ok) throw new Error('metadata upload failed: ' + (await res.text()))
        return (await res.json()).uri
      }
      return `https://h2etoken.xyz/meta/${st.symbol.toLowerCase()}.json`
    }
  }
}

function specRow(k: string, v: string, hi = false): HTMLElement {
  return h('div', {}, [h('dt', {}, [k]), h('dd', { class: hi ? 'hi' : '' }, [v])])
}
