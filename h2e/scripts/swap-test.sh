#!/usr/bin/env bash
# Offline swap_payout suite (Task 1.8b). No cloning / no network: the coin is a
# preloaded synthetic Bonding CoinConfig, and the swap venue is the local
# jupiter_stub. h2e is built with the `stub-jupiter` feature so JUPITER_PROGRAM
# points at the stub; both programs deploy upgradeable with the wallet as upgrade
# authority (initialize_global needs that).
set -euo pipefail
cd "$(dirname "$0")/.."
WALLET="$HOME/.config/solana/id.json"
WALLET_PUBKEY="$(solana-keygen pubkey "$WALLET")"
RPC="http://127.0.0.1:8899"
TEST_FILE="${1:-tests/swap.ts}"

echo "== build h2e (stub-jupiter) + stub =="
cargo build-sbf --features stub-jupiter -- -p h2e >/dev/null 2>&1
cargo build-sbf -- -p jupiter_stub >/dev/null 2>&1

echo "== generate coin fixture =="
export ANCHOR_PROVIDER_URL="$RPC"; export ANCHOR_WALLET="$WALLET"
npx ts-node --compiler-options '{"module":"commonjs"}' scripts/gen-swap-fixtures.ts

pkill -9 -f solana-test-validator 2>/dev/null || true
sleep 3
rm -rf test-ledger
solana-test-validator --reset --ledger test-ledger --rpc-port 8899 \
  --account "$(node -e "console.log(require('./tests/fixtures/swap/coin.acct.json').pubkey)")" tests/fixtures/swap/coin.acct.json \
  >/dev/null 2>&1 &
VALIDATOR_PID=$!
trap 'kill -9 $VALIDATOR_PID 2>/dev/null || true' EXIT

for i in $(seq 1 60); do
  if curl -s -m 3 "$RPC" -X POST -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"result":"ok"'; then
    echo "validator up"; break
  fi; sleep 1
done

solana airdrop 100 "$WALLET_PUBKEY" --url "$RPC" >/dev/null
echo "== deploy programs (upgradeable) =="
solana program deploy target/deploy/h2e.so --program-id target/deploy/h2e-keypair.json \
  --keypair "$WALLET" --upgrade-authority "$WALLET" --fee-payer "$WALLET" --url "$RPC" 2>&1 | grep -iE "Program Id|Error" || true
solana program deploy target/deploy/jupiter_stub.so --program-id target/deploy/jupiter_stub-keypair.json \
  --keypair "$WALLET" --upgrade-authority "$WALLET" --fee-payer "$WALLET" --url "$RPC" 2>&1 | grep -iE "Program Id|Error" || true
echo "upgrade authority check:"; solana program show 6SnKPT4rQy7beCiYXsWfLNeva6oh7nH5mHhsKwJ6E2BS --url "$RPC" 2>/dev/null | grep -i "Authority" || true
echo "wallet: $WALLET_PUBKEY"

echo "== run $TEST_FILE =="
npx ts-mocha -p ./tsconfig.json -t 1000000 "$TEST_FILE"
