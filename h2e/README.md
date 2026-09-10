# H2E

Solana launchpad where a coin's trading fees are paid to its holders every 24h.
See `H2E_ARCHITECTURE_v3.md` for the spec.

## Layout

```
programs/h2e/     Anchor program (Rust)
client/           Shared TS client — the ONLY place instruction data is encoded
tests/            Program tests (local validator)
keeper/           Node keeper (later)
app/              Frontend (later)
scripts/          Dev/test helpers
```

## Building & testing

```
anchor build
./scripts/local-test.sh
```

`scripts/local-test.sh` starts a fresh local validator, airdrops to the deploy
wallet, and runs the TS suite via `anchor test --skip-local-validator`.

Account layout is tested separately in Rust, against the real borsh layout:

```
cargo test -p h2e --lib
```

Some accounts (e.g. `CoinConfig`) are pruned from the IDL until an instruction
references them, so their serialized size / `Option` / enum layout is asserted in
Rust unit tests rather than against a hand-written TS schema that could drift.

### launch_coin tests (cloned DBC rail)

`anchor test` / `local-test.sh` run the fast, DBC-free suite (initialize_global,
PDA derivations). `launch_coin` needs the Meteora DBC rail, which is not on a bare
validator, so its tests clone the DBC + metaplex programs, the WSOL mint, and the
platform config account (feeClaimer = this program's `["fee"]` PDA) from devnet:

```
./scripts/launch-test.sh tests/launch_coin.ts       # launch tests 1-4,6-8 (cloned rail)
./scripts/launch-test.sh tests/launch_pause.ts 0    # launch test 5, pause=true (bare validator)
./scripts/launch-test.sh tests/admin.ts             # admin instructions (cloned rail; test 6 launches)
./scripts/launch-test.sh tests/sweep.ts             # claim_and_sweep (bonding)
./scripts/launch-test.sh tests/graduation.ts        # sync_graduation, graduated claim, retire_coin
./scripts/launch-test.sh tests/epoch.ts             # settle_epoch, distribute_batch, set_graduation
```

`distribute_batch` operates on preloaded swapped WSOL `BucketState` fixtures
(`swap_payout` is Task 1.8). `gen-epoch-fixtures.ts` generates them; `launch-test.sh`
preloads them via `--account`. Batches of 10-15 recipients require the ALT.

`graduation.ts` clones cp-amm + the DAMM v2 config alongside DBC, drives a coin to
threshold (`swap2` PartialFill), migrates it (`migration_damm_v2_create_metadata`
then `migration_damm_v2`), and tests the graduated path. It funds the shared DBC
pool-authority PDA ~0.5 SOL first (funded on devnet, empty on a fresh clone).
`sync_graduation` is permissionless but verifies four things on-chain; the
graduated `claim_and_sweep` branch CPIs cp-amm `claim_position_fee` signing as the
same `["fee"]` PDA. `Retired` blocks sweeps but not distribution of vault funds.

`claim_and_sweep` is permissionless: safety is the constrained destination, not a
caller allowlist (spec §5). Every WSOL destination is pinned by an
`associated_token` constraint to the correct authority PDA's ATA, so a
caller-supplied receiver is rejected at account validation. The status guard
(NotBonding) is tested by preloading a synthetic Graduated CoinConfig
(`scripts/gen-graduated-coin.ts`) into the validator via `--account`.

Admin instructions (`set_params`, `set_keeper`, `set_admin`, `set_h2e_mint`,
`pause`, `set_denylist`) are all gated on `GlobalConfig.admin` (not the upgrade
authority). Cap/split arithmetic uses `u128`/checked math (spec §9.14); the
overflow proof is a Rust unit test (`cargo test -p h2e --lib`).

`GlobalConfig` is a singleton with no setter yet, so states that differ in
`pause_launches` (and, later, other admin fields) are exercised in separate
sessions. The platform config is created once on devnet (its address is pinned in
`tests/fixtures/platform-config.txt`).

Why not plain `anchor test`? `initialize_global` requires the signer to be the
program's **upgrade authority**. `anchor deploy` (used by the script) deploys the
program *upgradeable* with the provider wallet as upgrade authority — the
real-world condition. `anchor test`'s bundled validator does not, so the
authority check would reject every init.

## Client pattern — build every instruction through `client/`

Do **not** call `program.methods.<ix>(...)`. Anchor 0.32.1's toolchain is
internally inconsistent for struct-arg fields with a digit→letter boundary
(e.g. `h2e_bps`): the generated TS types name it `h2eBps` while the runtime IDL
loader expects `h2EBps`, so the obvious call type-checks yet serializes `0`
silently. There is no 1.x `@coral-xyz/anchor` on npm to upgrade to.

`client/index.ts` sidesteps this: it encodes with Anchor's official
`BorshInstructionCoder` against the raw (snake_case) IDL, exposes the spec's
field names verbatim, and round-trips every encode so a mismatch throws instead
of shipping zeros. Callers do:

```ts
import { initializeGlobalIx, pdas, decodeGlobalConfig, BN } from '../client'

const ix = initializeGlobalIx({
  admin, keeper, platform_wallet, platform_config_key, usdc_mint,
  holder_bps: 6000, h2e_bps: 3000, platform_bps: 1000,
  dev_buy_cap_bps: 300, holder_cap_bps: 300,
  epoch_seconds: new BN(86400), h2e_epoch_seconds: new BN(604800),
  max_slippage_bps: 100, min_sweep_lamports: new BN(1_000_000),
  pool_creation_fee_lamports: new BN(0), paused: false, pause_launches: false,
}, authority)                                   // authority = upgrade authority

// send as a versioned (v0) transaction with an address lookup table (spec §3.2)
```

Each new instruction adds one typed builder to `client/index.ts`. Nothing else
in the keeper or frontend encodes program data.

## Toolchain

- Anchor CLI 0.32.1, `@coral-xyz/anchor` 0.32.1 (npm has no 1.x)
- Solana CLI 3.1.10 (Agave)
