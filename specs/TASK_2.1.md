# Task 2.1 — Indexer and the aged-balance engine
Paste with updated H2E_ARCHITECTURE_v3.md (§7.5b new).

## Part A — offline encoding suite (DO FIRST)
Every client builder with representative args, asserting round-trip on all —
including a PublicKey constructed from a SECOND class copy (the exact shape of the
instanceof bug). Closes the silent-serialization class permanently. The round-trip
guard only ran in network-gated tests before; this runs offline.

## Part B — indexer (§7.2)
- Stream SPL transfers per tracked mint (Helius webhooks or Geyser).
- Persist balance-change events per wallet per mint, enough for rolling 24h min. Prune past 24h + margin.
- Track CoinConfig creations for the platform coin list (§7.5b).
- Exclusions by address: DBC virtual pool, DAMM pool, burn, all H2E vaults, on-chain denylist.
- Choose storage + justify. MUST survive restart.

## Part C — aged-balance engine (highest-risk off-chain logic)
§1.1: aged balance at t = MINIMUM balance held at any point in [t-24h, t].
10 adversarial tests: 1 continuous hold; 2 sell-half-then-rebuy (trough not avg);
3 funded 23h59m before → ineligible; 4 funded 24h01m → eligible; 5 DUST GRIEF
(2.9%→over 3% just before settle: aged unchanged, stays eligible); 6 full exit+return
→ aged 0; 7 same-slot/same-tx changes; 8 receive-send-receive net zero; 9 DETERMINISM
byte-identical; 10 RESTART mid-window same result. Tests 5 and 10 matter most.

## Report: storage+restart argument; source+output(10 named cases); rolling-min cost
at 10k holders; missed-blocks gap detection+backfill (undetected gap corrupts every
payout after — say plainly); stack recommendation for when egress returns; ambiguities.
No round builder/keeper/election API (Task 2.2).
