# H2E â Architecture Specification (v3)

**Hold to Earn.** A Solana launchpad where a coin's trading fees are paid to its
holders every 24 hours, in an asset each holder elects.

Supersedes v1 and v2 entirely. v1 was written against pump.fun; v2 against
Meteora DBC before Phase 0. **This version incorporates four devnet feasibility
runs and every finding is verified on-chain unless marked otherwise.** Do not
carry anything over from earlier versions.

**OPEN** = deliberate open decision. **UNVERIFIED** = not confirmed on-chain.

---

## 1. Product rules

| Rule | Value |
|---|---|
| User coin rail | Meteora DBC (H2E is the partner) |
| $H2E token rail | pump.fun â outside this system entirely (Â§10) |
| Creator's fee share | 0% (`creatorTradingFeePercentage = 0`) |
| Creator dev buy | Optional, capped at 3% of supply. Zero is valid. |
| Fee split | 60% coin holders / 30% $H2E holders / 10% platform |
| Payout cadence | Every 24h per coin, staggered by `launch_ts` |
| Eligibility | Aged balance held â¥24h, still held at payout, â¤3% of supply |
| Payout asset | Elected per holder per round; USDC default |
| Electable set | Programmatic (Jupiter volume + route depth), snapshotted per round |
| Pool creation fee | 0 initially, configurable (**OPEN**) |
| Fee curve | 10% â 2% over 300s, exponential |
| Fee collection | Quote-only (WSOL). Base-token fees never accrue. |

### 1.1 Aged balance

A wallet's **aged balance** at time `t` is the **minimum** balance held at any
point in `[t â 24h, t]`.

- By construction, the amount held continuously for 24 hours.
- Partial sells reduce it correctly.
- Recently received tokens cannot raise it, so dust-grief against the 3%
  threshold does nothing.

**Both** eligibility and payout weight use aged balance. Never current balance.

### 1.2 The 3% exclusion

`aged_balance / mint.supply > 3%` â excluded entirely for that round, not capped.

Accepted deliberately: sybil-defeatable (splitting still costs separate token
accounts and separate 24h clocks). The cliff would normally be griefable by dust
transfer; aged balance neutralises that, which is the only reason a cliff is safe
here.

Does **not** apply to the $H2E round (Â§8).

---

## 2. Do not build: counter/stamp accounting

An early sketch proposed counter/stamp accounting (one number per round; share =
`counter â stamp`). **It does not apply.** That pattern needs every recipient to
receive an *equal* share; H2E pays pro rata by variable balance with weights
changing every epoch.

The unbounded-loop problem is solved by batched, resumable pushes with an
on-chain cursor (Â§6, `distribute_batch`).

---

## 3. The rail â verified behaviour

Program IDs (devnet-verified):

| Program | ID |
|---|---|
| DBC | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| DAMM v2 (cp-amm) | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |

### 3.1 Established on devnet

**One config key serves every pool.** `config.fee_claimer` is per-config;
`partner_quote_fee` is per-pool. A single global `["fee"]` PDA is the fee claimer
for all launches, and claiming pool A moves only A's fees. **Per-launch config
keys are unnecessary** â this was verified across three pools on one config.

**`fee_claimer` is a required signer.** Non-signer fails with `AccountNotSigner`
(3010). Claims must be a CPI with `invoke_signed` from the H2E program. The guard
is `#[access_control(is_partner_fee_claimer(...))]` in DBC's `lib.rs`, not in the
instruction file â reading the instruction file alone is misleading.

**Claim destinations have no owner constraint.** `token_a_account` /
`token_b_account` carry only `#[account(mut)]`. Anyone who can invoke a claim
instruction with a caller-supplied receiver can redirect the funds anywhere â
**demonstrated by a successful attack on devnet.** See Â§5.

**Fee split at the rail is 80/20.** `PROTOCOL_FEE_PERCENT = 20` is taken off the
top; H2E receives 100% of the remaining partner share. Observed exactly:
11,376,000 partner / 2,844,000 protocol.

**Quote-only holds end to end.** `collectFeeMode = QuoteToken(0)` during bonding;
`migratedCollectFeeMode` maps via `to_dammv2_collect_fee_mode` to DAMM v2
`OnlyB(1)`. `partner_base_fee` never accrued in any run. **H2E only ever handles
WSOL.**

