# Task 1.8 Part B â `swap_payout`

Paste with the **updated** `H2E_ARCHITECTURE_v3.md`. Â§4 and Â§7.3 changed.

---

## Answers to your three questions

**1. `maxAccounts â 40` â approved, with two additions.**

Add an **on-chain guard** alongside it: reject if `remaining_accounts.len()`
exceeds a bound. The keeper-side cap is the mechanism; the program-side check
means a buggy or compromised keeper cannot route through an unbounded account set.

**Measure before locking the number.** Tokenized stocks are thin, and thin assets
are the ones that need multi-hop routes. If xStocks cannot quote under
`maxAccounts: 40`, the cap excludes assets that are half the reason the audience
is here. Check the pinned stock section against the cap and report what you find â
if they need more, we raise the cap and shrink H2E's own account footprint
instead.

**2. Testing â two layers.**

**Layer one, local: a stub Jupiter program.** Deploy a minimal program at a test
program ID that performs a fixed-rate token swap. This tests what actually needs
testing â venue pinning, the slippage floor, delta-measured `amount_out`, the
`Î£ amount_in` bound, state transitions. Jupiter's routing is not ours to verify.
Make the stub's program ID configurable so the same tests run against the real
program ID later.

**Layer two, one real integration run.** Try a mainnet-fork validator first, since
Jupiter's devnet routing is thin enough that a devnet pass may prove nothing. If
forking proves impractical, **say so rather than burning hours** â we validate the
real CPI during the Phase 4 single-coin mainnet run with a tiny amount.

Devnet SOL approved. Same 3 SOL cap, same rule: stop and ask before exceeding it.

**3. `swapped_in: u64` on `EpochState` â added to Â§4.** Explicit, not derived from
the vault balance, which drifts as fees arrive mid-round.

**Your allowlist design â approved and specced** as `AllowlistState`, seeds
`["allow", mint, epoch_index]`, written at settle. Your tx-size reasoning is
right: a Merkle proof in an instruction fighting the 64-account limit is the wrong
trade.

## Your other two flags from 1.7

- **`set_graduation` end-to-end â add the corruptâfixâclaim test.** Structural
  coverage is not enough for the one instruction whose entire job is recovering
  from corruption.
- **Token-2022 payout assets â restrict v1 to classic SPL**, now documented in
  Â§7.3. Cheaper than handling both token programs in an instruction already at
  the account ceiling.

Everything else in 1.7 is accepted. The cursor argument is correct, rejecting
zero-amount recipients is the right call for the reason you gave, and 13-recipient
batches without an ALT is a useful ceiling to have measured.

## What to build

### `swap_payout` per Â§6

- Reject if the epoch is not `settled`, or the bucket is already `swapped`.
- Reject `out_mint` not in this round's `AllowlistState`.
- Reject if `swapped_in + amount_in > payout_amount`.
- Reject `min_out < quoted Ã (1 â max_slippage_bps)`.
- Reject if `remaining_accounts.len()` exceeds the configured bound.
- CPI to the pinned Jupiter program only.
- **Record `amount_out` as the measured balance delta, never the quote.**
  `distribute_batch` bounds payments by `amount_out`, so an inflated value would
  let distribution exceed what the bucket actually holds.
- `out_mint == WSOL` â no swap, `amount_out = amount_in`.
- Advance `swapped_in`.

### `AllowlistState` written at settle

`settle_epoch` gains the round's electable mint set. Decide whether that changes
its signature or takes a separate instruction, and say which and why.

## Tests

1. Happy path against the stub: `amount_out` recorded from the measured delta.
2. **Delta, not quote.** Make the stub return less than quoted; prove the stored
   `amount_out` is the delta.
3. Slippage floor: `min_out` below threshold â rejected.
4. `out_mint` not in `AllowlistState` â rejected.
5. CPI target that is not the pinned program â rejected.
6. Bucket already `swapped` â rejected.
7. `swapped_in + amount_in > payout_amount` â rejected.
8. `remaining_accounts` over the bound â rejected.
9. `out_mint == WSOL` â no swap, `amount_out == amount_in`.
10. Non-keeper â rejected.
11. **End-to-end:** settle â allowlist â swap two buckets â distribute both â
    `buckets_complete == bucket_count`.
12. The `set_graduation` corruptâfixâclaim test.

Test 2 and test 11 are the ones that matter. Test 2 is where value silently
escapes if the quote is trusted; test 11 is the first proof that the whole payout
path works as one thing.

## Report back

1. **The stock-routing measurement first** â can xStocks quote under
   `maxAccounts: 40`?
2. Full source and raw test output.
3. Whether mainnet-fork was feasible, and the real-route result if so.
4. Proof that `amount_out` comes from the delta.
5. Where `AllowlistState` is written and why.
6. CU and account count for the swap path, worst case.
7. Updated program size.
8. Any spec ambiguity â flag rather than guess.

This closes Phase 1. The creator's `default_payout_mint` (Â§4, Â§7.3) is a small
follow-up task â do not build it here.
