# Task 1.8 â `swap_payout` (Jupiter CPI)

**Run only after Task 1.7 is complete.** Paste with the same updated
`H2E_ARCHITECTURE_v3.md`.

---

## Context

This closes the on-chain payout path. `settle_epoch` freezes the round,
`swap_payout` converts WSOL into each elected asset, `distribute_batch` pays it
out.

**This is the highest-uncertainty instruction left**, for one reason: Jupiter's
swap CPI carries a large and variable number of route accounts, and transaction
size is already the binding constraint on this program. Task 1.6 measured the
graduated sweep at 98% of the legacy limit without an ALT.

So treat the first part of this as a feasibility question, not an implementation
detail.

## Part A â measure before you build

Before writing the instruction, determine and report:

1. How many accounts a representative Jupiter route requires, and how that varies
   between a simple two-hop and a complex multi-hop route.
2. Whether a `swap_payout` CPI fits in one transaction alongside H2E's own
   accounts, **with** an ALT â and what the worst-case route looks like.
3. Whether Jupiter's program can be cloned into the local validator the way DBC
   and cp-amm were, or whether this has to be tested on devnet.

**If it does not fit, stop and tell me** rather than building something that
works only for simple routes. There are alternatives â capping route complexity
in the keeper's quote request, splitting the swap into its own transaction with
an intermediate holding account, or restricting the electable list to assets with
direct WSOL routes. I would rather choose one deliberately than discover the
ceiling in production.

## Part B â the instruction

Per Â§6, only if Part A says it fits.

- Reject if the epoch is not `settled`, or the bucket is already `swapped`.
- Reject `out_mint` not in the round's snapshotted allowlist.
- Reject if `Î£ amount_in` across the epoch's buckets would exceed
  `payout_amount`.
- Reject `min_out < quoted Ã (1 â max_slippage_bps)`.
- **CPI to the allowlisted Jupiter program only** â spec Â§9.7. An unbounded CPI
  target here would let a compromised keeper route funds anywhere.
- **Record `amount_out` as the measured balance delta, not the quote.** Quotes are
  advisory; the delta is what actually arrived. This matters because
  `distribute_batch` bounds payments by `amount_out`, so an inflated value would
  let distribution exceed what the bucket holds.
- `out_mint == WSOL` â no swap, `amount_out = amount_in`.

### The allowlist question

Â§7.3 says the electable list is built off-chain and snapshotted at round start,
but the program must verify `out_mint` against it. Propose how â an on-chain
allowlist account written at settle time, a Merkle root of the snapshot, or
something better. State the tradeoff. Keep in mind the keeper is trusted for
eligibility (Â§7.1) but should not be trusted to route funds into an arbitrary
mint.

## Tests

1. Happy path: WSOL â a real cloned-liquidity mint, `amount_out` recorded as the
   measured delta.
2. `amount_out` recorded from the delta, not the quote â prove these differ, and
   that the delta is what is stored.
3. Slippage floor enforced: `min_out` below the threshold â rejected.
4. Non-allowlisted `out_mint` â rejected.
5. CPI to a program that is not Jupiter â rejected.
6. Bucket already `swapped` â rejected.
7. `Î£ amount_in` exceeding `payout_amount` â rejected.
8. `out_mint == WSOL` â no swap, `amount_out == amount_in`.
9. Non-keeper â rejected.
10. End-to-end: settle â swap two buckets â distribute both â epoch complete.

Test 10 is the one that proves the whole payout path works together.

## Report back

1. **Part A's findings first** â account counts, size, and whether it fits.
2. Full source and raw test output.
3. Your allowlist design and its tradeoff.
4. Proof that `amount_out` comes from the delta.
5. CU and transaction size for the swap path, worst case.
6. Updated program size.
7. Any spec ambiguity â flag rather than guess.

This closes Phase 1. Do not start the keeper service.
