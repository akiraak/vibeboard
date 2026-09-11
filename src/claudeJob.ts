import { type ChildProcess, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';

// タスク追加のバックグラウンド実行（プラン: docs/plans/vibeboard-task-add.md）。
// ⚠ **セッションへの投函（tasks.ts の queue）とは別系統**。vibeboard が自分で `claude -p` を
// 起こして TODO.md を編集させる。人のターミナルのセッションとは独立に並行して動く。
//
// 決めていること:
//   - **shell を通さない**（sidecar と同じ。引数は配列で、prompt は stdin で渡す）
//   - **許すツールは TODO.md の Edit だけ**（読み取り系は -p でも既定で通る）。
//     さらに --disallowedTools で Bash / Write 等を明示的に拒否する
//     （deny は設定の allow より強いので、プロジェクト設定に何が書いてあっても効く）
//   - ⚠ **直列にするのは追加ジョブどうしだけ**（同じ TODO.md の取り合いを避ける）。
//     ここが投函と同じ列に並んだらバックグラウンドにする意味がない
//   - **成功は事後検査で決める**: 終了コードではなく「TODO.md に頼んだ文面が増えたか」。
//     同じ文面が元からある場合（Phase 0: など）に備えて、有無ではなく**個数の増加**で見る
//   - タイムアウトで SIGTERM → 5 秒待って SIGKILL

export type AddJobState = 'waiting' | 'running' | 'done' | 'failed';

export interface AddJob {
  id: string;
  /** 頼んだ文面（1 行目がタスク、2 行目以降はメモ） */
  text: string;
  /** 事後検査で TODO.md から探す文字列（1 行目） */
  needle: string;
  parentId: string | null;
  parentText: string | null;
  prompt: string;
  state: AddJobState;
  error: string | null;
  /** stdout+stderr の尻尾（失敗の説明用） */
  output: string;
  at: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface AddJobInput {
  text: string;
  needle: string;
  parentId: string | null;
  parentText: string | null;
  prompt: string;
}

export interface RunnerOptions {
  /** claude を走らせる場所（プロジェクト root。CLAUDE.md をここから読ませる） */
  cwd: string;
  /** 事後検査で読む TODO.md の絶対パス */
  todoAbsPath: string;
  /** 実行ファイル（既定 'claude'。テストは偽物に差し替える） */
  bin?: string;
  /** --model に渡す値（null なら CLI の既定モデル） */
  model?: string | null;
  timeoutMs?: number;
  /** 終わったジョブを一覧に残す時間 */
  keepMs?: number;
}

export const ALLOWED_TOOLS = 'Edit(TODO.md)';
export const DISALLOWED_TOOLS = 'Bash,Write,NotebookEdit,WebFetch,WebSearch,Task,Agent';
export const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_KEEP_MS = 10 * 60 * 1000;
/** 成功したジョブを一覧に残す時間。⚠ 短くする（結果は TODO.md 自体に出ている。UI のポーリングが
 *  完了を 1 回見られれば足りる）。失敗は keepMs（既定 10 分）残す */
const DONE_KEEP_MS = 60 * 1000;
const KILL_GRACE_MS = 5_000;
/** 実行中に溜める出力の上限（失敗表示用の尻尾だけ要る） */
const OUTPUT_TAIL = 2_000;

/** `claude -p` の引数。2026-09-11 に実測: `Edit(TODO.md)` のパス限定は -p で効き、対象外の Edit は拒否される。 */
export function buildArgs(model?: string | null): string[] {
  const args = ['-p', '--allowedTools', ALLOWED_TOOLS, '--disallowedTools', DISALLOWED_TOOLS];
  if (model) args.push('--model', model);
  return args;
}

function countOf(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

export class ClaudeJobRunner {
  private jobs: AddJob[] = [];
  private draining = false;
  private readonly cwd: string;
  private readonly todoAbsPath: string;
  private readonly bin: string;
  private readonly model: string | null;
  private readonly timeoutMs: number;
  private readonly keepMs: number;

  constructor(opts: RunnerOptions) {
    this.cwd = opts.cwd;
    this.todoAbsPath = opts.todoAbsPath;
    this.bin = opts.bin ?? 'claude';
    this.model = opts.model ?? null;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.keepMs = opts.keepMs ?? DEFAULT_KEEP_MS;
  }

  enqueue(input: AddJobInput): AddJob {
    const job: AddJob = {
      id: crypto.randomBytes(8).toString('hex'),
      text: input.text,
      needle: input.needle,
      parentId: input.parentId,
      parentText: input.parentText,
      prompt: input.prompt,
      state: 'waiting',
      error: null,
      output: '',
      at: Date.now(),
      startedAt: null,
      endedAt: null,
    };
    this.jobs.push(job);
    this.prune();
    void this.drain();
    return job;
  }

  list(): AddJob[] {
    this.prune();
    return [...this.jobs];
  }

  get(id: string): AddJob | undefined {
    return this.jobs.find(j => j.id === id);
  }

  /** 終わったジョブを一覧から消す（待ち・実行中は消せない）。 */
  dismiss(id: string): boolean {
    const j = this.get(id);
    if (!j || j.state === 'waiting' || j.state === 'running') return false;
    this.jobs = this.jobs.filter(x => x.id !== id);
    return true;
  }

  /** 終わって保持時間（成功 60 秒 / 失敗 keepMs）を過ぎたジョブを落とす（実行中・待ちは残す）。 */
  private prune(): void {
    const now = Date.now();
    this.jobs = this.jobs.filter(j => {
      if (j.state === 'waiting' || j.state === 'running') return true;
      const keep = j.state === 'done' ? Math.min(DONE_KEEP_MS, this.keepMs) : this.keepMs;
      return (j.endedAt ?? now) + keep > now;
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const job = this.jobs.find(j => j.state === 'waiting');
        if (!job) break;
        await this.runOne(job);
      }
    } finally {
      this.draining = false;
    }
  }

  private readTodo(): string {
    try {
      return fs.readFileSync(this.todoAbsPath, 'utf-8');
    } catch {
      return '';
    }
  }

  private runOne(job: AddJob): Promise<void> {
    return new Promise(resolve => {
      job.state = 'running';
      job.startedAt = Date.now();
      const before = countOf(this.readTodo(), job.needle);
      let out = '';
      let timedOut = false;
      let killTimer: NodeJS.Timeout | null = null;
      let settled = false;
      const finish = (ok: boolean, error: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        job.endedAt = Date.now();
        job.output = out.slice(-OUTPUT_TAIL);
        job.state = ok ? 'done' : 'failed';
        job.error = ok ? null : error;
        resolve();
      };
      let child: ChildProcess;
      try {
        child = spawn(this.bin, buildArgs(this.model), {
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        finish(false, `起動に失敗しました: ${(err as Error).message}`);
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, KILL_GRACE_MS);
      }, this.timeoutMs);
      const collect = (chunk: string) => {
        out = (out + chunk).slice(-OUTPUT_TAIL * 4);
      };
      child.stdout?.setEncoding('utf-8');
      child.stderr?.setEncoding('utf-8');
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.on('error', err => {
        // spawn の失敗（ENOENT 等）は 'error' で来る。close が続く場合もあるが finish は 1 回だけ
        finish(false, `起動に失敗しました: ${err.message}`);
      });
      child.on('close', code => {
        // ⚠ 成功は終了コードではなく事後検査で決める（文面の**個数が増えた**か）
        const added = countOf(this.readTodo(), job.needle) > before;
        if (added) {
          finish(true, null);
        } else if (timedOut) {
          finish(false, `時間切れ（${Math.round(this.timeoutMs / 1000)} 秒）で止めました`);
        } else if (code === 0) {
          finish(false, '実行は終わりましたが、TODO.md に文面が入りませんでした');
        } else {
          finish(false, `claude が異常終了しました（code ${code}）`);
        }
      });
      try {
        child.stdin?.write(job.prompt);
        child.stdin?.end();
      } catch {
        // 書けない（起動直後に死んだ等）→ close / error 側で拾う
      }
    });
  }
}

/** claude が使えるか（PATH に居て --version が返るか）。起動時に 1 回だけ引く想定。 */
export function probeClaude(bin = 'claude', timeoutMs = 5_000): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const settle = (v: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: ChildProcess;
    try {
      child = spawn(bin, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      settle(false);
    }, timeoutMs);
    child.on('error', () => settle(false));
    child.on('close', code => settle(code === 0));
  });
}
