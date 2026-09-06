#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# vibeboard/ 内から直接実行する場合と、親プロジェクト直下へ配置して実行する場合の
# 両方をサポートする。
#
# 判定に「package.json と src/ があるか」は使えない。**ホスト側のプロジェクトにも
# その 2 つがあるのが普通**で、ルート直下に置いたときにここを vibeboard 本体と
# 誤認する（ホスト側を build して、無い dist/cli.js を実行して落ちる）。
# vibeboard 固有のもの = package.json の name で判定する。
is_vibeboard_dir() {
  [[ -f "$1/package.json" ]] &&
    grep -q '"name"[[:space:]]*:[[:space:]]*"vibeboard"' "$1/package.json"
}

if is_vibeboard_dir "$SCRIPT_DIR"; then
  VIBEBOARD_DIR="$SCRIPT_DIR"
  PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
elif is_vibeboard_dir "$SCRIPT_DIR/vibeboard"; then
  VIBEBOARD_DIR="$SCRIPT_DIR/vibeboard"
  PROJECT_DIR="$SCRIPT_DIR"
else
  echo "[run-vibeboard] vibeboard が見つかりません: $SCRIPT_DIR/vibeboard" >&2
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

# ポートは CLI 引数 / 環境変数 / vibeboard.config.json / デフォルトの優先順位で
# Node 側が解決するため、ここでは表示しない（実ポートは起動直後の
# "[vibeboard] running at ..." が出す）。
echo "[run-vibeboard] vibeboard を起動します (root: ${VIBEBOARD_ROOT:-$PROJECT_DIR})"
exec node dist/cli.js "${ROOT_ARGS[@]}" "$@"