**Graduation is detectable.** `migration_progress` (u8 on the virtual pool):
0 PreBondingCurve â 1 PostBondingCurve â 2 LockedVesting â 3 CreatedPool.
- Curve complete, needs migration: `quote_reserve >= config.migration_quote_threshold`
- Migrated, switch to LP-fee claims: `is_migrated == 1` (`migration_progress == 3`)

**Post-graduation fees are claimable by the same PDA.** Migration mints a locked
position whose NFT authority is `config.fee_claimer` â the global PDA. It claims
via cp-amm `claim_position_fee` (disc `[180,38,154,17,133,33,162,211]`, no args)
with the PDA as account 10 (`owner`, signer). Verified: 1,839,870 lamports WSOL
claimed via CPI.

**Migration is automated on mainnet, and permissionless.** Meteora runs
auto-migrator keepers on mainnet only (hence the manual step on devnet).
`migration_damm_v2` has no access control, so H2E can run its own migration crank
as fallback if Meteora's is delayed. **UNVERIFIED:** mainnet keepers reportedly
enforce a minimum migration threshold â confirm against Meteora's `dbc-keeper`
before choosing production thresholds.

**Program-created pools with an atomic capped dev buy fit comfortably.**
`launch_coin` CPIs pool creation with the config pinned via
`require_keys_eq!(config, PLATFORM_CONFIG)`, then optionally swaps for the dev
buy. Measured: 179k CU (of 1.4M) and 910 bytes (of 1232) for create+buy.
**No sysvar introspection is needed.**

### 3.2 Gotchas â carry these into the build

**`Position.fee_b_pending` reads 0 between interactions even when fees are
claimable.** It is only checkpointed on interaction; accrued fees live in the
pool's fee-per-token accumulator. **A keeper must not poll this field to decide
whether to claim.** Compute from pool fee growth, or attempt the claim and accept
occasional no-ops. This is the single most surprising finding of Phase 0.

**Position NFTs are Token-2022**, not classic SPL. Affects reading the NFT
account owner and any ATA handling.

**Migration is two instructions:** `migration_damm_v2_create_metadata` then
`migration_damm_v2`. SDK v1.5.11 has no wrapper for the metadata step. Two locked
positions are minted (partner + creator).

**Post-migration fee comes from the DAMM v2 config preset**
(`migrationFeeOption: 2` â FixedBps100), **not** `config.migratedPoolFeeBps`,
which reads 0 unless the Customizable option is used.

**DBC exact-input swaps reject overshoot near curve completion**
(`require!(amount_left == 0)` â `InsufficientLiquidity`). Use `swap2` in
PartialFill mode to top a curve exactly to threshold.

**Transaction size is the tighter constraint, not compute.** 910 B is 74% of the
legacy limit while CU is at 13%. `launch_coin` will add `CoinConfig`, the platform
wallet, and possibly a creation-fee transfer. **Build on versioned transactions
with an address lookup table from the start** rather than discovering the ceiling
mid-build.

### 3.3 Launch config

One global partner config key, plus a small fixed number of preset configs if
multiple fee curves are offered later. **Never one per coin.**

```
feeClaimer:                              global ["fee"] PDA
creatorTradingFeePercentage:             0
collectFeeMode:                          0  (quote only)
migrationFeeOption:                      2  (100bps)   // OPEN
partnerPermanentLockedLiquidityPercentage: 100
dynamicFee:                              null
baseFee: {
  cliffFeeNumerator: 100_000_000,  // 10%, denominator 1e9
  firstFactor:  30,                // numberOfPeriods
  secondFactor: 10,                // periodFrequency, seconds
  thirdFactor:  522,               // reductionFactor
  baseFeeMode:  1                  // exponential
}
```

Decay: 10% â 7.26% at 60s â 5.27% at 120s â 3.82% at 180s â 2.00% at 300s, flat
after. Discrete steps on completed periods, not continuous.

`dynamicFee: null` keeps these exact; otherwise up to 20% is added on top.

**100% permanent lock is deliberate.** The liquidity came from the curve, not
H2E's capital. Permanent liquidity plus perpetual fee claim is a better trust
position than retaining withdrawal rights. **Confirm the creator's minted
position is empty** â creators earn nothing.

**The fee curve does not deter snipers.** Break-even at 10% is an 11% move. The
24h hold rule does the filtering; the curve is mostly revenue, and snipers' fees
flow to holders who stay. The floor matters more than the cliff.

