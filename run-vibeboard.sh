#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# vibeboard/ 内から直接実行する場合と、親プロジェクト直下へコピーして
# 実行する場合の両方をサポートする。
if [[ -f "$SCRIPT_DIR/package.json" && -d "$SCRIPT_DIR/src" ]]; then
  VIBEBOARD_DIR="$SCRIPT_DIR"
  PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  VIBEBOARD_DIR="$SCRIPT_DIR/vibeboard"
  PROJECT_DIR="$SCRIPT_DIR"
fi

if [[ ! -f "$VIBEBOARD_DIR/package.json" ]]; then
  echo "[run-vibeboard] vibeboard が見つかりません: $VIBEBOARD_DIR" >&2
  exit 1
fi

cd "$VIBEBOARD_DIR"

if [[ ! -d node_modules ]]; then
  echo "[run-vibeboard] node_modules が無いため npm install を実行します..."
  npm install
fi

if [[ ! -f dist/cli.js ]] || [[ -n "$(find src -name '*.ts' -newer dist/cli.js -print -quit)" ]]; then
  echo "[run-vibeboard] dist をビルドします..."
  npm run build
fi

ROOT_ARGS=()
if [[ -z "${VIBEBOARD_ROOT:-}" && " ${*:-} " != *" --root "* ]]; then
  ROOT_ARGS=(--root "$PROJECT_DIR")
fi

echo "[run-vibeboard] vibeboard を起動します (root: ${VIBEBOARD_ROOT:-$PROJECT_DIR}, port: ${VIBEBOARD_PORT:-3010})"
exec node dist/cli.js "${ROOT_ARGS[@]}" "$@"
