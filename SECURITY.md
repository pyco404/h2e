# H2E — security model & adversarial results

H2E is a **trusted-keeper** system (§7.1), not trustless. The program enforces the
hard invariants; the keeper decides eligibility and amounts *within* them. This
document states exactly what that means, including what a stolen keeper key can and
cannot do.

## Adversarial pass (Task 4.1 Part C)

Each attack, its outcome, and the check that stopped it. "verified" = exercised
against the real cloned DBC/cp-amm rail; "unit" = offline test.

### Payout integrity
| Attack | Outcome | Stopped by |
|---|---|---|
| Replay a `distribute_batch` after keeper restart | **failed** | `start_index != cursor` → `CursorMismatch` (epoch.ts #2, verified) |
| Batches out of order | **failed** | same cursor check (epoch.ts #3, verified) |
| Batches with gaps / overlapping ranges | **failed** | cursor must equal `start_index` exactly; a gap or overlap mismatches (epoch.ts #3 + keeper.ts resumable, verified) |
| Distribute a bucket never swapped | **failed** | `require bucket.swapped` → `BucketNotSwapped` (swap.ts) |
| Batch summing to `amount_out + 1` | **failed** | `paid_amount + Σ > amount_out` → `Overpayment` (epoch.ts #4, verified) |

### Eligibility
| Attack | Outcome | Stopped by |
|---|---|---|
| Dust-grief a wallet over 3% just before settle | **failed to grief** | aged balance = min over window, unchanged by a late raise; wallet stays eligible (aged-balance #5) |
| Buy 1 min before settle, sell right after | **failed** | aged balance ≈ 0 (window trough includes the pre-buy zero); not eligible (aged-balance #3) |
| Fund a wallet 23h59m before settle | **failed** | aged balance 0; ineligible (aged-balance #3) |
| Split a 9% position across 4 wallets | **succeeds — accepted by design** | §1.2: splitting costs separate ATAs + separate 24h clocks; each sub-3% wallet is eligible. Not a bug; a documented trade-off. |

### Routing and funds
| Attack | Outcome | Stopped by |
|---|---|---|
| Caller-chosen receiver on `claim_and_sweep` (the Phase 0 attack) | **failed** | destination pinned to the WSOL ATA of `FeeAuthority(mint)` by `associated_token` constraint (§5) — caller irrelevant |
| Elect a mint outside `PlatformAllowlist` | **failed** | rejected at submission (`ElectionError`) *and* at settle (`allowed_mints ⊆ PlatformAllowlist`) (election-api + platform-allowlist #2) |
| Settle with `allowed_mints` not a subset | **failed** | `settle_epoch` subset check → `OutMintNotAllowed` (platform-allowlist #2) |
| Route exceeding `MAX_SWAP_REMAINING` | **failed** | on-chain `remaining_accounts.len() <= 44` → `TooManySwapAccounts` (swap.ts #8) |
| Sandwich a `swap_payout` | **bounded** | see the estimate below |

### Launch
| Attack | Outcome | Stopped by |
|---|---|---|
| Append a second DBC buy after `launch_coin`, same tx, exceeding 3% | **succeeds — expected, §6** | the cap binds only inside the handler; nothing on-chain prevents a second buy on an open curve. The UI never claims an ownership ceiling — only "dev buys through H2E are capped at 3%". The 24h hold rule is the real defence. |
| Launch against a config that isn't `platform_config_key` | **failed** | `require_keys_eq!(config, platform_config_key)` → `WrongConfig` (launch_coin.ts #4, verified) |

## Sandwich cost on `swap_payout`

The keeper passes `min_out` into the Jupiter CPI, and the program requires
`min_out ≥ quoted × (1 − max_slippage_bps)` and records `amount_out` as the
**measured delta**. So:

- A sandwich that pushes execution **past** the slippage floor makes the swap
  **revert** (Jupiter enforces `min_out`) — denial, not theft; the keeper retries.
- A sandwich **within** the floor extracts at most `max_slippage_bps` of the
  bucket. At the default 1% and a $300 bucket that is **≤ ~$3 per bucket per
  round**, and in practice near zero: the measured xStock routes slip < 0.5% at
  $300 (NVDAx 0.000%, AAPLx 0.41%), so a sandwicher's own slippage + fees usually
  exceed the profit on swaps this small in pools this deep.
- The real exposure is **thin routes** — tokenised stocks when markets are closed —
  which is exactly why stocks carry a wider slippage tolerance *and* the
  market-hours warning, and why the keeper staggers epochs by `launch_ts` so swaps
  don't bunch.
- Residual, accepted for v1 (§7.1): the slippage floor uses a **keeper-supplied
  `quoted_out`**. An honest keeper is bounded as above; a compromised keeper could
  pass a low quote and accept bad execution it profits from — value lost to the
  market, never removed from the vaults. An on-chain price reference is the fix.

## Keeper-compromise enumeration

Assume the keeper hot key is stolen. This is the honest security summary.

**The attacker CAN:**
- Settle epochs and choose `total_weight` / `merkle_root` / `bucket_count`, i.e.
  **misallocate among holders** — pay the wrong wallets or wrong amounts *within* a
  bucket. This is the trusted part (§7.1). It is **detectable**: the round file and
  on-chain root publish exactly who was paid what, so a dishonest round is provable.
- Accept **bad swap execution up to `max_slippage_bps`** (the `quoted_out` residual
  above).
- **Withhold liveness** — stop settling or distributing, delaying payouts.

**The attacker CANNOT:**
- Change config or pause — those are `admin`-gated (hardware wallet), and the
  keeper key is explicitly barred (spec §9.9).
- Move funds to an **arbitrary address** — claim proceeds are pinned to
  `FeeAuthority(mint)`'s WSOL ATA; distributions go only to the derived ATAs of the
  recipients; the payout authority is a PDA with no private key.
- Route into a **non-allowlisted mint** — `swap_payout` checks the round allowlist,
  which `settle_epoch` forces to be a subset of the admin `PlatformAllowlist`.
- **Exceed `payout_amount`** (the `swapped_in` bound) or a bucket's `amount_out`
  (the per-bucket overpayment bound), or **double-pay** (the cursor).
- **Drain any vault to itself.** No instruction moves H2E-held funds to a
  keeper-chosen destination.

**Net:** a stolen keeper can misallocate within the rules and grief liveness, but
cannot steal funds out of the system or redirect them to an attacker's address. The
worst monetary loss is swap slippage plus detectable misallocation among holders.
**Mitigation:** the admin rotates the key with `set_keeper` (the keeper cannot),
and every round's allocation is auditable against the on-chain Merkle root.
