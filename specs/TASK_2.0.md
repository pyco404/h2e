# Task 2.0 â Scaffold the app frontend

Runs alongside Phase 1, not after it. Paste with `H2E_ARCHITECTURE_v3.md`.

**This is a scaffold, not a working app.** The keeper does not exist and
`swap_payout` is not built, so nothing here can show real payout data yet. The
goal is structure and the pieces that can be real now.

---

## Scope

In the `app/` directory left empty in Task 1.1.

### Build for real

**Launch flow.** Wallet connect, a form for name / symbol / image / optional dev
buy, and a submit that builds the `launch_coin` transaction using the existing
`client/index.ts` builders and the ALT. This is the one flow that can work
end-to-end today against a local validator or devnet â make it actually work.

Surface these plainly in the form, not in fine print:

- The creator receives **no** share of trading fees, ever.
- The dev buy is optional and capped at 3%.
- Fee assignment is permanent and cannot be changed after launch.

**Wording is binding here.** The UI may say "dev buys through H2E are capped at
3%." It may **never** say creators hold at most 3% or imply an enforced ownership
ceiling â spec Â§6 explains why that claim is false. Do not reword around it.

### Scaffold only, with honest empty states

- **Coin page** â fees accrued, next payout, holder count, payout history.
- **Election UI** â asset picker per round.
- **Round transparency page** â inputs, eligible set, Merkle root, transaction
  links. Spec Â§7.1 calls this the trust story; give it real structure now even
  though it has no data.

For these, empty states say what will appear and why it isn't there yet. No fake
numbers, no placeholder charts, no lorem ipsum â a mocked payout figure has a way
of surviving into production.

## Stack

Your call, but state the choice and why. It needs a Solana wallet adapter, and it
must import the existing `client/index.ts` rather than re-encoding instructions â
that module exists because Anchor's TS client silently serialized fields as zeros
(Task 1.1b). **Nothing outside `client/` encodes program data.**

## Design

A landing page already exists as a self-contained HTML file. Match its visual
language: pale sage paper, deep forest ink, marigold for money, ultramarine for
anything the user chooses. Serif body, Archivo for headings and figures.

Carry the semantic colour rule through the app â marigold means an amount,
ultramarine means a choice the holder makes. It should be visible at a glance
which numbers are money and which are decisions.

## Report back

1. Stack choice and reasoning.
2. Whether the launch flow works end-to-end, and against what.
3. Screenshots or a description of each screen.
4. Anything in the spec the UI made ambiguous â screens surface gaps that
   instruction specs hide, so flag what you find.

Do not build the keeper. Do not mock payout data.
