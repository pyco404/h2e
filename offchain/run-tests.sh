#!/usr/bin/env bash
# Offline test runner. Uses h2e's toolchain (ts-mocha 10 + typescript 5.9); the
# repo root has the TS 7 beta which ts-mocha can't drive.
set -euo pipefail
cd "$(dirname "$0")"
TSM="../h2e/node_modules/.bin/ts-mocha"
TS_NODE_PROJECT=tsconfig.json "$TSM" -p tsconfig.json -t 60000 "${1:-test/*.test.ts}"
