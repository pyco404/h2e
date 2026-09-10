#!/usr/bin/env bash
# Offline demo env (no egress): bare validator preloaded with synthetic CoinConfig
# accounts, H2E deployed, GlobalConfig + PlatformAllowlist initialised. Lets the
# app's Explore / coin / My-coins pages show real coins without a DBC launch.
set -uo pipefail
cd "$(dirname "$0")/.."   # -> h2e/
RPC="http://127.0.0.1:8899"
LOG=/tmp/claude-1000/-home-pikoo-Desktop-H2E/6978b2b6-8014-4c44-84a7-f89fb4a25c87/scratchpad/validator-demo.log
WALLET_PK="$(solana-keygen pubkey "$HOME/.config/solana/id.json")"

pkill -9 -f solana-test-validator 2>/dev/null || true
sleep 3
rm -rf test-ledger

echo "generating synthetic demo coins (creator=$WALLET_PK)…"
node -e "require('esbuild').build({entryPoints:['scripts/gen-demo-coins.ts'],bundle:true,outfile:'scripts/.gen.cjs',platform:'node',format:'cjs',target:['node18'],logLevel:'error'})" \
  && node scripts/.gen.cjs "$WALLET_PK" && rm -f scripts/.gen.cjs

ACCTS=()
for f in scripts/.demo-coins/*.acct.json; do
  ADDR=$(node -e "console.log(require('./$f').pubkey)")
  ACCTS+=(--account "$ADDR" "$f")
done

echo "booting bare validator with ${#ACCTS[@]} preload args…"
solana-test-validator --reset --ledger test-ledger --rpc-port 8899 "${ACCTS[@]}" > "$LOG" 2>&1 &
VP=$!
for i in $(seq 1 90); do
  if curl -s -m3 "$RPC" -X POST -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"result":"ok"'; then
    echo "validator up"; break
  fi; sleep 1
done

solana airdrop 100 "$WALLET_PK" --url "$RPC" >/dev/null 2>&1 || true
echo "deploying H2E…"
anchor deploy --provider.cluster "$RPC" 2>&1 | grep -iE "Program Id|Deploy success|Error" || true

echo "initialising GlobalConfig + PlatformAllowlist…"
node -e "require('esbuild').build({entryPoints:['scripts/init-local.ts'],bundle:true,outfile:'scripts/.init-local.cjs',platform:'node',format:'cjs',target:['node18'],logLevel:'error'})" \
  && node scripts/.init-local.cjs && rm -f scripts/.init-local.cjs

echo ""
echo "READY. Open http://localhost:5178/#/coin (Explore) — three coins should list."
echo "Leaving the validator running (pkill -9 -f solana-test-validator to stop)."
wait $VP
