#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);

function printVersion(): void {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
  console.log(pkg.version ?? '0.0.0');
}

function printHelp(): void {
  console.log(`vibeboard - バイブコーディングに最適化されたローカル開発用の管理画面

使い方:
  vibeboard [options]
  vibeboard init [options]   親プロジェクトの CLAUDE.md に規約スニペットを追記する (未実装: Phase 3)

Options:
  --help, -h        このヘルプを表示
  --version, -v     バージョンを表示

環境変数:
  DEV_ADMIN_PORT    バインドするポート (デフォルト: 3010)

詳細は README.md を参照。`);
}

if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  printVersion();
  process.exit(0);
}

const sub = args[0];
if (sub === 'init') {
  console.error('vibeboard init は未実装です (Phase 3 で対応予定)');
  process.exit(1);
}

require('./server');