**H2E is the expensive option.** pump.fun's curve is 1.25% total; H2E's steady
state is 2%. Real friction for launchers and traders. Defensible because fees
return to holders. **OPEN** â revisit against observed conversion.

---

## 4. Accounts

### `GlobalConfig` â seeds `["global"]`

```
admin: Pubkey                        // hardware wallet, signs rarely
keeper: Pubkey                       // hot key, cranks only
platform_wallet: Pubkey              // receives the 10%
platform_config_key: Pubkey          // the DBC partner config
h2e_mint: Option<Pubkey>             // None until $H2E launches
revenue_distribution_enabled: bool    // false until h2e_mint is set
usdc_mint: Pubkey
holder_bps: u16                      // 6000
h2e_bps: u16                         // 3000
platform_bps: u16                    // 1000
dev_buy_cap_bps: u16                 // 300
holder_cap_bps: u16                  // 300
epoch_seconds: i64                   // 86400
h2e_epoch_seconds: i64               // 604800
max_slippage_bps: u16
min_sweep_lamports: u64
pool_creation_fee_lamports: u64      // 0 initially
paused: bool
pause_launches: bool
bump: u8
```

**Every split and fee value lives here.** Never a constant in code. Migrating
`admin` to a multisig later must remain a config change, not an upgrade.

### Key separation â non-negotiable

- **`admin`** â hardware wallet. Changes config, pauses. Signs rarely.
- **`keeper`** â hot key. Settles and distributes. Thousands of signatures daily;
  assume eventual compromise. Must **not** change config or pause.
- **`platform_wallet`** â cold. Receives the 10% and, separately, $H2E's pump.fun
  fees. Publish the address.

### `CoinConfig` â seeds `["coin", mint]`

```
mint: Pubkey
dbc_pool: Pubkey
damm_pool: Option<Pubkey>
locked_position: Option<Pubkey>
creator_wallet: Pubkey          // informational; earns nothing
default_payout_mint: Pubkey     // creator's pairing choice, permanent, from the allowlist
launch_ts: i64
current_epoch: u32
total_claimed: u64
total_paid_out: u64
status: enum { Bonding, Graduated, Retired }
bump: u8
```

### Vaults â PDA authorities owning WSOL token accounts

Fees arrive as WSOL, not native lamports. **Each PDA below is an *authority*, not
a token account.** The actual holdings are associated token accounts owned by
that authority â which allows a payout authority to own several ATAs, one per
elected asset, without further derivation logic.

| PDA | Seeds | Role |
|---|---|---|
| `FeeClaimer` | `["fee"]` | **Global.** DBC `feeClaimer`. Signs all claims. Owns locked positions. |
| `FeeAuthority` | `["vault", mint]` | Authority over the per-coin WSOL ATA holding claimed fees pre-split |
| `PayoutAuthority` | `["payout", mint]` | Authority over the 60%: a WSOL ATA pre-swap, plus one ATA per elected asset |
| `RevenueAuthority` | `["revenue"]` | Global. Authority over the 30% accruing for $H2E holders |

The claim receiver constrained in Â§5 is the **WSOL ATA of `FeeAuthority(mint)`**,
derived in-instruction.

The 10% transfers straight to `platform_wallet` at sweep â no vault, nothing to
withdraw later.

### `EpochState` â seeds `["epoch", mint, epoch_index.to_le_bytes()]`

```
mint: Pubkey            // Pubkey::default() for the $H2E round
epoch_index: u32
start_ts / end_ts: i64
payout_amount: u64      // WSOL frozen at settle, before any swap
swapped_in: u64         // running Î£ of buckets' amount_in â bounds swap_payout exactly
total_weight: u128
merkle_root: [u8; 32]
bucket_count: u16
buckets_complete: u16
settled: bool
bump: u8
```

### `BucketState` â seeds `["bucket", mint, epoch_index.to_le_bytes(), out_mint]`

**Holders elect different payout assets, so a round is several buckets and each
settles separately.** A single `payout_amount` in WSOL cannot bound distribution
once the vault holds several different mints â the overpayment check has to be
per-asset.

```
epoch: Pubkey
out_mint: Pubkey
amount_in: u64          // WSOL spent on this bucket
amount_out: u64         // tokens received, frozen after the swap
recipient_count: u32
cursor: u32
paid_amount: u64
swapped: bool
complete: bool
bump: u8
```

