# Task 1.9 — `PlatformAllowlist` and `default_payout_mint`

Paste with the updated `H2E_ARCHITECTURE_v3.md` — §4 and §7.1 changed.
Do this before Task 2.0.

## The gap this fixes
`settle_epoch` takes `allowed_mints: Vec<Pubkey>` from the keeper — so the keeper
writes the list it is then checked against, and the allowlist constrains nothing.
Fix: a standing admin-maintained `PlatformAllowlist`; `settle_epoch`'s
`allowed_mints` must be a subset of it.

## Three smaller items
1. `MAX_SWAP_REMAINING=48` + 15 fixed = 63 = the ceiling, not headroom. Either drop
   to ~44 for slack, or add a compile-time assertion tying the constant to the
   instruction's fixed account count. Pick one, say which.
2. `MAX_ALLOWLIST=24` and the §7.3 electable list size must move together — make
   the relationship explicit.
3. `quoted_out` keeper-supplied accepted for v1 (residual risk documented in §7.1).

## Part A — PlatformAllowlist
PDA `["allowlist"]`, admin-maintained, bounded. `init_platform_allowlist` and
`set_platform_allowlist(mint, add)` — admin-gated, same shape as denylist, NO
init_if_needed. `settle_epoch` rejects any `allowed_mints` entry not in it. Bound
above the §7.3 electable list size; tie the two constants together.

## Part B — default_payout_mint
Field on CoinConfig, creator-chosen at launch, permanent. `launch_coin` takes it
and validates against PlatformAllowlist (never free-text). Non-electors receive it
instead of usdc_mint (round-builder change is Phase 2; the on-chain field must
support it).

## Tests
1. PlatformAllowlist init + add/remove admin-gated; keeper/unrelated rejected.
2. settle_epoch rejects an allowed_mints entry not in PlatformAllowlist — THE security test.
3. settle_epoch succeeds when every entry is a subset.
4. launch_coin with default_payout_mint in allowlist → succeeds, reads back.
5. launch_coin with mint not in allowlist → whole tx rejected.
6. Removing a mint from PlatformAllowlist does not retroactively break a launched
   coin — coin keeps its default_payout_mint on-chain; round builder falls back to
   USDC at settle if no longer permitted. Fixing history is worse than degrading.
7. launch_coin still fits its tx budget with the extra account. Report new size.

## Report back
1. Full source + raw test output.
2. Decision on MAX_SWAP_REMAINING — lower or assert.
3. How MAX_ALLOWLIST and the electable bound are tied.
4. What happens when an allowlisted mint is later removed.
5. Updated launch_coin CU and tx size.
6. Updated program size.
7. Any spec ambiguity — flag rather than guess.
