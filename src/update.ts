// `vibeboard update`: vendor した vibeboard 本体を最新にする。
//
// 1. 取り込み元を用意する（GitHub から degit、または --from のローカルディレクトリ）
// 2. <root>/vibeboard へ同期する（node_modules / dist / .git は触らない。上流に無いファイルは消す）
// 3. npm install（prepare で build、postinstall でルートの run-vibeboard.sh を更新）
// 4. init（CLAUDE.md のスニペットと .claude/settings.json の hooks）
// 5. --restart なら同じ root の vibeboard をバックグラウンドで起動し直す（ポートガードが古い方を止める）
//
// この dist 自身が 2 と 3 で書き換わるので、要るモジュールは先頭で読み込み、途中で require しない。
// 3 以降は新しい dist を別プロセスで走らせる。
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { resolveConfig } from './config';

export const DEFAULT_REPO = 'akiraak/vibeboard';
/** 同期で触らない、vendor 先の直下の名前 */
export const SYNC_KEEP = ['node_modules', 'dist', '.git'];

export interface UpdateOptions {
  /** 親プロジェクトのルート。vendor 先は <root>/vibeboard */
  root: string;
  /** GitHub の代わりに、このディレクトリから取り込む */
  from?: string | null;
  /** degit の ref（tag / branch / commit）。無ければ既定ブランチ */
  ref?: string | null;
  restart?: boolean;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface SyncPlan {
  copy: string[];
  remove: string[];
}

/** dir 配下のファイルを相対パス（`/` 区切り）で。直下の keep は入らない。 */
export function listFiles(dir: string, keep: string[] = SYNC_KEEP): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = rel ? path.join(dir, rel) : dir;
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!rel && keep.includes(ent.name)) continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(r);
      else if (ent.isFile()) out.push(r);
    }
  };
  walk('');
  return out.sort();
}

/** 同期の計画（純関数）: 取り込み元に在るものは全部 copy、vendor 先にだけ在るものは remove。 */
export function planSync(srcFiles: string[], destFiles: string[]): SyncPlan {
  const src = new Set(srcFiles);
  return { copy: [...srcFiles].sort(), remove: destFiles.filter(f => !src.has(f)).sort() };
}

/** src → dest を同期する。mode（実行ビット）も写す。空になったディレクトリは畳む。 */
export function syncDir(src: string, dest: string, opts: { keep?: string[]; dryRun?: boolean } = {}): SyncPlan {
  const keep = opts.keep ?? SYNC_KEEP;
  const plan = planSync(listFiles(src, keep), fs.existsSync(dest) ? listFiles(dest, keep) : []);
  if (opts.dryRun) return plan;
  for (const rel of plan.copy) {
    const from = path.join(src, rel);
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    fs.chmodSync(to, fs.statSync(from).mode);
  }
  for (const rel of plan.remove) {
    fs.rmSync(path.join(dest, rel), { force: true });
    let d = path.dirname(path.join(dest, rel));
    while (d !== dest && fs.existsSync(d) && fs.readdirSync(d).length === 0) {
      fs.rmdirSync(d);
      d = path.dirname(d);
    }
  }
  return plan;
}

/** package.json の name が vibeboard か（ホスト側のプロジェクトにも package.json はあるので、名前で見る） */
export function isVibeboardDir(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as { name?: unknown };
    return pkg.name === 'vibeboard';
  } catch {
    return false;
  }
}

const npmCommand = (): string => (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const npxCommand = (): string => (process.platform === 'win32' ? 'npx.cmd' : 'npx');

function fetchSource(opts: UpdateOptions, log: (m: string) => void): { dir: string; label: string; cleanup: () => void } {
  if (opts.from) {
    const dir = path.resolve(opts.from);
    if (!isVibeboardDir(dir)) throw new Error(`${dir} は vibeboard ではありません（package.json の name が違う）`);
    return { dir, label: dir, cleanup: () => undefined };
  }
  const spec = opts.ref ? `${DEFAULT_REPO}#${opts.ref}` : DEFAULT_REPO;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeboard-update-'));
  const dir = path.join(tmp, 'src');
  log(`degit ${spec} ...`);
  execFileSync(npxCommand(), ['-y', 'degit', spec, dir], { stdio: 'inherit' });
  return { dir, label: spec, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function readPidFile(port: number): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `vibeboard-${port}.json`), 'utf-8')) as { pid?: unknown };
    return typeof raw.pid === 'number' ? raw.pid : null;
  } catch {
    return null;
  }
}

function httpOk(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get({ host, port, path: '/', timeout: 1500 }, res => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** 起動し直した新しいプロセスが、ポートを取って応答するまで待つ（古い方が応答しているだけでは進まない） */
async function waitForRestart(host: string, port: number, pid: number, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (readPidFile(port) === pid && (await httpOk(host, port))) return true;
    await sleep(500);
  }
  return false;
}

export async function runUpdate(opts: UpdateOptions): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(`[vibeboard update] ${m}`));
  const root = path.resolve(opts.root);
  const dest = path.join(root, 'vibeboard');
  if (fs.existsSync(path.join(dest, '.git'))) {
    throw new Error(`${dest} に .git があります（vibeboard 自体の開発クローンは update の対象外。git pull を使ってください）`);
  }
  if (fs.existsSync(dest) && !isVibeboardDir(dest)) throw new Error(`${dest} は vibeboard ではありません（package.json の name が違う）`);

  const src = fetchSource(opts, log);
  try {
    if (path.resolve(src.dir) === dest) throw new Error('取り込み元と vendor 先が同じです');
    const plan = syncDir(src.dir, dest, { dryRun: opts.dryRun });
    const did = opts.dryRun ? 'します' : 'しました';
    log(`${src.label} から ${dest} へ ${plan.copy.length} ファイルを上書き${did}（node_modules / dist は残す）`);
    if (plan.remove.length > 0) log(`上流に無い ${plan.remove.length} ファイルを削除${did}: ${plan.remove.join(', ')}`);
  } finally {
    src.cleanup();
  }
  if (opts.dryRun) {
    log('dry-run なので npm install / init / 起動し直しは行いません');
    return;
  }

  log('npm install（build と、ルートの run-vibeboard.sh の更新を含む）...');
  execFileSync(npmCommand(), ['install', '--no-audit', '--no-fund'], { cwd: dest, stdio: 'inherit' });

  const cli = path.join(dest, 'dist', 'cli.js');
  log('init（CLAUDE.md のスニペットと .claude/settings.json の hooks）...');
  execFileSync(process.execPath, [cli, 'init', '--root', root], { stdio: 'inherit' });

  if (!opts.restart) {
    log('起動し直しは省きました。動いている vibeboard は古いままなので、--restart か手で起動し直してください');
    return;
  }
  const { config } = resolveConfig(['--root', root]);
  const logFile = path.join(os.tmpdir(), `vibeboard-${config.port}.log`);
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [cli, '--root', root], {
    cwd: dest,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  });
  child.unref();
  fs.closeSync(fd);
  const pid = child.pid ?? 0;
  log(`同じ root の vibeboard を起動し直しています（pid ${pid}、ログ ${logFile}）...`);
  if (await waitForRestart(config.host, config.port, pid, 20000)) {
    log(`running at http://${config.host}:${config.port}（バックグラウンド。止めるときは kill ${pid}）`);
    return;
  }
  throw new Error(`20 秒以内に応答しませんでした。${logFile} を見てください`);
}
