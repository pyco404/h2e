# Task 1.4 â Admin instructions, and two fixes to `launch_coin`

Paste with the **updated** `H2E_ARCHITECTURE_v3.md` â Â§6 and Â§9 changed.

---

## Context

Task 1.3 is accepted, with two required fixes below. The ALT justified itself
(995 B â 569 B) and cloning DBC into a local validator was the right call.

**Your ambiguities, answered:**

- **Creation fee from the payer** â correct. Now stated in Â§6.
- **Admin instructions needed sooner** â good catch, and I am reordering the plan
  because of it. This task is admin, ahead of `claim_and_sweep`.
- **PascalCase enum decode** â noted. Keeper and frontend match on
  `Object.keys(status)[0]`.
- **WSOL wrap as a client pre-instruction** â leave it. You are right that pulling
  it in-handler adds CPIs for no security gain.

## Part A â two fixes to `launch_coin`

### A1. Checked arithmetic on the cap

`supply * dev_buy_cap_bps / 10_000` is safe at 1e15 supply but DBC allows
configurable supply and decimals. At 1e19 base units, `supply * 300` exceeds
`u64`. Use a `u128` intermediate or `checked_mul`, and `checked_sub` for
`after - before`.

Silent wraparound in the one check protecting the cap is not acceptable. Spec Â§9
now prohibits unchecked arithmetic on anything that gates a rule or moves funds â
**audit the rest of the program against that rule while you are in there.**

Add a test with a supply large enough that the naive `u64` multiplication would
overflow, proving the check still holds.

### A2. Nothing else about the cap changes

Your delta analysis was right and in fact stronger than you stated: the mint is
created inside the instruction, so the ATA cannot be pre-funded and `before` is
provably 0. The spec now records that.

It also now records a limitation you did not raise and I want you aware of: the
caller builds the transaction and can append a second DBC swap **after**
`launch_coin` in the same transaction. The cap binds the handler, not the
transaction. That is accepted and unenforceable â but it constrains what the
frontend may claim, which is now written into Â§6.

## Part B â admin instructions

Per spec Â§6, build: `set_params`, `set_keeper`, `set_h2e_mint`, `pause`,
`set_denylist`.

Requirements:

- **All gated on `GlobalConfig.admin`, not the upgrade authority.** Only
  `initialize_global` uses the upgrade authority.
- `set_params` must reject any change where
  `holder_bps + h2e_bps + platform_bps != 10_000`.
- `set_keeper` changes `keeper` only. **The keeper must never be able to call any
  admin instruction** â spec Â§9.9. Test this explicitly.
- `set_h2e_mint` sets `h2e_mint` and may flip `revenue_distribution_enabled`.
  Decide and state whether enabling should be possible while `h2e_mint` is
  `None` â my view is no, and it should be rejected.
- `pause` and `pause_launches` are separate flags. `pause` should stop
  distribution; `pause_launches` stops new launches. Confirm the split makes
  sense as you implement it and flag if it does not.
- `set_denylist` â you have latitude on the account shape since the spec does not
  fix it. Propose something, explain the tradeoff, and keep it small. It holds
  excluded payout addresses and blocked payout mints.

**`admin` must remain replaceable by config change, not program upgrade** â the
plan is to move it to a multisig later without redeploying. Include whatever
instruction that requires.

## Tests

Every state-writing test asserts on-chain readback.

1. Each admin instruction succeeds when signed by `admin`.
2. Each admin instruction is rejected when signed by `keeper`.
3. Each is rejected when signed by an unrelated wallet.
4. `set_params` rejects a bps set that does not sum to 10,000.
5. `set_h2e_mint` behaves as you decided regarding enabling with `None`.
6. `pause_launches` set via the admin instruction then blocks `launch_coin` â
   **in a single validator session**, which is the whole reason this task moved
   ahead of `claim_and_sweep`.
7. Changing `admin` works, and the old admin is rejected afterwards.
8. The overflow test from A1.

## Report back

1. Full source and raw test output.
2. Your denylist account design and why.
3. Your decision on `set_h2e_mint` with `h2e_mint == None`.
4. Whether the `pause` / `pause_launches` split holds up in practice.
5. Result of the Â§9 checked-arithmetic audit â every place you found and fixed.
6. Updated program size.
7. Any spec ambiguity â flag rather than guess.

No `claim_and_sweep`, no epoch instructions, no keeper.
