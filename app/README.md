# H2E app —

A **scaffold**, not a working product. The launch flow is real and works
end-to-end against a chain that has the program deployed; every other screen is
structure with **honest empty states**, because the payout data it would show
needs the keeper and indexer, which don't exist yet.

## Stack, and why

Framework-free **TypeScript bundled with esbuild**, wallet via the injected
`window.solana` provider.

- **No React / Vite / wallet-adapter.** They aren't installed and can't be
  fetched (this environment has no npm egress). `esbuild`, `@solana/web3.js` and
  `@coral-xyz/anchor` *are* present, so a no-framework TS app is what actually
  builds here — and it mirrors the landing page's own self-contained approach.
- **It imports `../h2e/client` directly.** Nothing in this app encodes program
  data; every instruction and every account decode goes through the audited
  `client/index.ts` (the module that exists because Anchor's TS client silently
  serialized fields as zeros — Task 1.1b). Building the app surfaced one more
  reason that module has to be the single encoder: its round-trip guard caught a
  `PublicKey instanceof` fragility that only appears once the client is *bundled*,
  and the fix lives in `client/index.ts` where both the tests and the app get it.
- **Wallet via the injected provider.** Phantom/Backpack expose `window.solana`
  with `signAndSendTransaction` for versioned transactions — no adapter package
  needed.

## Run

```bash
cd app
npm run dev      # esbuild serve + watch on http://localhost:5178
# or
npm run build    # one-shot bundle to dist/bundle.js, then serve index.html any way you like
```

RPC endpoint defaults to a **local validator** (`http://127.0.0.1:8899`) — the
only target reachable offline. Override with `?rpc=<url>` (persisted to
localStorage), e.g. `http://localhost:5178/?rpc=https://api.devnet.solana.com`.

For the launch flow to succeed the chain must have: the H2E program deployed,
`initialize_global` run, and `PlatformAllowlist` initialized with at least one
payout mint. The `h2e/scripts/launch-test.sh` harness sets exactly this up
(cloning the Meteora DBC rail), which is what the launch flow targets.

## Screens

- **Launch** (`#/launch`) — real. Wallet connect → form (name, symbol, metadata
  URI, optional dev buy, **default payout asset** from the on-chain
  `PlatformAllowlist`) → **Preview** (assembles the tx via the client, shows
  account/ALT counts, submits nothing) → **Launch** (creates the ALT, then sends
  `launch_coin`; the fresh mint partial-signs, the wallet pays).
- **Coin** (`#/coin/:mint`) — real `CoinConfig` (status, default payout asset,
  launch time, epoch, claimed/paid totals). Fees accrued / next payout / holders /
  payout history are **empty states** — they need the keeper + indexer.
- **Election** (`#/coin/:mint/election`) — the per-round asset picker, populated
  from the allowlist, showing the coin's default and what overriding means.
  Submission is an empty state: elections are off-chain signed messages (§7.6) and
  the election API isn't built.
- **Round** (`#/round/:mint/:epoch`) — the §7.1 trust story. Shows the on-chain
  `EpochState`/`AllowlistState` anchor (frozen payout, Merkle root, buckets) when a
  round is settled, and the fixed structure of the round-builder inputs as empty
  states otherwise.

## Design

Carries the landing page's language: pale sage paper, forest ink, **marigold =
an amount of money** (`.amt`), **ultramarine = a choice the holder/creator makes**
(`.choice`, and the payout picker). Source Serif 4 body, Archivo headings/figures.

## Not built here

The keeper. Any payout figure. No mocked numbers anywhere — an empty state that
says *what* will appear and *why* it isn't there yet, never a placeholder.
