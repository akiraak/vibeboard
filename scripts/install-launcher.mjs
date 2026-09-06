#!/usr/bin/env node
// vibeboard/run-vibeboard.sh を親プロジェクト直下へインストールする。
//
// - `npm install` の postinstall から自動実行される
// - `npm run install-launcher` で手動実行できる (ガードを無視する --force 付き)
//
// vibeboard 本体の開発クローンや、プロジェクトルートに見えないディレクトリを
// 散らかさないよう、条件を満たさない場合はスキップする。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VIBEBOARD_DIR = path.resolve(fileURLToPath(import.meta.url), '../..');
const PROJECT_DIR = path.resolve(VIBEBOARD_DIR, '..');
const SRC = path.join(VIBEBOARD_DIR, 'run-vibeboard.sh');
const DEST = path.join(PROJECT_DIR, 'run-vibeboard.sh');

// 親が「プロジェクトルートらしい」と判断する目印。
const ROOT_MARKERS = ['.git', 'package.json', 'CLAUDE.md', 'TODO.md', 'DONE.md', 'docs'];

const force = process.argv.includes('--force');
const log = (msg) => console.log(`[install-launcher] ${msg}`);

function skipReason() {
  if (!fs.existsSync(SRC)) return `コピー元が見つかりません: ${SRC}`;
  if (force) return null;

  if (process.env.VIBEBOARD_SKIP_LAUNCHER) {
    return 'VIBEBOARD_SKIP_LAUNCHER が設定されています';
  }
  // degit で vendor した場合 .git は剥がれている。.git があるなら vibeboard 自体の
  // 開発クローンなので、無関係な親ディレクトリへスクリプトを置かない。
  if (fs.existsSync(path.join(VIBEBOARD_DIR, '.git'))) {
    return 'vibeboard 自体の開発クローンのため、親へはインストールしません';
  }
  if (!ROOT_MARKERS.some((m) => fs.existsSync(path.join(PROJECT_DIR, m)))) {
    return `親がプロジェクトルートに見えません (${ROOT_MARKERS.join(' / ')} のいずれも無い): ${PROJECT_DIR}`;
  }
  return null;
}

const reason = skipReason();
if (reason) {
  log(`スキップ: ${reason}`);
  process.exit(0);
}

const src = fs.readFileSync(SRC);
const existed = fs.existsSync(DEST);

if (existed && fs.readFileSync(DEST).equals(src)) {
  fs.chmodSync(DEST, 0o755);
  log(`最新です: ${DEST}`);
  process.exit(0);
}

fs.writeFileSync(DEST, src);
fs.chmodSync(DEST, 0o755);

if (existed) {
  log(`上書きしました: ${DEST}`);
  log('ローカル改変していた場合は親リポジトリの git diff で確認してください。');
} else {
  log(`作成しました: ${DEST}`);
}