`EpochState` is complete when `buckets_complete == bucket_count`. The sum of all
buckets' `amount_in` must equal the epoch's `payout_amount` â nothing left
unswapped, nothing double-spent.

### `AllowlistState` â seeds `["allow", mint, epoch_index.to_le_bytes()]`

The round's snapshotted electable mints, written at settle. `swap_payout` rejects
any `out_mint` not in it.

Chosen over a Merkle root deliberately: a root would need a proof passed into an
instruction already fighting the 64-account lock limit. An explicit bounded list
costs rent per round and caps list length, but needs no per-swap proof and is
publicly auditable. The elected set per round is tens of mints, so the bound is
comfortable.

The keeper is trusted for eligibility (Â§7.1) but must not be able to route funds
into an arbitrary mint. This is what stops it.

---

## 5. The security lesson from Phase 0

The devnet attack succeeded because the test program accepted a **caller-supplied
receiver**. DBC's own check gates who signs as claimer, not who invokes the H2E
program.

**The fix is to constrain the destination, not the caller.**

Derive the receiver inside the instruction as the **WSOL ATA of
`FeeAuthority(mint)`** and reject anything else. Then the caller does not matter â an attacker can trigger a claim, but the
funds land in the correct vault regardless.

This makes claiming **permissionless and safe**, which restores the "anyone can
crank" property lost when moving off pump.fun. Keeper liveness then only matters
for distribution, not for fee capture.

**Do not gate claims by keeper authority.** A caller allowlist is strictly worse:
it adds a liveness dependency without adding safety.

---

## 6. Instructions

Each lists **every** check. Add no discretion; omit nothing.

### `initialize_global(params)`
- Signer = upgrade authority.
- Reject if `holder_bps + h2e_bps + platform_bps != 10_000`.
- `h2e_mint = None`, `revenue_distribution_enabled = false`.

### `launch_coin(name, symbol, uri, dev_buy_lamports)`
Single instruction, atomic. **No sysvar introspection.**

- Reject if `pause_launches`.
- CPI DBC pool creation using `GlobalConfig.platform_config_key`, pinned with
  `require_keys_eq!`. A creator cannot launch against another config.
- If `dev_buy_lamports > 0`: create the dev ATA in-instruction, CPI the swap,
  measure the **balance delta** on that ATA, and reject if it exceeds
  `dev_buy_cap_bps` of `mint.supply` read from the freshly created mint.
- Zero dev buy passes.
- Collect `pool_creation_fee_lamports` from the **launching payer** via a system
  transfer to `platform_wallet` if non-zero.
- Create `CoinConfig` with `launch_ts = clock.unix_timestamp`.

**The cap is not gameable from inside the instruction:** supply is read from the
mint DBC just created and fully minted in this same instruction, acquisition is a
delta on an ATA created in-instruction (so `before` is provably 0 â the mint does
not exist beforehand, so the ATA cannot be pre-funded), and no caller-supplied
amount enters the check. **All cap arithmetic must use `u128` intermediates or
checked math** â silent wraparound on the one check protecting the cap is
unacceptable, and DBC allows configurable supply and decimals large enough to
overflow `u64` when multiplied by bps.

**Accepted limitation â state this precisely.** The cap binds only what happens
*inside this handler*. The caller builds the transaction and can append a second
DBC swap after `launch_coin` in the same transaction, or buy from other wallets
at any time. That is atomic and undetectable, and nothing on-chain can prevent it
on an open curve. The 24h hold rule is the real defence, since dumping forfeits
the payout entirely.

**Consequence for copy â binding.** The site may say **"dev buy through H2E is
capped at 3%."** It may **never** say "creators hold at most 3%", or anything
implying an enforced ownership ceiling. The first is true; the second is false
and would be found out.

### `claim_and_sweep(mint)` â permissionless
- Derive the receiver as the **WSOL ATA of `FeeAuthority(mint)`**. **Reject any
  other destination.**
- CPI DBC `claim_trading_fee` (bonding) or cp-amm `claim_position_fee`
  (graduated), signing as the global `["fee"]` PDA with `invoke_signed`.
- Reject if the resulting balance is below `min_sweep_lamports`.
- Transfer `holder_bps` â `PayoutAuthority(mint)`'s WSOL ATA, `h2e_bps` â
  `RevenueAuthority`'s WSOL ATA, `platform_bps` â `platform_wallet`.
- Update `CoinConfig.total_claimed`. Vault empty on return.

