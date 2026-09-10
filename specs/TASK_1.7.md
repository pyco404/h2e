# Task 1.7 â `settle_epoch`, `distribute_batch`, `set_graduation`

Paste with the **updated** `H2E_ARCHITECTURE_v3.md`. Â§4 and Â§6 changed
substantially â a new `BucketState` account and rewritten epoch instructions.

**Run this before Task 1.8.** You may run both back to back and report together,
but 1.7 must be complete first â 1.8 fills the gap between these instructions.

---

## Context

Task 1.6 is accepted. The mint-based `damm_pool` check was the right call â
deriving the expected pool address would hardcode the migration config and break
the moment a second fee preset exists.

**Your one-way `sync_graduation` flag is now a spec item.** Your reasoning holds,
and there is a sharper version: all four verifications read raw bytes at
hardcoded offsets (`is_migrated` at 305, `base_mint` at 136, and so on). If
Meteora upgrades DBC or cp-amm and shifts a layout, those reads silently return
the wrong thing, a permissionless caller writes garbage into permanent one-way
state, and that coin can never claim again. Build the override in Part C.

## Spec change: `BucketState`

A gap I found in my own spec while writing this. `settle_epoch` freezes
`payout_amount` in WSOL, but holders elect different assets, so after swapping the
vault holds several mints. A single WSOL-denominated bound cannot constrain
distribution across them â the overpayment check has to be per-asset.

Â§4 now defines `BucketState`, seeded `["bucket", mint, epoch_index, out_mint]`,
with its own `amount_out`, `cursor`, `recipient_count` and `paid_amount`. Read Â§4
and Â§6 before building.

## Part A â `settle_epoch`

Per Â§6. Keeper-signed. Freezes `payout_amount` from the `PayoutAuthority` WSOL ATA
balance, so fees arriving mid-round belong to the next epoch.

## Part B â `distribute_batch`

**The highest-risk instruction in the program.** Everything else either moves
money into vaults or gates who may act; this one moves money out, thousands of
times, resumably.

Per Â§6, operating on one `BucketState`. Three invariants:

1. **Strict cursor ordering.** Batch start index must equal `cursor`. This is what
   makes double-payment structurally impossible rather than merely unlikely.
2. **Per-bucket bound.** `paid_amount + Î£ amounts > amount_out` â reject, in that
   bucket's own mint.
3. **Resumable with no bitmap.** Recipients ordered ascending by pubkey, so the
   cursor alone is sufficient state.

`recipient_count` is fixed at settle time and cannot change afterwards.

Note the ordering dependency: `distribute_batch` requires a `swapped` bucket, and
`swap_payout` is Task 1.8. For this task's tests, construct a **WSOL bucket** â
Â§6 says `out_mint == WSOL` needs no swap and `amount_out = amount_in`. That gives
a distributable bucket without Jupiter. Say if you find a cleaner approach.

## Part C â `set_graduation`

Admin-gated override for `status`, `damm_pool` and `locked_position`, per the new
Â§6 admin table row. Narrow scope â a fix-a-corruption hatch, not a general
`CoinConfig` editor.

## Tests

Every state-writing test asserts on-chain readback.

**`settle_epoch`:** before `epoch_end` â rejected; duplicate index â rejected;
`payout_amount` matches the vault balance at settle; fees arriving after settle do
not change it; non-keeper â rejected.

**`distribute_batch` â spend the most effort here:**

1. Happy path across several batches until `complete`.
2. **Replay.** Resubmit an already-applied batch â rejected. Assert no recipient
   was paid twice.
3. **Out-of-order.** Submit batch 3 while the cursor is at batch 2 â rejected.
4. **Overpayment.** A batch whose sum would exceed `amount_out` â rejected.
5. **Crash and resume.** Distribute partially, abandon mid-round, then resume from
   the on-chain cursor and complete correctly. This is the real operational
   failure mode.
6. On completion, `buckets_complete` on the parent `EpochState` increments.
7. Non-keeper caller â rejected.
8. Mismatched `recipients` / `amounts` lengths â rejected.
9. Zero-amount recipient â decide whether to reject or skip, and say which.

**`set_graduation`:** admin succeeds; keeper and unrelated rejected; overwriting a
wrongly-recorded `locked_position` works and the coin can claim afterwards.

## Report back

1. Full source and raw test output.
2. The exact double-payment argument: why, given the cursor check, no recipient
   can be paid twice under arbitrary keeper retries.
3. What happens if the keeper submits batches for a bucket that was never swapped.
4. Your decision on zero-amount recipients.
5. CU and transaction size for a 15-recipient batch, with and without the ALT.
6. Updated program size.
7. Any spec ambiguity â flag rather than guess.

No `swap_payout`, no Jupiter, no keeper service. Task 1.8 covers those.
