#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { resolveConfig } from './config';
import { startServer } from './server';
import { runInit } from './init';

const args = process.argv.slice(2);

function printVersion(): void {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
  console.log(pkg.version ?? '0.0.0');
}

function printHelp(): void {
  console.log(`vibeboard - バイブコーディングに最適化されたローカル開発用の管理画面

使い方:
  vibeboard [options]              管理画面サーバを起動
  vibeboard init [options]         親プロジェクトの CLAUDE.md に規約スニペットを追記

サーバ起動オプション:
  --root <path>     対象プロジェクトのルート (デフォルト: cwd)
  --port <n>        バインドするポート (デフォルト: 3010)
  --title <s>       UI のブランド名 (デフォルト: <root>/package.json の name、無ければディレクトリ名)
  --config <path>   設定ファイル (デフォルト: <root>/vibeboard.config.json があれば自動読込)
  --help, -h        このヘルプを表示
  --version, -v     バージョンを表示

init オプション:
  --root <path>     親プロジェクトのルート (デフォルト: cwd)
  --dry-run         書き込まずに変更後の内容をプレビュー表示
  --help, -h        init のヘルプを表示

環境変数:
  VIBEBOARD_ROOT    --root と同等
  VIBEBOARD_PORT    --port と同等 (DEV_ADMIN_PORT も後方互換で読む)
  VIBEBOARD_TITLE   --title と同等

優先順位: CLI 引数 > 環境変数 > vibeboard.config.json > デフォルト

詳細は README.md を参照。`);
}

function printInitHelp(): void {
  console.log(`vibeboard init - 親プロジェクトの CLAUDE.md に vibeboard 規約スニペットを追記

挙動:
  - <root>/CLAUDE.md が存在しない場合: 新規作成してスニペットを書き込む
  - 既存ファイルに vibeboard マーカーがある場合: マーカー間を最新スニペットで置換
  - 既存ファイルにマーカーが無い場合: ファイル末尾にマーカー付きで追記

オプション:
  --root <path>     親プロジェクトのルート (デフォルト: cwd / VIBEBOARD_ROOT)
  --dry-run         書き込まずに、書き込まれる内容をプレビュー表示する
  --help, -h        このヘルプを表示
`);
}

function runHelp(): never {
  printHelp();
  process.exit(0);
}

function runVersion(): never {
  printVersion();
  process.exit(0);
}

const sub = args[0];

if (sub === 'init') {
  const initArgs = args.slice(1);
  if (initArgs.includes('--help') || initArgs.includes('-h')) {
    printInitHelp();
    process.exit(0);
  }
  const dryRun = initArgs.includes('--dry-run');
  // resolveConfig で --root / VIBEBOARD_ROOT を解決する (port/title は捨てる)
  const passthrough = initArgs.filter(a => a !== '--dry-run');
  try {
    const { config } = resolveConfig(passthrough);
    runInit({ root: config.root, dryRun });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[vibeboard init] 失敗しました: ${msg}`);
    process.exit(1);
  }
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) runHelp();
if (args.includes('--version') || args.includes('-v')) runVersion();

try {
  const { config } = resolveConfig(args);
  startServer(config);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[vibeboard] 起動に失敗しました: ${msg}`);
  process.exit(1);
}