### `settle_epoch(mint, epoch_index, total_weight, merkle_root, bucket_count)`
Keeper-signed.
- Reject before `epoch_end`, or if `EpochState` exists for this index.
- Snapshot and freeze `payout_amount` from the `PayoutAuthority` WSOL ATA
  balance. Fees arriving after settlement belong to the next epoch.
- `buckets_complete = 0`, `settled = true`.

### `swap_payout(mint, epoch_index, out_mint, amount_in, min_out)`
Keeper-signed, one call per elected-asset bucket. Creates that bucket's
`BucketState`.
- Reject if the epoch is not `settled`, or if this bucket is already `swapped`.
- Reject `out_mint` not in the round's snapshotted allowlist.
- Reject if `Î£ amount_in` across this epoch's buckets would exceed
  `payout_amount`.
- Reject `min_out < quoted Ã (1 â max_slippage_bps)`.
- CPI to the allowlisted Jupiter program only.
- Record `amount_out` as the **measured balance delta, not the quote**, and
  freeze it. Set `swapped = true`.

For `out_mint == WSOL`, no swap is needed: `amount_out = amount_in`.

### `distribute_batch(mint, epoch_index, out_mint, recipients[], amounts[])`
Keeper-signed, 10â15 recipients per transaction. Operates on one `BucketState`.
- Reject if the bucket is not `swapped`, or already `complete`.
- Reject if batch start index != `cursor`. Strict ordering makes double-payment
  structurally impossible.
- Reject if `paid_amount + Î£ amounts > amount_out` â **the per-bucket bound, in
  the bucket's own mint.**
- Advance `cursor`; at `recipient_count`, set `complete` and increment the
  epoch's `buckets_complete`.

Recipients ordered ascending by pubkey, so the cursor alone makes it resumable
after any failure â no bitmap.

### `sync_graduation(mint)` â permissionless
- Read `migration_progress` / `is_migrated` from the DBC pool.
- On `is_migrated == 1`, set `status = Graduated` and record `damm_pool` and
  `locked_position`, so `claim_and_sweep` switches claim paths.

### `settle_h2e_epoch` / `distribute_h2e_batch`
Same machinery against `RevenueAuthority`'s vault and the $H2E holder set (Â§8).

### Admin

All gated on `GlobalConfig.admin`, never the upgrade authority â only
`initialize_global` uses that.

| Instruction | Scope |
|---|---|
| `set_params` | Economic and cadence values only: the three bps, caps, epoch lengths, slippage, sweep floor, creation fee |
| `set_admin` | Admin transfer. Dedicated so it cannot happen by accident alongside a params change |
| `set_keeper` | Keeper key only |
| `set_platform_wallet` | Dedicated â a wrong value sends the 10% to a stranger |
| `set_platform_config_key` | Dedicated â a wrong value means every later launch uses a config whose `feeClaimer` is not H2E's PDA, and those fees are unrecoverable |
| `set_usdc_mint` | Dedicated â it is the default payout asset for every non-elector, and most holders will not elect. A wrong value pays the majority of every round in an arbitrary mint. |
| `set_h2e_mint` | Sets the mint and may enable distribution. **Enabling while the mint is `None` must be rejected.** |
| `pause` | Sets `paused` and `pause_launches` â separate flags, one call |
| `retire_coin` | Sets `status = Retired`. Blocks new fee capture; does **not** block distribution of funds already in the vaults â holders keep what they are owed |
| `set_graduation` | Admin override for `status`, `damm_pool` and `locked_position`. Escape hatch: `sync_graduation` is permissionless, one-way, and reads raw byte offsets from DBC and cp-amm. If Meteora shifts a layout, a caller could record garbage into permanent state and that coin could never claim again. |
| `init_denylist` / `set_denylist` | Explicit one-time init, then mutate-only. **Do not use `init_if_needed`** â enabling it applies crate-wide and later accounts have weaker safety arguments. |

`paused` gates distribution; `pause_launches` gates new launches. The split is
deliberate: a rail incident should halt launches while payouts drain existing
vaults, and a payout incident should freeze distribution while launches continue.
One flag cannot express either.

---

## 7. Off-chain (Node)

`@meteora-ag/dynamic-bonding-curve-sdk`, Jupiter API, Helius for the transfer
stream and RPC. **Use a paid RPC â public devnet cost real time in Phase 0.**

### 7.1 Trust boundary â state this publicly

