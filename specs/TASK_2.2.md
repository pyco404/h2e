# Task 2.2 — Round builder, asset catalog, keeper loop, election API
Run after 2.1. Batched (lower risk: TS against a program that enforces invariants).

## Part A — asset catalog + electable list (§7.3, §7.5b)
Electable builder IN ORDER: 1 reject live freeze authority (first); 2 classic SPL only;
3 Jupiter 24h volume AND route depth at representative payout size; 4 must quote under
maxAccounts cap; 5 manual denylist overrides (publish reasoning); 6 pinned stock section
wider slippage. Output feeds set_platform_allowlist (admin-gated) → a PROPOSAL not a tx;
say how admin approves. Asset catalog (§7.5b): name/symbol/logo/category + market-hours
warning, never source of truth for permitted mints. Metadata pipeline: accept image →
host → produce JSON → return uri for launch_coin.

## Part B — round builder (§7.4), consumes 2.1 aged balances
1 freeze block height at epoch_end; 2 aged balance; 3 drop excluded/zero/>3%; 4 bucket by
elected asset, default_payout_mint for non-electors, USDC fallback if unallowlisted; 5
share_i=aged_i/Σaged; 6 drop < ATA rent (rolls over); 7 sort pubkey asc, Merkle root.
Two runs same range → byte-identical. Test explicitly.

## Part C — keeper loop (§7.5)
Threshold-gated claim_and_sweep tiered (hot 1min/quiet 15/dormant hourly); sync_graduation
polling; epochs staggered by launch_ts; settle→swap_payout per bucket→distribute_batch until
cursor done; post-grad claims CANNOT threshold on fee_b_pending (reads 0 between) — compute
from pool fee growth OR schedule+absorb noops, say which; Jupiter maxAccounts cap; migration
crank fallback. MUST resume from on-chain cursor after crash at any point. Test kill mid-distribution.

## Part D — election API (§7.6)
Wallet signs {mint,epoch_index,out_mint,nonce}; verify+store. Non-electors default silently+
permanently to default_payout_mint, no rollover. Reject elections for mints not in round allowlist
AT SUBMISSION (error not silent fallback).

## Report: source+output; determinism proof; crash-resume; post-grad claim choice+cost; how
allowlist proposal reaches admin; keeper tx cost/coin/day at realistic mix; ambiguities.
