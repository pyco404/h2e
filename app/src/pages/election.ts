import { PublicKey } from '@solana/web3.js'
import { h, mount, empty, short } from '../ui'
import { loadCoin, loadAllowlistMints, loadTokenMeta } from '../chain'
import { walletPubkey, signMessage } from '../wallet'
import { assetLabel, assetColor, assetGlyph, marketHoursWarning } from '../catalog'
import { assetPicker } from '../asset-picker'

function electionApi(): string | null {
  const q = new URLSearchParams(location.search).get('electionApi')
  if (q) { try { localStorage.setItem('h2e.electionApi', q) } catch {} return q }
  try { return localStorage.getItem('h2e.electionApi') } catch { return null }
}
const electionMessage = (mint: string, epoch: number, outMint: string, nonce: number) => `h2e-election:v1:${mint}:${epoch}:${outMint}:${nonce}`

export async function renderElection(root: HTMLElement, mintStr?: string) {
  if (!mintStr) { mount(root, empty('Open this from a coin page.', 'The election is per coin — it needs a mint.')); return }
  let mint: PublicKey
  try { mint = new PublicKey(mintStr) } catch { mount(root, empty('Invalid mint.', 'Check the address.')); return }
  const cc = await loadCoin(mint)
  if (!cc) { mount(root, empty('No coin found at this mint.', 'Wrong RPC, or not an H2E coin.')); return }
  const allow = await loadAllowlistMints()
  if (!allow.length) { mount(root, empty('No payout assets to choose from yet.', 'PlatformAllowlist is not initialized on this RPC.')); return }

  const meta = await loadTokenMeta(mint)
  const ticker = meta?.symbol ? '$' + meta.symbol : short(mint.toBase58(), 6)
  const def = new PublicKey(cc.default_payout_mint)
  const epoch = Number(cc.current_epoch)
  let picked = def.toBase58()

  const status = h('div', { class: 'status' }, [])
  const warn = h('div', {}, [])
  const submit = h('button', { class: 'mint-btn', onClick: onSubmit }, ['Sign & submit'])
  const api = electionApi()
  const updateWarn = () => warn.replaceChildren(marketHoursWarning(picked) ? h('p', { class: 'hint', style: 'color:var(--mint)' }, ['Tokenised stocks route thin when markets are closed — payouts still settle, but slippage widens.']) : document.createTextNode(''))

  const gate = () => { if (!walletPubkey() || !api) submit.setAttribute('disabled', 'true'); else submit.removeAttribute('disabled') }

  mount(root,
    h('div', { style: 'margin:1.5rem 0 0' }, [h('h1', {}, ['Choose your payout asset']), h('p', { class: 'sub' }, [`For ${ticker} · epoch ${epoch}. Per round, each holder can be paid in a different asset.`])]),
    h('div', { class: 'card panel', style: 'margin:1.25rem 0' }, [
      h('h3', {}, ['The coin’s default']),
      h('div', { style: 'display:flex;align-items:center;gap:.6rem' }, [h('span', { class: 'av', style: `background:${assetColor(def)}` }, [assetGlyph(def)]), h('span', {}, [assetLabel(def), h('span', { style: 'color:var(--faint)' }, [' — you get this unless you choose otherwise'])])]),
    ]),
    h('div', { class: 'card formcard' }, [
      h('div', { class: 'ch' }, [h('span', { class: 'ico' }, ['⇄']), h('div', {}, [h('h2', {}, ['Pay me in']), h('p', {}, ['Applies from the next round; only affects your own wallet.'])])]),
      assetPicker({ mints: allow, selected: picked, onSelect: (m) => { picked = m; updateWarn() } }),
      warn,
      h('div', { style: 'display:flex;gap:.75rem;align-items:center;margin-top:1rem;flex-wrap:wrap' }, [submit, status]),
      api ? null : empty('No election API configured.', 'Elections are off-chain signed messages (§7.6). Set ?electionApi=<url> to point at the election service. Without it nothing is written, so no election is shown as active.'),
    ]),
  )
  updateWarn(); gate()
  window.addEventListener('h2e:wallet', gate)

  async function onSubmit() {
    const w = walletPubkey(); if (!w || !api) return
    const nonce = Date.now()
    submit.setAttribute('disabled', 'true'); status.className = 'status'; status.textContent = 'Sign the election in your wallet…'
    try {
      const sig = await signMessage(electionMessage(mint.toBase58(), epoch, picked, nonce))
      const body = { mint: mint.toBase58(), epochIndex: epoch, outMint: picked, nonce, wallet: w.toBase58(), signature: Buffer.from(sig).toString('base64') }
      const res = await fetch(`${api}/election`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) throw new Error(await res.text())
      status.className = 'status ok'; status.textContent = `Election submitted: you will be paid in ${assetLabel(picked)} next round.`
    } catch (e: any) { status.className = 'status err'; status.textContent = 'Election failed: ' + (e?.message || String(e)) }
    finally { gate() }
  }
}