**The program enforces:** the split, the dev-buy cap, the claim destination, no
double-payment, no overpayment past the settled amount, swap venue and slippage
limits.

**The keeper decides:** who is eligible and for how much.

H2E is a **trusted-keeper** system, not a trustless one. Do not market it
otherwise. Mitigation is verifiability: publish every round's inputs and anchor
each round with an on-chain Merkle root so any holder can verify their own amount.

### 7.2 Indexer
- Stream SPL transfers per tracked mint.
- Maintain per-wallet history sufficient for a rolling 24h **minimum**.
- Exclude by address: DBC virtual pool, DAMM pool, burn address, all H2E vaults,
  admin denylist.

### 7.3 Electable asset list
- **Reject any mint with a live freeze authority first** â it can lock the token
  accounts H2E just paid into. This check precedes volume.
- Then Jupiter 24h volume **and route depth at representative payout size**.
  Volume alone is wrong: high volume can still slip badly on a $300 swap out of
  one thin pool.
- Manual denylist overrides (honeypots, transfer-tax tokens). Publish reasoning.
- **Pin a tokenised-stock section** with wider slippage tolerance â they will not
  survive a pure volume filter and are much of why the audience is here. Warn in
  the UI that stock routes thin when markets close.
- **Restrict v1 to classic SPL Token mints.** A Token-2022 payout asset would need
  `get_associated_token_address_with_program_id` throughout, in instructions
  already at the account ceiling. Revisit once the payout path has headroom.
- **Cap route complexity.** Request Jupiter quotes with a bounded `maxAccounts`
  (~40). The binding limit on `swap_payout` is the 64-account transaction lock
  limit, not bytes â ALTs compress size but every distinct account still counts.
  A complex multi-hop route exceeds 64 and cannot fit at any size. An asset that
  cannot quote under the cap is not electable.
- **Snapshot the list at round start.** Elections resolve against the snapshot,
  written on-chain as `AllowlistState`.
- If a route degrades past the cap mid-round, that bucket falls back to USDC.
  **Document this before launch** so it does not look like a bug.

**The creator's pairing choice.** `CoinConfig.default_payout_mint` is set at
launch and is permanent â a creator who could change it after people bought in
would be a rug of a different shape. It must come from the same allowlist as
holder elections, never a free-text mint, or a creator could point the majority
of their holders' fees at their own illiquid token. Non-electors receive it
instead of `usdc_mint`; if it is unroutable at round time, that bucket falls back
to USDC like any other.

### 7.4 Round builder
1. Freeze block height at `epoch_end`.
2. Aged balance per wallet (Â§1.1).
3. Drop excluded addresses, zero balances, and anything over 3%.
4. Bucket by elected asset; USDC for non-electors.
5. `share_i = aged_i / Î£ aged`.
6. Drop shares below ~0.002 SOL of ATA rent â sending costs more than the share.
   Rolls into the next round; nothing lost. Once a holder's ATA exists they are
   paid every round after, however small.
7. Sort by pubkey ascending; build the Merkle root.

Two runs over the same block range must produce byte-identical output.

### 7.5 Keeper cadence

| Job | Cadence |
|---|---|
| `claim_and_sweep` (bonding) | Threshold-gated, checked every 1â5 min |
| `claim_and_sweep` (graduated) | Scheduled attempts â see below |
| `sync_graduation` | Poll `migration_progress` per bonding coin |
| `settle_epoch` | Per coin at its own boundary |
| `swap_payout` | After settle, one per bucket |
| `distribute_batch` | Until cursor completes |
| Migration crank (fallback) | Only if Meteora's keeper is delayed |
| $H2E round | Weekly **and** above a vault threshold (Â§8) |

**Post-graduation claims cannot be threshold-gated the same way.**
`Position.fee_b_pending` is unreliable between interactions (Â§3.2). Either
replicate the fee-growth math off-chain from the pool accumulator minus the
position checkpoint, or attempt claims on a schedule and absorb no-op fees. The
math is deterministic and preferable; scheduled attempts are the fallback.

**Gate bonding claims on accrued value, not a fixed interval.** Tier by activity:
hot coins every minute, quiet every 15, dormant hourly. A coin earning nothing
costs nothing.

**Stagger epochs by `launch_ts`.** If every coin settles at 00:00 UTC, every swap
hits Jupiter in the same minute and H2E eats the slippage.

