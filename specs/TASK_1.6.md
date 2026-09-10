# Task 1.6 â Graduation: `sync_graduation`, the graduated claim path, `retire_coin`

Paste with the **updated** `H2E_ARCHITECTURE_v3.md` â Â§6's Admin table changed.

---

## Context

Task 1.5 is accepted. The `associated_token::` constraints are the right
enforcement: rejection during account validation means no caller-supplied account
can reach the CPI at all, which is a stronger property than a handler check.

**Your three flags:**

- **`usdc_mint` gets a dedicated setter.** I scored it higher-risk than you did.
  It is the default payout asset for every non-elector, and most holders will not
  elect â a wrong value pays the majority of every round in an arbitrary mint.
  Spec updated.
- **Status guard as an account constraint â keep it.** Rejecting before
  validating twenty accounts is better. Keep the fixture test, and add a
  real-graduated-coin version in this task now that one will exist.
- **`token_a_account` as the base ATA â keep it.** Reusing the WSOL ATA would
  hard-fail the whole sweep on a mint mismatch if base fees ever accrued. One
  zero-balance ATA per coin is trivial against that.

The `spl-token-2022` warnings are fine to carry â but note that position NFTs in
this task genuinely are Token-2022, so that crate stops being dead code.

## What to build

Three things, all concerning a coin's status transitions.

### 1. `sync_graduation(mint)` â permissionless

Per spec Â§6. Reads `migration_progress` / `is_migrated` from the DBC pool and, on
`is_migrated == 1`, sets `status = Graduated` and records `damm_pool` and
`locked_position`.

**Because it is permissionless, it must verify rather than trust.** A caller
supplies candidate accounts; the instruction must confirm on-chain that:

- The DBC pool genuinely corresponds to this mint.
- `is_migrated == 1` â reject otherwise.
- The recorded `damm_pool` is the pool that DBC migrated this coin into.
- The recorded `locked_position`'s NFT authority is the global `["fee"]` PDA.

A bogus recording cannot steal funds â destinations stay constrained â but it can
break claiming for that coin permanently. Verify all four.

Note from Phase 0: migration mints **two** positions (partner and creator). Record
the partner's â the one whose NFT authority is H2E's PDA. Confirm the creator's is
empty, since creators earn nothing.

### 2. Graduated branch in `claim_and_sweep`

When `status == Graduated`, CPI cp-amm `claim_position_fee` instead of DBC
`claim_trading_fee`, signing as the same global `["fee"]` PDA.

From Phase 0, verified on devnet: cp-amm `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`,
discriminator `[180,38,154,17,133,33,162,211]`, no args, with the PDA as account
10 (`owner`, signer). **Re-derive this from the current source rather than
trusting my account list.**

Everything downstream is unchanged: same constrained receiver, same 60/30/10
split, same remainder rule, same `paused` gate. Only the claim CPI differs.

### 3. `retire_coin`

Admin-gated, sets `status = Retired`. The enum has the variant and nothing
currently reaches it. Decide and state what `Retired` should block â my view is
that it stops sweeps and launches nothing new, but does **not** block
distribution of funds already in the vaults. Holders keep what they are owed.

## Testing

You will need a genuinely graduated coin on the cloned validator. Phase 0 drove a
pool to threshold and migrated it manually on devnet with
`migration_damm_v2_create_metadata` then `migration_damm_v2` â both permissionless.
You will need cp-amm cloned alongside DBC.

Recall from Phase 0: DBC exact-input swaps reject overshoot near curve completion
(`InsufficientLiquidity`); use `swap2` in PartialFill mode to top the curve
exactly to threshold.

**If driving a real migration locally proves impractical, say so before burning
hours on it** and we will decide between a devnet test and a fixture.

### Tests

1. `sync_graduation` on a still-bonding coin â rejected.
2. `sync_graduation` on a genuinely migrated coin â `status == Graduated`,
   `damm_pool` and `locked_position` recorded, all read back on-chain.
3. `sync_graduation` with a `locked_position` whose NFT authority is **not** the
   global PDA â rejected.
4. `sync_graduation` with a `damm_pool` belonging to a different coin â rejected.
5. Post-graduation trading generates fees; `claim_and_sweep` claims them via
   cp-amm and splits 60/30/10 correctly.
6. The real-graduated-coin version of Task 1.5's test 6 â replacing the `--account`
   fixture.
7. `retire_coin` is admin-gated and rejected for keeper and unrelated wallets.
8. Whatever `Retired` blocks, per your decision in item 3, is tested.
9. The creator's minted position is empty (spec Â§11, item 2 â this closes an open
   verification item).

## Report back

1. Full source and raw test output.
2. How each of the four `sync_graduation` verifications is enforced.
3. Your decision on what `Retired` blocks, and why.
4. Confirmation that the creator's locked position is empty.
5. CU and transaction size for the graduated sweep path.
6. Whether Token-2022 handling for the position NFT caused any surprises.
7. Updated program size.
8. Any spec ambiguity â flag rather than guess.

This closes the on-chain claim path. Epoch instructions (`settle_epoch`,
`swap_payout`, `distribute_batch`) come next and are a larger block â do not start
them here.
