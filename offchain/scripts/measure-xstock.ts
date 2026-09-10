/**
 * Task 1.8b/4.1 — measure whether tokenised stocks can quote WSOL→asset under the
 * swap_payout account budget. If they cannot, the maxAccounts cap silently
 * excludes assets that are half the product's appeal, and the fix is shrinking
 * SWAP_FIXED_ACCOUNTS, not raising the cap past the 64-account tx lock limit.
 *
 * Run: node offchain/scripts/measure-xstock.cjs  (bundle first, or ts-node)
 * Uses the current Jupiter API (lite-api.jup.ag); the old quote-api.jup.ag is dead.
 */
const JUP = 'https://lite-api.jup.ag/swap/v1'
const WSOL = 'So11111111111111111111111111111111111111112'
const DUMMY_USER = 'H2Exxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx111' // any valid-length pubkey; only for account layout
const MAX_ACCOUNTS = 40
const PAYOUT_SOL = 3 // ~$300 representative payout size

const STOCKS: Record<string, string> = {
  NVDAx: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
  AAPLx: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp',
}

async function measure(name: string, outMint: string) {
  const amount = PAYOUT_SOL * 1e9
  const qurl = `${JUP}/quote?inputMint=${WSOL}&outputMint=${outMint}&amount=${amount}&slippageBps=300&maxAccounts=${MAX_ACCOUNTS}`
  const q: any = await (await fetch(qurl)).json()
  if (q.error) { console.log(`${name}: NOT ELECTABLE — no route under maxAccounts=${MAX_ACCOUNTS}: ${q.error}`); return }
  const labels = (q.routePlan || []).map((h: any) => h.swapInfo.label)
  // exact account count from the built swap instruction
  let acctCount = -1
  try {
    const s: any = await (await fetch(`${JUP}/swap-instructions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quoteResponse: q, userPublicKey: DUMMY_USER, wrapAndUnwrapSol: true }),
    })).json()
    const ix = s.swapInstruction
    if (ix) {
      const alt = (s.addressLookupTableAddresses || []).length
      acctCount = ix.accounts.length
      console.log(`${name}: QUOTES under ${MAX_ACCOUNTS} · hops=${q.routePlan.length} [${labels.join(' → ')}] · impact=${(+q.priceImpactPct * 100).toFixed(3)}% · swapIx accounts=${acctCount} (ALTs=${alt})`)
      return
    }
  } catch (e) { /* fall through to route-based estimate */ }
  console.log(`${name}: QUOTES under ${MAX_ACCOUNTS} · hops=${q.routePlan.length} [${labels.join(' → ')}] · impact=${(+q.priceImpactPct * 100).toFixed(3)}% · (swap-ix account count unavailable)`)
}

;(async () => {
  console.log(`xStock routing under maxAccounts=${MAX_ACCOUNTS} at ~$${PAYOUT_SOL * 100} payout:\n`)
  for (const [name, mint] of Object.entries(STOCKS)) { try { await measure(name, mint) } catch (e: any) { console.log(`${name}: ERROR ${e.message}`) } }
})()
