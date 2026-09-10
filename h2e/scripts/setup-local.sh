#!/usr/bin/env bash
# Persistent local environment for the app: boots a validator with the Meteora
# rail cloned, deploys H2E, initialises GlobalConfig + PlatformAllowlist, then
# stays up (waits on the validator) so localhost:5178 loads for real.
set -uo pipefail
cd "$(dirname "$0")/.."   # -> h2e/
RPC="http://127.0.0.1:8899"
DEVNET="$(tr -d '[:space:]' < ../.helius-url)"
LOG=/tmp/claude-1000/-home-pikoo-Desktop-H2E/6978b2b6-8014-4c44-84a7-f89fb4a25c87/scratchpad/validator.log

DBC=dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
METAPLEX=metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
CPAMM=cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG
DAMMCFG=Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp
WSOL=So11111111111111111111111111111111111111112
CONFIG=CKpkBHBdts4P97hiUCQJWVC2rQrJ6sfDQX7xcDSoR6VS
WALLET_PK="$(solana-keygen pubkey "$HOME/.config/solana/id.json")"

pkill -9 -f solana-test-validator 2>/dev/null || true
sleep 3
rm -rf test-ledger
echo "booting validator (cloning the Meteora rail)…"
solana-test-validator --reset --ledger test-ledger --rpc-port 8899 \
  --url "$DEVNET" \
  --clone-upgradeable-program "$DBC" \
  --clone-upgradeable-program "$METAPLEX" \
  --clone-upgradeable-program "$CPAMM" \
  --clone "$DAMMCFG" --clone "$WSOL" --clone "$CONFIG" > "$LOG" 2>&1 &
VP=$!

for i in $(seq 1 120); do
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
echo "READY. Point the app at this validator (default): http://localhost:5178/#/launch"
echo "Leaving the validator running (Ctrl-C or pkill -9 -f solana-test-validator to stop)."
wait $VP
