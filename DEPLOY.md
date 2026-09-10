# H2E — mainnet deploy readiness

Program: **551,832 bytes (539 KB)**, program id `6SnKPT4rQy7beCiYXsWfLNeva6oh7nH5mHhsKwJ6E2BS`
(the `declare_id!`). Built **without** `stub-jupiter`, so `JUPITER_PROGRAM` pins the
real Jupiter v6 (`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`) — confirm this
before deploying.

## 1. Deploy cost

Rent-exempt for the ProgramData account (upgradeable loader, 45-byte header +
program bytes): **≈ 3.842 SOL** (`(551877 + 128) × 3480 × 2` lamports).

- at $150/SOL ≈ **$576** · at $200 ≈ **$768** · at $250 ≈ **$960**

**Fund the deployer with ≈ 4.5 SOL.** Deploy also allocates a temporary buffer
account (~same size) that is closed and refunded on success, but the wallet must
hold both transiently, plus a few thousand lamports of tx fees. Confirm the
balance before `solana program deploy`.

## 2. Key ceremony

Three keys, never the same, per §4:

| Key | Custody | Role |
|---|---|---|
| **upgrade authority** | hardware wallet / multisig | deploys and can replace the program; signs `initialize_global` once |
| **admin** | hardware wallet | changes config, pauses. Signs rarely. |
| **keeper** | hot key, separate | settles + distributes; assume eventual compromise; **can never change config or pause** |
| **platform_wallet** | cold, separate | receives the 10% (+ $H2E pump.fun fees). Publish the address. |

Exact order (each step depends on the previous):

1. **Deploy** the program (upgrade authority pays rent). This fixes the program id
   and therefore the global `["fee"]` PDA = `pdas.feeClaimer()`.
2. **Create the DBC partner config** via Meteora with `feeClaimer` = the `["fee"]`
   PDA, and the frozen values in §3. Record the config pubkey → this is
   `platform_config_key`. A wrong `feeClaimer` here makes every launch's fees
   unrecoverable, so verify it equals `pdas.feeClaimer()` on-chain before using it.
3. **`initialize_global`** (signed by the **upgrade authority**): sets `admin`,
   `keeper`, `platform_wallet`, `platform_config_key`, `usdc_mint`, the splits and
   caps in §3. Rejects unless the three bps sum to 10000.
4. **`init_platform_allowlist`** (admin).
5. **`set_platform_allowlist`** (admin), once per mint — add the initial set (§3).
   USDC first: it is the mandatory default and every fallback target.
6. **`init_denylist`** (admin). Mutate-only thereafter.
7. Optionally transfer the upgrade authority to a multisig. `admin` can already be
   rotated later with `set_admin`.

All builders are in `client/index.ts` — nothing else encodes program data.

## 3. Config values for launch

`initialize_global` params:
```
holder_bps 6000 · h2e_bps 3000 · platform_bps 1000        (sum 10000, enforced)
dev_buy_cap_bps 300 · holder_cap_bps 300
epoch_seconds 86400 · h2e_epoch_seconds 604800
max_slippage_bps 100      (stocks routed with wider client-side tolerance; see catalog)
min_sweep_lamports        set to ~ the value of one distribute ATA rent (avoid dust rounds)
pool_creation_fee_lamports 0   (OPEN — configurable later via set_params)
h2e_mint None · revenue_distribution_enabled false   (forced by the instruction)
```

DBC partner config (frozen fee curve — do not change; it defines the 10%→2% decay):
```
creatorTradingFeePercentage 0
collectFeeMode 0 (quote only)
migrationFeeOption 2 (FixedBps100)
partnerPermanentLockedLiquidityPercentage 100
dynamicFee null
baseFee { cliffFeeNumerator 100_000_000, firstFactor 30, secondFactor 10,
          thirdFactor 522, baseFeeMode 1 }
feeClaimer = ["fee"] PDA
```

Initial `PlatformAllowlist` (each added with `set_platform_allowlist`):
```
USDC  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v   (default / fallback — required)
WSOL  So11111111111111111111111111111111111111112   (no-swap payout path)
NVDAx Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh    (quotes at maxAccounts≤40, verified)
AAPLx XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp    (quotes at maxAccounts≤40, verified)
```
Add majors (JitoSOL, etc.) only after `measure-xstock.ts`-style routing checks. The
asset catalog (off-chain) supplies names/logos and the stock market-hours warning;
it is never the source of truth for which mints are permitted.

Keeper Jupiter requests: `maxAccounts: 40`. The on-chain bound is
`MAX_SWAP_REMAINING = 48` (Task 4.2), which clears the measured 44-account worst
case; a route still over it reverts and the keeper falls back to USDC.

## 4. Rollback — reversible vs. permanent

**Reversible (admin, no upgrade):** every economic value via `set_params`; `keeper`
(`set_keeper`); `admin` itself (`set_admin`); `platform_wallet`,
`platform_config_key`, `usdc_mint`; `h2e_mint` (once, and only when set); the
`PlatformAllowlist` (add/remove) and denylist; `retire_coin`; the graduation
escape hatch `set_graduation`. Program **logic** is reversible via a program
upgrade (upgrade authority).

**Permanent — cannot be undone:**
- A coin's `default_payout_mint` and its 0% creator fee (set at launch, by design).
- The **Merkle leaf encoding** (§7.5c, now frozen). Changing it invalidates every
  historical proof — never touch it after the first mainnet round.
- Launched pools and their permanently-locked liquidity.
- A holder's aged-balance history (it is what it is).

Removing a mint from `PlatformAllowlist` does **not** retroactively break a coin
that launched with it as `default_payout_mint` (verified) — the round builder
degrades that bucket to USDC at settle.

## 5. First-hour checklist (single mainnet coin)

The first epoch is 24h, so hour one is **pre-first-settle**: watch the launch and
fee capture, not payouts.

**Watch:**
- The launch tx: `CoinConfig` created, dev buy (if any) ≤ 3% (else it reverts),
  pool created against `platform_config_key`, and the pool's `feeClaimer` = the
  `["fee"]` PDA.
- Fees accruing as **WSOL** in `FeeAuthority(mint)`'s ATA as trades happen (never
  base-token fees).
- The first `claim_and_sweep`: the 60/30/10 split lands in
  `PayoutAuthority` WSOL / `RevenueAuthority` WSOL / `platform_wallet`, and
  `total_claimed` increments. The vault is empty on return.
- Keeper cadence tiering behaving (a quiet coin isn't being cranked every minute).

**Pause if:** the split lands wrong; a claim's proceeds go anywhere but the pinned
FeeAuthority ATA; fees are not WSOL; any unexpected program error on claim; or the
keeper key shows anomalous signing.

**How to pause:** the **admin** signs `pause(paused, pause_launches)`. `paused`
freezes distribution while vaults keep draining what's owed; `pause_launches`
freezes new launches. A payout incident → `paused = true`; a rail incident →
`pause_launches = true`; both flags in one call. The keeper cannot pause.

## 6. Would not deploy without

- The build pinned to **real Jupiter v6** (no `stub-jupiter`) — the single live CPI
  is still unproven and gets validated by the first tiny mainnet swap (Task 4.1
  deferral). Keep the first coin's payout amounts small until that swap succeeds.
- The DBC config's `feeClaimer` **verified equal to `pdas.feeClaimer()`** on-chain
  before any launch.
- `min_sweep_lamports` set high enough that the first rounds aren't dust.
