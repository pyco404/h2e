import { PublicKey } from '@solana/web3.js'
import { h, mount, empty, short } from '../ui'
import { conn } from '../rpc'
import { loadCoin, loadBuckets, loadTokenMeta } from '../chain'
import { assetLabel } from '../catalog'
import { walletPubkey } from '../wallet'
import { verifyRoundFile, findEntry, RoundFile } from '../verify'
import { pdas, decodeEpochState, decodeAllowlistState } from '../../../h2e/client'

const sol = (l: bigint | number | string) => (Number(l) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 })
function roundApi(): string | null {
  const q = new URLSearchParams(location.search).get('roundApi')
  if (q) { try { localStorage.setItem('h2e.roundApi', q) } catch {} return q }
  try { return localStorage.getItem('h2e.roundApi') } catch { return null }
}
const toHex = (b: number[] | Uint8Array) => Array.from(b as any).map((x: any) => x.toString(16).padStart(2, '0')).join('')
const kv = (k: string, v: string | Node) => h('div', { class: 'kv' }, [h('dt', {}, [k]), h('dd', {}, [typeof v === 'string' ? document.createTextNode(v) : v])])

export async function renderRound(root: HTMLElement, mintStr?: string, epochStr?: string) {
  if (!mintStr) { mount(root, h('div', { style: 'margin-top:1.5rem' }, [h('h1', {}, ['Rounds']), h('p', { class: 'sub' }, ['Open a round from a coin’s payout history.'])]), empty('Pick a coin first.', 'Rounds are per coin — go to Explore, open a coin, then a round.')); return }
  let mint: PublicKey
  try { mint = new PublicKey(mintStr) } catch { mount(root, empty('Invalid mint.', 'Check the address.')); return }
  const cc = await loadCoin(mint)
  if (!cc) { mount(root, empty('No coin found at this mint.', 'Wrong RPC, or not an H2E coin.')); return }
  const meta = await loadTokenMeta(mint)
  const ticker = meta?.symbol ? '$' + meta.symbol : short(mint.toBase58(), 6)
  const epoch = epochStr != null ? parseInt(epochStr, 10) : Number(cc.current_epoch)

  mount(root, h('div', { style: 'margin:1.5rem 0 0' }, [
    h('h1', {}, [`Round ${epoch} · ${ticker}`]),
    h('p', { class: 'sub' }, ['H2E is a trusted-keeper system; every round anchors an on-chain Merkle root so any holder can verify their own payout.']),
  ]))

  const epInfo = await conn().getAccountInfo(pdas.epochState(mint, epoch))
  if (!epInfo) {
    root.append(empty(`Round ${epoch} has not been settled.`, 'settle_epoch freezes the payout amount and writes the Merkle root on-chain (built), but the keeper that calls it does not exist yet. Once a round settles, its frozen amount, root and per-asset buckets appear here.'))
    return
  }
  const es = decodeEpochState(epInfo.data)
  const alInfo = await conn().getAccountInfo(pdas.allowlistState(mint, epoch))
  const mints: PublicKey[] = alInfo ? (decodeAllowlistState(alInfo.data).mints as any[]).map((m) => new PublicKey(m)) : []
  const rootHex = toHex(es.merkle_root)

  // On-chain anchor
  root.append(h('div', { class: 'card anchor' }, [
    h('div', { style: 'display:flex;align-items:baseline' }, [h('h2', { style: 'margin:0;font-size:.95rem;font-weight:600' }, ['On-chain anchor']), h('span', { class: 'mono', style: 'margin-left:auto;color:var(--faint);font-size:.78rem' }, ['EpochState · read from chain'])]),
    h('div', { class: 'root' }, [rootHex]),
    h('dl', { style: 'margin:.9rem 0 0' }, [
      kv('Frozen payout', sol(es.payout_amount) + ' SOL'),
      kv('Swapped', sol(es.swapped_in) + ' SOL'),
      kv('Buckets complete', `${es.buckets_complete} / ${es.bucket_count}`),
      kv('Total weight', String(es.total_weight)),
      kv('Settled', String(es.settled)),
      mints.length ? kv('Electable assets', mints.map((m) => assetLabel(m)).join(', ')) : kv('Electable assets', '—'),
    ]),
  ]))

  // Buckets
  let buckets: any[] = []
  try { buckets = await loadBuckets(mint, epoch) } catch {}
  root.append(h('div', { class: 'secthead' }, [h('h2', {}, ['Buckets']), h('span', {}, ['one per elected asset'])]))
  if (buckets.length) {
    root.append(h('div', { class: 'card tablewrap' }, [h('table', {}, [
      h('thead', {}, [h('tr', {}, ['Asset', 'SOL in', 'Received', 'Recipients', 'Paid', 'Status'].map((t, i) => h('th', { class: i > 0 && i < 5 ? 'r' : '' }, [t])))]),
      h('tbody', {}, buckets.map((b) => h('tr', {}, [
        h('td', {}, [assetLabel(b.out_mint)]),
        h('td', { class: 'r' }, [sol(b.amount_in)]),
        h('td', { class: 'r amt' }, [String(b.amount_out)]),
        h('td', { class: 'r' }, [String(b.recipient_count)]),
        h('td', { class: 'r' }, [`${b.cursor}/${b.recipient_count}`]),
        h('td', { class: 'r' }, [b.complete ? 'complete' : 'in progress']),
      ]))),
    ])]))
  } else {
    root.append(empty('No buckets yet.', 'swap_payout creates one BucketState per elected asset once the keeper runs it.'))
  }

  // Verify
  const verify = h('div', { class: 'verify' }, [
    h('h3', {}, ['Verify your own payout']),
    h('p', {}, ['Every eligible wallet is a Merkle leaf ', h('code', {}, ['sha256(wallet ‖ out_mint ‖ weight)']), ', hashed into a sorted-pair tree. This page recomputes the root from the published round file and checks it against the on-chain root above — nothing is taken on trust.']),
  ])
  root.append(verify)
  const api = roundApi()
  if (!api) {
    verify.append(empty('Round file endpoint not configured.', 'Set ?roundApi=<url> (served per §7.5c). The on-chain root is shown above; the file lets your browser reproduce it.'))
    return
  }
  const line = h('div', { class: 'status' }, ['Fetching and verifying the round file…'])
  verify.append(line)
  try {
    const file = (await (await fetch(`${api}/round?mint=${mint.toBase58()}&epoch=${epoch}`)).json()) as RoundFile
    const { ok, computedRootHex } = await verifyRoundFile(file, rootHex)
    if (!ok) { line.className = 'status err'; line.textContent = `Round file does NOT match the on-chain root (computed ${computedRootHex.slice(0, 12)}… ≠ ${rootHex.slice(0, 12)}…).`; return }
    const total = BigInt(file.totalWeight)
    const pk = walletPubkey()
    const mine = pk ? findEntry(file, pk.toBase58()) : undefined
    line.className = 'ok'; line.textContent = '✓ Round file verified against the on-chain root'
    if (pk && mine) {
      const b = buckets.find((x) => x.out_mint === mine.outMint)
      const amount = b && total > 0n ? (BigInt(mine.weight) * BigInt(b.amount_out)) / total : 0n
      verify.append(h('dl', { style: 'margin:.7rem 0 0' }, [
        kv('Your weight', mine.weight),
        kv('Your share', total > 0n ? ((Number(BigInt(mine.weight) * 1000000n / total) / 10000).toFixed(4) + '%') : '0%'),
        kv('Paid', h('span', { class: 'amt' }, [String(amount) + ' ' + assetLabel(mine.outMint)])),
      ]))
    } else if (pk) verify.append(h('p', { class: 'hint' }, ['Your wallet was not eligible this round.']))
    else verify.append(h('p', { class: 'hint' }, ['Connect your wallet to see your own line.']))
  } catch (e: any) { line.className = 'status err'; line.textContent = 'Could not fetch/verify the round file: ' + (e?.message || String(e)) }
}
