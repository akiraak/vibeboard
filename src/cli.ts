#!/usr/bin/env node
import fs from 'fs';
import http from 'http';
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
  vibeboard init [options]         親プロジェクトに規約スニペット（CLAUDE.md）と hooks（.claude/settings.json）を書く
  vibeboard listen [options]       Tasks タブの待ち受け（hook が使えない環境の逃げ道）

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
  --no-hooks        .claude/settings.json には触れない（CLAUDE.md だけ）
  --help, -h        init のヘルプを表示

listen オプション:
  --name <s>        画面の名前 (デフォルト: --root のディレクトリ名)
  --port <n>        vibeboard のポート (デフォルト: 設定 / VIBEBOARD_PORT / 3010)
  --help, -h        listen のヘルプを表示

環境変数:
  VIBEBOARD_ROOT    --root と同等
  VIBEBOARD_PORT    --port と同等 (DEV_ADMIN_PORT も後方互換で読む)
  VIBEBOARD_TITLE   --title と同等

優先順位: CLI 引数 > 環境変数 > vibeboard.config.json > デフォルト

詳細は README.md を参照。`);
}

function printInitHelp(): void {
  console.log(`vibeboard init - 親プロジェクトに vibeboard の規約スニペットと hooks を書く

挙動:
  CLAUDE.md
  - <root>/CLAUDE.md が存在しない場合: 新規作成してスニペットを書き込む
  - 既存ファイルに vibeboard マーカーがある場合: マーカー間を最新スニペットで置換
  - 既存ファイルにマーカーが無い場合: ファイル末尾にマーカー付きで追記
  .claude/settings.json（Tasks タブの送り先の登録）
  - SessionStart / SessionEnd に scripts/session-hook.mjs を呼ぶ hook を併合する
  - 他の hooks は残す。vibeboard の項目だけを置き換えるので何度流しても増えない
  - 既に開いている Claude Code のセッションには効かない（起動し直すと登録される）

オプション:
  --root <path>     親プロジェクトのルート (デフォルト: cwd / VIBEBOARD_ROOT)
  --dry-run         書き込まずに、書き込まれる内容をプレビュー表示する
  --no-hooks        .claude/settings.json には触れない（CLAUDE.md だけ）
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
  const hooks = !initArgs.includes('--no-hooks');
  // resolveConfig で --root / VIBEBOARD_ROOT を解決する (port/title は捨てる)
  const passthrough = initArgs.filter(a => a !== '--dry-run' && a !== '--no-hooks');
  try {
    const { config } = resolveConfig(passthrough);
    runInit({ root: config.root, dryRun, hooks });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[vibeboard init] 失敗しました: ${msg}`);
    process.exit(1);
  }
  process.exit(0);
}

function failToStart(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[vibeboard] 起動に失敗しました: ${msg}`);
  process.exit(1);
}

function printListenHelp(): void {
  console.log(`vibeboard listen - Tasks タブの待ち受け（hook が使えない環境の逃げ道）

  既定の経路は \`vibeboard init\` が書く SessionStart hook（セッションが自分の受信口を登録し、
  vibeboard がそこへ投函する）。それが使えないとき（古い Claude Code、hooks を書きたくない、など）に
  この待ち受けを使う。

挙動:
  - vibeboard の /api/tasks/inbox を購読し、届いたタスクを 1 行の JSON で標準出力に出す
  - Claude Code はこの出力を監視（Monitor 等）して、届いたタスクをその画面で実行する
  - サーバが落ちても 2 秒おきに繋ぎ直す。同じ名前で繋ぎ直せば不在中のぶんも受け取れる

オプション:
  --name <s>        画面の名前（既定: --root のディレクトリ名）。同じプロジェクトで
                    複数の画面を待ち受けるときは、窓ごとに違う名前を付けて選び分ける
  --port <n>        vibeboard のポート（既定: 設定 / VIBEBOARD_PORT / 3010）
  --root <path>     対象プロジェクトのルート（既定: cwd / VIBEBOARD_ROOT）
  --help, -h        このヘルプを表示
`);
}

/** SSE を購読して data 行だけを標準出力へ。切れたら待って繋ぎ直す。 */
function runListen(opts: { port: number; name: string }): void {
  const url = `http://127.0.0.1:${opts.port}/api/tasks/inbox?name=${encodeURIComponent(opts.name)}`;
  const connect = (): void => {
    let scheduled = false;
    const again = (): void => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(connect, 2000);
    };
    const req = http.get(url, { headers: { Accept: 'text/event-stream' } }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        again();
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const dataLine = frame.split('\n').find(l => l.startsWith('data:'));
          if (dataLine) {
            const data = dataLine.slice(5).trim();
            if (data) console.log(data); // 1 タスク = 1 行の JSON（stdout は JSON だけにする）
          }
          sep = buf.indexOf('\n\n');
        }
      });
      res.on('end', again);
      res.on('error', again);
    });
    req.on('error', again);
  };
  // 案内は stderr へ（stdout はタスクの JSON だけにして、監視側が読みやすいように）
  console.error(`[vibeboard listen] name=${opts.name} -> http://127.0.0.1:${opts.port}/api/tasks/inbox`);
  connect();
}

if (sub === 'listen') {
  const listenArgs = args.slice(1);
  if (listenArgs.includes('--help') || listenArgs.includes('-h')) {
    printListenHelp();
    process.exit(0);
  }
  let name = '';
  const rest: string[] = [];
  for (let i = 0; i < listenArgs.length; i++) {
    const a = listenArgs[i];
    if (a === '--name') {
      name = listenArgs[i + 1] ?? '';
      i++;
      continue;
    }
    const m = a.match(/^--name=(.*)$/);
    if (m) {
      name = m[1];
      continue;
    }
    rest.push(a);
  }
  try {
    // --root / --port / VIBEBOARD_* / vibeboard.config.json は resolveConfig が解決する
    const { config } = resolveConfig(rest);
    runListen({ port: config.port, name: name.trim() || path.basename(config.root) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[vibeboard listen] 失敗しました: ${msg}`);
    process.exit(1);
  }
} else {
  if (args.includes('--help') || args.includes('-h')) runHelp();
  if (args.includes('--version') || args.includes('-v')) runVersion();

  try {
    const { config } = resolveConfig(args);
    startServer(config).catch(failToStart);
  } catch (err) {
    failToStart(err);
  }
}
