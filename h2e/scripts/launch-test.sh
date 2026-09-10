#!/usr/bin/env bash
# Run a launch_coin test file against a local validator with the DBC rail cloned
# from devnet. DBC is not on a bare validator, so we clone the DBC + metaplex
# programs, the WSOL mint, and the platform config account (whose feeClaimer is
# this program's ["fee"] PDA). Deploy is upgradeable (wallet = upgrade authority)
# so initialize_global's authority check is exercised for real.
set -euo pipefail
TEST_FILE="${1:-tests/launch_coin.ts}"
CLONE="${2:-1}"  # 1 = clone the DBC rail; 0 = bare validator (pause test only)
WALLET_PUBKEY="$(solana-keygen pubkey ~/.config/solana/id.json)"
RPC="http://127.0.0.1:8899"
DEVNET="$(tr -d '[:space:]' < ../.helius-url)"

DBC=dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
METAPLEX=metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
CPAMM=cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG
DAMMCFG=Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp
WSOL=So11111111111111111111111111111111111111112
CONFIG="$(cat tests/fixtures/platform-config.txt)"

pkill -9 -f solana-test-validator 2>/dev/null || true
sleep 3
rm -rf test-ledger
CLONE_ARGS=()
if [ "$CLONE" = "1" ]; then
  CLONE_ARGS=(--url "$DEVNET"
    --clone-upgradeable-program "$DBC"
    --clone-upgradeable-program "$METAPLEX"
    --clone-upgradeable-program "$CPAMM"
    --clone "$DAMMCFG"
    --clone "$WSOL"
    --clone "$CONFIG")
fi
# Preload EpochState/BucketState fixtures for the distribute_batch tests.
for f in tests/fixtures/epoch/*.acct.json; do
  [ -f "$f" ] || continue
  ADDR=$(node -e "console.log(require('./$f').pubkey)")
  CLONE_ARGS+=(--account "$ADDR" "$f")
done
solana-test-validator --reset --ledger test-ledger --rpc-port 8899 "${CLONE_ARGS[@]}" >/dev/null 2>&1 &
VALIDATOR_PID=$!
trap 'kill -9 $VALIDATOR_PID 2>/dev/null || true' EXIT

for i in $(seq 1 90); do
  if curl -s -m 3 "$RPC" -X POST -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"result":"ok"'; then
    echo "validator up"; break
  fi; sleep 1
done
solana airdrop 100 "$WALLET_PUBKEY" --url "$RPC" >/dev/null
if [ "$CLONE" = "1" ]; then
  echo "cloned: DBC=$(solana account "$DBC" --url "$RPC" -o /dev/null 2>&1 >/dev/null && echo ok) config=$(solana account "$CONFIG" --url "$RPC" --output json 2>/dev/null | grep -q owner && echo ok)"
fi
anchor deploy --provider.cluster "$RPC" 2>&1 | grep -iE "Program Id|Deploy success|Error" || true

export ANCHOR_PROVIDER_URL="$RPC"
export ANCHOR_WALLET="$HOME/.config/solana/id.json"
npx ts-mocha -p ./tsconfig.json -t 1000000 "$TEST_FILE"
