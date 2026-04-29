#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d node_modules ]; then
  echo "[run-sample] node_modules が無いので npm install を実行します..."
  npm install
fi

if [ ! -f dist/cli.js ] || [ src/cli.ts -nt dist/cli.js ]; then
  echo "[run-sample] dist/cli.js を再ビルドします..."
  npm run build
fi

exec node dist/cli.js --root sample "$@"