### 7.6 Election API
- Wallet signs `{mint, epoch_index, out_mint, nonce}`; verify and store.
- On-chain election accounts would cost rent per holder per coin. Off-chain is
  correct.
- Non-electors default to USDC â silently, permanently, no rollover.

---

## 8. The $H2E round

$H2E **does not exist yet.** The 30% accrues in `RevenueAuthority`'s WSOL ATA from day one and
distributes nothing until `h2e_mint` is set and `revenue_distribution_enabled`.

**Say this on the site.** "The $H2E share is accruing and will be distributed once
the token launches" is fine. Silence is not.

Once live:
- Same eligibility: 24h aged balance, still holding.
- **No 3% exclusion** â do not exclude the platform's largest supporters from its
  core value accrual.
- Holders elect from the same asset list, USDC default. Same rule for every coin.
- **Weekly, and only above a vault threshold.** A round paying 5,000 wallets $0.30
  costs more in fees than it distributes. Trigger on size, not the calendar.

**Expectation setting.** At a 2% steady-state fee, H2E receives 1.6% of volume
(after the rail's 20%); the $H2E share is 30% of that, ~0.48% of platform volume.
$10M weekly volume is ~$48,000 to $H2E holders. Real, but not large early.
Market it as "$H2E earns from every coin on the platform" â **never as a yield
figure.** People promised a lot who earn $0.30 leave and do not come back.

---

## 9. Must not do

1. **No unbounded loops over holders** in a single instruction.
2. **No counter/stamp accounting** (Â§2).
3. **No keypair custody.** Every vault is a PDA.
4. **No caller-supplied claim destinations.** Derive and constrain (Â§5).
5. **No hardcoded splits or fee constants.** Read `GlobalConfig`.
6. **No paying to unvalidated mints.** Freeze-authority check first.
7. **No unbounded CPI targets.** Jupiter, DBC and cp-amm allowlist only.
8. **No current-balance eligibility.** Aged balance only.
9. **The keeper key must never change config or pause.**
10. **No polling `Position.fee_b_pending`** to decide whether to claim (Â§3.2).
11. **No pump.fun code paths.** $H2E is outside this system (Â§10).
12. **No per-coin DBC config keys.** One global config (Â§3.1).
13. **No code carried over from the Phase 0 throwaway program.** Findings only â
    start clean. Note that ~240 KB is the Anchor framework floor for any program,
    verified in Phase 1; size discipline means not accreting unrelated
    instructions, **not** chasing a small binary. Do not treat program size as a
    reason to drop Anchor.
14. **No unchecked arithmetic on any value that gates a rule or moves funds.**
    `u128` intermediates or checked math. A silent wraparound in a cap or a split
    is a exploitable bug, not a rounding detail.
15. **No NFTs.** Out of scope.
16. **No mainnet deploy before a full devnet round** with â¥50 synthetic holders
    including a mid-distribution keeper crash and resume.

---

## 10. $H2E on pump.fun â outside this system

$H2E launches as an ordinary pump.fun coin with `platform_wallet` as creator. Its
fees are shared with pump.fun per their schedule; the creator share is platform
income.

**It never touches the H2E program.** No PDA, no registration, no split, no
payout logic. Claiming is a standalone script calling pump's permissionless
`collect_creator_fee`. Build nothing for it inside the program.

---

## 11. Remaining unverified

1. Mainnet migration-threshold minimum enforced by Meteora's keepers â confirm
   against `dbc-keeper` before choosing production thresholds.
2. Creator's minted locked position is empty at
   `partnerPermanentLockedLiquidityPercentage = 100`.
3. Jupiter CPI within H2E's compute and size budget alongside distribution.
4. Whether transaction size holds once `launch_coin` carries `CoinConfig` and the
   platform wallet â build on versioned transactions with an ALT from the start.

---

## 12. Positioning

**"90% of every fee goes to holders."** 60% to the coin's holders, 30% to $H2E
holders, 10% to the platform. Accurate, and stronger than leading with 60%.

**"Every holder picks their payout."** Pairz, StonkFun and OTC all fix the asset
at launch, chosen by the creator. H2E is the only one where the holder chooses,
per round. Competitors cannot retrofit it â their splits are permanent by design.

**Say plainly that creators earn nothing.** Fees go to holders; the creator earns
only by buying and holding, dev buy optional and capped at 3%. If someone launches
expecting otherwise and finds out later, that is the complaint that follows the
platform around. Headline, not fine print.
