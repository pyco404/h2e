# Task 1.2 â `CoinConfig` and the vault authority PDAs

Paste this together with the **updated** `H2E_ARCHITECTURE_v3.md`. Â§4 has changed
since Task 1.1 â reread it.

---

## Context

Task 1.1b is accepted. The root cause was real and specific: Anchor 0.32.1's
runtime IDL loader expects `h2EBps` while the generated types say `h2eBps`, so
the intuitive call type-checked and serialized zero. The isolated client module
with a round-trip guard is the right resolution, and every future instruction
extends it.

**One limit on that guard to keep in mind.** Encode â decode through the same
coder is self-consistent, so a symmetric mismatch would pass it. The authoritative
check is reading state back from chain, which your test #4 does.

**Rule for this and every later task: any instruction that writes state must
assert on-chain readback, not just round-trip.** Both layers, always.

## Spec change since Task 1.1

Â§4's vault section has been rewritten. The vault PDAs are **authorities, not
token accounts** â the actual holdings are ATAs owned by those authorities, so a
payout authority can hold several ATAs (one per elected asset) with no extra
derivation logic. Read the new table before building.

## What to build

Account definitions and PDA derivations only. **No instructions that use them
yet.**

### `CoinConfig` â PDA, seeds `["coin", mint]`

Fields exactly as in spec Â§4. Do not add, omit, or rename.

Note `damm_pool` and `locked_position` are `Option<Pubkey>` â `None` while
bonding, populated at graduation â and `status` is the three-variant enum.

### The four authority PDAs

Derivation helpers only, in both the program and the client module:

| PDA | Seeds |
|---|---|
| `FeeClaimer` | `["fee"]` â global, no mint |
| `FeeAuthority` | `["vault", mint]` |
| `PayoutAuthority` | `["payout", mint]` |
| `RevenueAuthority` | `["revenue"]` â global |

Also provide a helper that derives the **WSOL ATA of `FeeAuthority(mint)`** â
this is the constrained claim destination from spec Â§5, and it will be used by
`claim_and_sweep` in a later task.

## Scope boundary

**Do not build:** `launch_coin`, `claim_and_sweep`, any vault initialization, any
CPI, any split logic, any keeper. This task defines shapes and derivations so the
next tasks have solid ground.

If a `CoinConfig` cannot be created without `launch_coin`, that is expected â
tests should exercise derivations and the account's serialized layout, not
creation.

## Tests

1. Every PDA derivation matches an independently computed address. Compute the
   expected value in the test with `PublicKey.findProgramAddressSync` directly â
   **do not call the same helper you are testing.**
2. `FeeClaimer` and `RevenueAuthority` are stable across different mints (they are
   global; a mint must not affect them).
3. `FeeAuthority` and `PayoutAuthority` differ for different mints, and never
   collide with each other for the same mint.
4. The `FeeAuthority` WSOL ATA helper matches an independently derived ATA.
5. `CoinConfig`'s serialized size and layout are asserted, including that
   `Option<Pubkey>` fields round-trip correctly as both `None` and `Some`.
6. The `status` enum round-trips for all three variants.

Test 5 matters more than it looks â `Option<Pubkey>` in Anchor account layout is
a place where a wrong assumption is expensive to fix once accounts exist on
mainnet.

## Report back

1. Full source of the account definitions, derivation helpers, and tests.
2. Raw test output.
3. `CoinConfig`'s exact serialized size, with the space calculation shown.
4. Updated compiled program size.
5. Any spec ambiguity you had to interpret â flag it rather than guessing.

Nothing beyond the above.
