import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

// 起動中の vibeboard が「どの root を管理しているか」をポート単位で記録する。
// 再起動時、ポートを掴んでいるのが同じ root の自分自身かどうかを、これで判定する。
interface PidFile {
  pid: number;
  root: string;
  port: number;
  host: string;
  startedAt: string;
}

const SIGTERM_WAIT_MS = 3000;
const SIGKILL_WAIT_MS = 2000;
const POLL_INTERVAL_MS = 100;

function pidFilePath(port: number): string {
  return path.join(os.tmpdir(), `vibeboard-${port}.json`);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// プロセスのコマンドライン引数を取得する。取れなければ null。
function argvOf(pid: number): string[] | null {
  try {
    if (process.platform === 'linux') {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return raw.split('\0').filter(Boolean);
    }
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? out.split(/\s+/) : null;
  } catch {
    return null;
  }
}

function cmdlineOf(pid: number): string | null {
  const argv = argvOf(pid);
  return argv === null ? null : argv.join(' ');
}

// プロセスの cwd を取得する。取れなければ null。
function cwdOf(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    }
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.split('\n').find(l => l.startsWith('n'));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

// dir から上へ辿って package.json の name が vibeboard かを見る。
// vendor 先のディレクトリ名に依存せず本体を特定できる。
function isVibeboardPackageDir(dir: string): boolean {
  let cur = path.resolve(dir);
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cur, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name === 'vibeboard') return true;
    } catch {
      // package.json が無い / 壊れている場合は親へ
    }
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

// pid ファイルが古く、同じ pid を無関係なプロセスが再利用している可能性があるため、
// kill する前に対象が本当に vibeboard かを確かめる。
function looksLikeVibeboard(pid: number): boolean {
  const argv = argvOf(pid);
  if (argv === null) return false;
  if (argv.some(a => /vibeboard/i.test(a))) return true;

  // run-vibeboard.sh は vibeboard/ へ cd してから `node dist/cli.js` を exec するため、
  // コマンドラインに "vibeboard" の文字列が現れない。cwd から実体を辿って確認する。
  const script = argv.find(a => /(^|[/\\])cli\.(js|ts)$/.test(a));
  if (script === undefined) return false;
  const cwd = cwdOf(pid);
  if (cwd === null) return false;
  const resolved = path.resolve(cwd, script);
  if (!fs.existsSync(resolved)) return false;
  return isVibeboardPackageDir(path.dirname(resolved));
}

// ポートを掴んでいるプロセスを best-effort で説明する（エラーメッセージ用）。
function describeHolder(port: number): string | null {
  const pids = new Set<string>();
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    out.split('\n').map(s => s.trim()).filter(Boolean).forEach(p => pids.add(p));
  } catch {
    try {
      const out = execFileSync('ss', ['-ltnpH', `sport = :${port}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const m of out.matchAll(/pid=(\d+)/g)) pids.add(m[1]);
    } catch {
      return null;
    }
  }
  const described = [...pids].map(p => {
    const cmdline = cmdlineOf(Number(p));
    return cmdline ? `pid=${p} (${cmdline})` : `pid=${p}`;
  });
  return described.length > 0 ? described.join(', ') : null;
}

export function writePidFile(config: { port: number; host: string; root: string }): void {
  const data: PidFile = {
    pid: process.pid,
    root: path.resolve(config.root),
    port: config.port,
    host: config.host,
    startedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(pidFilePath(config.port), JSON.stringify(data));
  } catch {
    // pid ファイルを書けなくても起動自体は続行する（次回の自動停止が効かなくなるだけ）
  }
}

export function removePidFile(port: number): void {
  try {
    const raw = fs.readFileSync(pidFilePath(port), 'utf8');
    const data = JSON.parse(raw) as PidFile;
    // 別プロセスが書き直した pid ファイルを消さない
    if (data.pid !== process.pid) return;
    fs.unlinkSync(pidFilePath(port));
  } catch {
    // 無ければ何もしない
  }
}

function readPidFile(port: number): PidFile | null {
  try {
    const data = JSON.parse(fs.readFileSync(pidFilePath(port), 'utf8')) as PidFile;
    if (typeof data.pid !== 'number' || typeof data.root !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

export interface ReclaimResult {
  ok: boolean;
  message: string;
}

/**
 * ポートが埋まっているとき、掴んでいるのが「同じ root を管理している vibeboard」
 * であればそれを停止してポートを空ける。
 *
 * 別プロジェクトの vibeboard や無関係なプロセスには決して触らない
 * （複数プロジェクトで vibeboard を並走させる運用を壊さないため）。
 */
export async function reclaimPort(config: { port: number; host: string; root: string }): Promise<ReclaimResult> {
  const { port, host } = config;
  const root = path.resolve(config.root);
  const holder = () => describeHolder(port) ?? '不明';

  const record = readPidFile(port);
  if (!record) {
    return { ok: false, message: `ポート ${port} は vibeboard 以外に使われています: ${holder()}` };
  }
  if (record.pid === process.pid) {
    return { ok: false, message: `ポート ${port} の pid ファイルが自分自身を指しています` };
  }
  if (path.resolve(record.root) !== root) {
    return {
      ok: false,
      message:
        `ポート ${port} は別プロジェクトの vibeboard が使用中です (root: ${record.root}, pid: ${record.pid})。\n` +
        `  別プロジェクトを止めないため、自動停止はしません。--port か VIBEBOARD_PORT で別ポートを指定してください。`,
    };
  }
  if (!isAlive(record.pid)) {
    return { ok: false, message: `ポート ${port} は vibeboard 以外に使われています: ${holder()}` };
  }
  if (!looksLikeVibeboard(record.pid)) {
    return {
      ok: false,
      message: `ポート ${port} の pid ${record.pid} は vibeboard ではありません (pid ファイルが古い可能性): ${holder()}`,
    };
  }

  console.log(`[vibeboard] 同じ root の vibeboard (pid: ${record.pid}) がポート ${port} を使用中のため停止します`);

  try {
    process.kill(record.pid, 'SIGTERM');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `pid ${record.pid} の停止に失敗しました: ${msg}` };
  }

  const deadline = Date.now() + SIGTERM_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (await isPortFree(host, port)) {
      return { ok: true, message: `pid ${record.pid} を停止しました` };
    }
  }

  // SIGTERM で落ちない場合のみ SIGKILL。対象が同 root の vibeboard であることは確認済み。
  console.log(`[vibeboard] SIGTERM で終了しないため SIGKILL します (pid: ${record.pid})`);
  try {
    process.kill(record.pid, 'SIGKILL');
  } catch {
    // 既に終了していれば無視
  }

  const killDeadline = Date.now() + SIGKILL_WAIT_MS;
  while (Date.now() < killDeadline) {
    await sleep(POLL_INTERVAL_MS);
    if (await isPortFree(host, port)) {
      return { ok: true, message: `pid ${record.pid} を強制終了しました` };
    }
  }

  return { ok: false, message: `pid ${record.pid} を停止しましたが、ポート ${port} が解放されませんでした` };
}
