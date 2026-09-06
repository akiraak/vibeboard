import { type ChildProcess, spawn } from 'child_process';
import type { CustomTabConfig, VibeboardConfig } from './config';

// customTab の中身を出すプロセス（サイドカー）を、vibeboard と一緒に起こして一緒に止める。
//
// customTab はブラウザが baseUrl へ直接つなぐ作りなので、その先のプロセスが
// 起動していないとタブは「接続できません」で終わる。起動を人の手に任せると
// 「本体は動いているのにタブだけ死んでいる」が普通に起きるため、
// **タブの宣言と同じ場所（vibeboard.config.json）に起動コマンドを書けるようにする**。
//
//   { "name": "tasks", "baseUrl": "http://127.0.0.1:3012",
//     "command": ["node", "tools/tasks/server.js"] }
//
// 決めていること:
//   - **shell を通さない**（コマンドは配列でだけ受ける）
//   - 既に baseUrl が応えるなら**起動しない**（自分で立ち上げてある / 前回の残りを二重に起こさない）
//   - 標準出力は `[<name>] ` を付けて本体のログに混ぜる
//   - vibeboard が終わるときに落とす。SIGKILL された場合だけ残るが、
//     次の起動で「既に応える」と判定されるので二重には増えない

const PROBE_TIMEOUT_MS = 800;

interface Sidecar {
  name: string;
  child: ChildProcess;
}

const running: Sidecar[] = [];

/** baseUrl に何か応えるものが居るか（ステータスは問わない。繋がれば居る）。 */
async function isUp(baseUrl: string): Promise<boolean> {
  try {
    await fetch(baseUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

/** 子の出力を 1 行ずつ `[name] ` 付きで流す（行の途中で切れても混ざらないように溜める）。 */
function pipeLines(name: string, stream: NodeJS.ReadableStream | null): void {
  if (!stream) return;
  let carry = '';
  stream.setEncoding('utf-8');
  stream.on('data', (chunk: string) => {
    const lines = (carry + chunk).split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) console.log(`[${name}] ${line}`);
    }
  });
  stream.on('end', () => {
    if (carry.trim()) console.log(`[${name}] ${carry}`);
    carry = '';
  });
}

async function startOne(tab: CustomTabConfig, root: string): Promise<void> {
  if (!tab.command) return;
  if (await isUp(tab.baseUrl)) {
    console.log(`[vibeboard] customTab ${tab.name}: 既に起動しています (${tab.baseUrl})`);
    return;
  }

  const [file, ...args] = tab.command;
  let child: ChildProcess;
  try {
    child = spawn(file as string, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
  } catch (err) {
    console.error(`[vibeboard] customTab ${tab.name} を起動できません: ${String(err)}`);
    return;
  }

  pipeLines(tab.name, child.stdout);
  pipeLines(tab.name, child.stderr);

  child.on('error', err => {
    console.error(`[vibeboard] customTab ${tab.name} の起動に失敗しました: ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    const idx = running.findIndex(s => s.child === child);
    if (idx >= 0) running.splice(idx, 1);
    // 自分で止めたとき（SIGTERM）は黙って終わる。落ちたときだけ知らせる
    if (signal === 'SIGTERM') return;
    console.error(`[vibeboard] customTab ${tab.name} が終了しました (code: ${code})`);
  });

  running.push({ name: tab.name, child });
  console.log(`[vibeboard] customTab ${tab.name}: ${tab.command.join(' ')} (pid: ${child.pid})`);
}

/** `command` を持つ customTab を起動する。listen に成功してから呼ぶこと。 */
export async function startSidecars(config: VibeboardConfig): Promise<void> {
  for (const tab of config.customTabs) {
    await startOne(tab, config.root);
  }
}

/** 起動した子を落とす。プロセス終了ハンドラから呼ぶので同期で済ませる。 */
export function stopSidecars(): void {
  for (const { child } of running.splice(0)) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* もう居ない */
    }
  }
}
