# Task 1.5 â `claim_and_sweep` (bonding path)

Paste with the **updated** `H2E_ARCHITECTURE_v3.md` â Â§6's Admin section changed.

---

## Context

Task 1.4 is accepted. The audit caught a real bug â the `u128` result truncated
back to `u64` before comparison â which is precisely the class of thing that
passes every test until someone launches with an unusual supply.

**Three changes from your flags, now in the spec:**

- **Split two setters out of `set_params`.** `platform_config_key` and
  `platform_wallet` get dedicated instructions. A wrong `platform_config_key`
  means every later launch uses a config whose `feeClaimer` is not H2E's PDA and
  those fees are unrecoverable; a wrong `platform_wallet` sends the 10% to a
  stranger. Both deserve the same treatment you correctly gave `set_admin`.
- **`set_admin` stays dedicated.** Your reasoning was right.
- **Split `init_if_needed`** into an explicit one-time `init_denylist` and a
  mutate-only `set_denylist`, and **turn the crate feature off.** Your safety
  analysis was correct for this account, but the feature applies crate-wide and
  later tasks add vaults and epoch accounts where the argument is weaker.

Denylist shape is fine as built. Nothing on-chain iterates it, and being on-chain
makes the overrides publicly auditable, which Â§7.3 asks for.

## What to build

`claim_and_sweep(mint)` per spec Â§6 â **bonding path only.** The graduated path
and `sync_graduation` come in the next task.

This is the instruction the Phase 0 attack broke. Read spec Â§5 before writing it.

1. **Permissionless.** Any caller. Do not gate on the keeper â spec Â§5 explains
   why a caller allowlist is strictly worse than a constrained destination.
2. **Reject if `GlobalConfig.paused`.** Sweeping moves funds through the split, so
   it stops when distribution stops.
3. **Reject if `CoinConfig.status != Bonding`** with a distinct error. The
   graduated branch lands in Task 1.6.
4. **Derive the receiver in-instruction** as the WSOL ATA of
   `FeeAuthority(mint)`. **Reject any other destination.** This is the whole
   security property.
5. CPI DBC `claim_trading_fee`, signing as the global `["fee"]` PDA with
   `invoke_signed`.
6. Reject if the resulting balance is below `min_sweep_lamports`.
7. Split and transfer: `holder_bps` â `PayoutAuthority(mint)`'s WSOL ATA,
   `h2e_bps` â `RevenueAuthority`'s WSOL ATA, `platform_bps` â `platform_wallet`'s
   WSOL ATA.
8. Update `CoinConfig.total_claimed`.
9. **The fee ATA must be empty when the instruction returns.** Nothing left
   undivided.

### Split arithmetic â specify and test this

`u128` intermediates. Compute the holder and $H2E shares by flooring, then give
the **remainder to the platform**, so the three transfers sum to exactly the
claimed amount. Nothing lost, nothing created.

If you think a different remainder rule is better, say so with reasoning â but it
must be explicit, not emergent from integer division.

### ATA creation

The three destination ATAs are created client-side as idempotent pre-instructions
in the same transaction. **Do not create them in-handler** â that adds accounts to
an instruction that already carries two CPIs, and transaction size is the binding
constraint.

## Tests

Every state-writing test asserts on-chain readback.

1. **Happy path.** Generate real fees against the cloned DBC pool, sweep, and
   assert all three destinations received exactly the expected amounts.
2. **The attack test â the important one.** Re-run the Phase 0 attack against this
   program: a caller supplying their own receiver. It succeeded in Phase 0 and
   **must fail here.** Assert the specific error.
3. **Permissionless works.** An unrelated wallet, unconnected to admin or keeper,
   successfully sweeps â and the funds still land in the correct vaults.
4. Balance below `min_sweep_lamports` â rejected.
5. `paused = true` â rejected.
6. `status != Bonding` â rejected with the distinct error.
7. `total_claimed` increments by exactly the claimed amount.
8. Fee ATA balance is exactly 0 after the sweep.
9. **Rounding.** Pick a claimed amount that does not divide evenly by 60/30/10.
   Assert the three transfers sum to exactly the claimed amount, and state where
   the remainder went.

Tests 2 and 9 are the ones I care most about. Test 2 is the security property
this whole design turns on. Test 9 is where value silently disappears if the
arithmetic is sloppy.

## Report back

1. Full source and raw test output.
2. **How the receiver constraint is enforced** â the exact check, and your
   argument for why no caller-supplied account can reach the CPI.
3. The remainder rule, and the figures from test 9.
4. CU and serialized transaction size for the sweep path, with and without the
   ALT.
5. Updated program size.
6. Any spec ambiguity â flag rather than guess.

No graduated path, no `sync_graduation`, no epoch instructions, no keeper.
