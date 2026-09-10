# Task 1.3 â `launch_coin`

The hardest instruction in the program. Paste this with the **updated**
`H2E_ARCHITECTURE_v3.md` â Â§5 and Â§6 changed since Task 1.2.

---

## Context

Task 1.2 is accepted. Both flags were right:

- **IDL pruning.** Your call was correct. A hand-written TS schema duplicating the
  Rust struct would drift, and drift in an account layout is unfixable once
  accounts exist. Testing the real borsh layout in Rust is the source of truth.
  This task creates `CoinConfig` for real, which pulls it into the IDL â add the
  client decoder then.
- **Naming inconsistency.** My error. Â§5 and Â§6 still used the pre-rename vault
  names. The spec is fixed: the constrained claim destination is the **WSOL ATA
  of `FeeAuthority(mint)`**, and sweeps go to `PayoutAuthority(mint)`'s and
  `RevenueAuthority`'s WSOL ATAs. Reread Â§5 and Â§6.

## What to build

`launch_coin(name, symbol, uri, dev_buy_lamports)` per spec Â§6.

Phase 0 Task 0.4 proved this shape works on devnet at ~179k CU and 910 bytes:
pool creation by CPI with the config pinned, plus an atomic capped dev buy, with
the over-cap case reverting the whole transaction. **That was a throwaway. This
is the real instruction and no code carries over â only the approach.**

It must, in one instruction:

1. Reject if `GlobalConfig.pause_launches`.
2. CPI DBC pool creation using `GlobalConfig.platform_config_key`, pinned with
   `require_keys_eq!`. A creator must not be able to launch against another
   config.
3. If `dev_buy_lamports > 0`: create the dev ATA in-instruction, CPI the swap,
   measure the **balance delta on that ATA**, and reject if it exceeds
   `dev_buy_cap_bps` of `mint.supply` read from the freshly created mint.
4. Zero dev buy passes.
5. Collect `pool_creation_fee_lamports` to `platform_wallet` if non-zero.
6. Create `CoinConfig` with `launch_ts = clock.unix_timestamp`,
   `status = Bonding`, `damm_pool = None`, `locked_position = None`.

**The cap must not be gameable.** Supply comes from the mint; acquisition is a
delta on an ATA created inside the instruction; no caller-supplied amount enters
the check. Verify this property holds in your implementation and say how.

## Testing against DBC

DBC is not on a bare local validator. Clone the DBC program and the platform
config account from devnet via `[test.validator]` in `Anchor.toml`, or test
against devnet directly if cloning proves impractical.

**Say which you chose and why.** If cloning works it is much better â faster, and
no devnet SOL burned per run.

You will need a platform config key owned by the global `["fee"]` PDA of *this*
program, whose ID differs from the Phase 0 throwaway. Create a fresh one.

## Tests

Every state-writing test asserts **on-chain readback**, not just round-trip.

1. `dev_buy_lamports = 0` â pool created, `CoinConfig` written and read back
   correct, caller holds no tokens.
2. Dev buy just under the cap â succeeds. Print the exact percentage acquired.
3. Dev buy over the cap â **whole transaction reverts.** Assert no pool account
   and no `CoinConfig` exist afterwards.
4. A pool creation attempt against a config key that is not
   `platform_config_key` â rejected.
5. `pause_launches = true` â rejected.
6. `pool_creation_fee_lamports` non-zero â `platform_wallet` balance increases by
   exactly that amount.
7. `CoinConfig` after launch: `status == Bonding`, `damm_pool == None`,
   `locked_position == None`, `launch_ts` within a sane window of now.
8. The created pool's `config.fee_claimer` is the global `["fee"]` PDA.

## Report back

1. Full source of the instruction, the client builder, and the tests.
2. Raw test output.
3. **Compute units and serialized transaction size** for the create-only and
   create-plus-buy paths. Size is the binding constraint (spec Â§3.2) â say plainly
   how close to 1232 bytes you are, and whether the ALT is carrying its weight.
4. Exactly how the 3% check reads its two inputs, and why a caller cannot
   influence either.
5. Updated compiled program size.
6. Any spec ambiguity â flag it rather than guessing.

Build only `launch_coin`. No `claim_and_sweep`, no vault initialization beyond
what launching requires, no keeper.
