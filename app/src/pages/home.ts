import { h } from './../ui'

/**
 * Home / landing — the marketing page, shown at the app root. Rendered under the
 * shared app chrome (so it reuses the logo/nav/wallet header), with its CTAs
 * routing into the console (Explore / Launch). Content mirrors site/index.html.
 */
const HTML = `
<section class="hero">
  <h1>Hold the coin. Get paid in whatever you want.</h1>
  <p class="lede">H2E is a Solana launchpad where a coin's trading fees go to the people holding it — paid out every 24 hours, in an asset each holder picks.</p>

  <div class="machine">
    <p>You hold a coin.<br>Pay me in
      <label for="asset" style="position:absolute;left:-9999px">Payout asset</label>
      <select id="asset" class="picker">
        <option value="USDC">USDC</option>
        <option value="SOL">SOL</option>
        <option value="TSLAx">tokenized Tesla</option>
        <option value="NVDAx">tokenized Nvidia</option>
        <option value="jitoSOL">jitoSOL</option>
      </select>.
    </p>
    <dl class="readout">
      <div><dt>Arrives</dt><dd>every 24h</dd></div>
      <div><dt>In your wallet as</dt><dd class="amt" id="unit">USDC</dd></div>
      <div><dt>You claim</dt><dd>nothing — it's sent</dd></div>
    </dl>
  </div>

  <div class="cta-row">
    <a class="hbtn" href="#/launch">Launch a coin</a>
    <a class="hbtn quiet" href="#/coin">Explore coins</a>
    <button class="nav" id="how-link" style="cursor:pointer">See how it works</button>
  </div>
</section>

<section id="how">
  <h2>How it works</h2>
  <ol class="steps">
    <li><div><h3>Someone launches a coin</h3><p>Through H2E, on a Meteora bonding curve. The creator takes no cut of the trading fees — not now, not ever.</p></div></li>
    <li><div><h3>The coin trades, and fees collect</h3><p>Every buy and sell pays a fee. Instead of landing in the creator's wallet, it accumulates in a vault no person can withdraw from.</p></div></li>
    <li><div><h3>Every 24 hours, it's paid out</h3><p>Each holder picks what they want to receive. The vault is swapped into those assets and sent directly to wallets. Nothing to claim.</p></div></li>
  </ol>
</section>

<section>
  <h2>Where the fees go</h2>
  <div class="split">
    <div class="bar" role="img" aria-label="Fee split: 60 percent to coin holders, 30 percent to H2E holders, 10 percent to the platform">
      <span class="b1"></span><span class="b2"></span><span class="b3"></span>
    </div>
    <div class="legend">
      <div><span class="pct">60%</span><p>To the people holding that coin</p></div>
      <div><span class="pct">30%</span><p>To $H2E holders, from every coin on the platform</p></div>
      <div><span class="pct">10%</span><p>To run the platform</p></div>
    </div>
    <p class="note">Ninety percent of every fee reaches a holder. Hold a coin and $H2E and you're in both streams.</p>
  </div>
</section>

<section>
  <h2>The rules</h2>
  <dl class="rules">
    <div><dt>Hold for 24 hours to be paid</dt><dd>Your share is based on the smallest balance you held across the day, so buying just before a payout doesn't work and selling forfeits it.</dd></div>
    <div><dt>Creators earn nothing from launching</dt><dd>No fee share. A creator can buy their own coin and earn as a holder like anyone else — that's the only way they make anything.</dd></div>
    <div><dt>Dev buys through H2E are capped at 3%</dt><dd>Enforced on-chain at launch, and optional — a creator can start with nothing at all.</dd></div>
    <div><dt>Wallets above 3% of supply are skipped</dt><dd>Payouts go to the many, not to whoever bought the most.</dd></div>
    <div><dt>Nobody can touch the vaults</dt><dd>Fees are held by the program itself. There is no wallet, no key, and no admin able to withdraw what's owed to holders.</dd></div>
  </dl>
</section>

<div class="token">
  <span class="tag">Not launched yet</span>
  <h2>$H2E</h2>
  <div class="prose">
    <p>Thirty percent of the fees from every coin on the platform goes to people holding $H2E. It's a claim on what the platform actually earns, not a promise about a price.</p>
    <p>The token doesn't exist yet. That 30% is accruing in a vault from the first coin launched, and will be distributed to $H2E holders once it does.</p>
    <p>We're not going to quote you a yield. What holders earn depends entirely on how much trading happens here, and anyone who tells you a number before that exists is guessing.</p>
  </div>
</div>

<footer class="homefoot">H2E is in development.</footer>
`

export async function renderHome(root: HTMLElement) {
  root.replaceChildren(h('div', { class: 'home', html: HTML }))
  const sel = root.querySelector('#asset') as HTMLSelectElement | null
  const unit = root.querySelector('#unit') as HTMLElement | null
  if (sel && unit) sel.addEventListener('change', () => { unit.textContent = sel.value })
  const how = root.querySelector('#how-link') as HTMLElement | null
  how?.addEventListener('click', () => root.querySelector('#how')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}
