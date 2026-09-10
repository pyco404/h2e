#!/usr/bin/env bash
# Run the test suite against a locally-managed validator.
#
# Why not plain `anchor test`? initialize_global requires the signer to be the
# program's UPGRADE AUTHORITY. `anchor deploy` (invoked by --skip-local-validator)
# deploys the program upgradeable with the provider wallet as upgrade authority,
# which is the real-world condition. `anchor test`'s bundled validator does not,
# so the authority check would reject every init.
set -euo pipefail
WALLET_PUBKEY="$(solana-keygen pubkey ~/.config/solana/id.json)"
RPC="http://127.0.0.1:8899"

pkill -9 -f solana-test-validator 2>/dev/null || true
sleep 3
rm -rf test-ledger
solana-test-validator --reset --ledger test-ledger --rpc-port 8899 >/dev/null 2>&1 &
VALIDATOR_PID=$!
trap 'kill -9 $VALIDATOR_PID 2>/dev/null || true' EXIT

for i in $(seq 1 60); do
  if curl -s -m 3 "$RPC" -X POST -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"result":"ok"'; then
    echo "validator up"; break
  fi; sleep 1
done

solana airdrop 100 "$WALLET_PUBKEY" --url "$RPC" >/dev/null
anchor test --skip-local-validator
