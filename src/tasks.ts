// Tasks タブの裏側: セッションの発見・登録・投函・キュー。
//
// - 発見: `claude agents --json --cwd <root>`（対話セッションも background も返る）
// - 登録: SessionStart hook（scripts/session-hook.mjs）が自分の受信口（Unix ソケット）を知らせてくる
// - 投函: そのソケットへ auth 行 ＋ user 行を 1 行ずつ書く（Claude Code の受信口の書式）
// - キュー: tmp の JSON。待ち / 投函済み / 失敗。送り先が居なくても受け付け、登録が来た時点で投函する
//
// 純関数（parseAgentsJson / queue の遷移）と I/O（listClaudeSessions / postToInbox / TaskQueue の読み書き）を
// 分けてある。テストは純関数と、テスト内で立てたソケットに対する投函だけを見る。
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

// === セッションの発見 ===

export interface ClaudeSession {
  sessionId: string;
  /** 表示名。`claude agents` が付けた名前（無ければ sessionId の先頭 8 文字） */
  name: string;
  kind: 'interactive' | 'background';
  /** interactive: busy / idle。background: working / blocked / idle。取れなければ unknown */
  status: string;
  cwd: string;
  pid: number | null;
  /** background セッションの短い id（`claude attach <id>` に渡すもの） */
  shortId: string | null;
  /** background が止まっている理由（"permission prompt" など） */
  waitingFor: string | null;
  startedAt: number | null;
}

/** p が root そのもの、または root の配下か。 */
export function isUnder(root: string, p: string): boolean {
  const r = path.resolve(root);
  const q = path.resolve(p);
  return q === r || q.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

// 終わっている background セッションは送り先にならないので落とす
const ENDED_STATES = new Set(['done', 'failed', 'stopped']);

/** `claude agents --json` の出力を、root 配下のセッションの一覧に整える。読めなければ空。 */
export function parseAgentsJson(raw: string, root: string): ClaudeSession[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ClaudeSession[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const sessionId = typeof r.sessionId === 'string' ? r.sessionId.trim() : '';
    if (!sessionId) continue;
    const cwd = typeof r.cwd === 'string' ? r.cwd : '';
    if (!cwd || !isUnder(root, cwd)) continue;
    const kind: ClaudeSession['kind'] = r.kind === 'background' ? 'background' : 'interactive';
    const rawStatus = kind === 'background' ? r.state : r.status;
    const status = typeof rawStatus === 'string' && rawStatus ? rawStatus : 'unknown';
    if (kind === 'background' && ENDED_STATES.has(status)) continue;
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : sessionId.slice(0, 8);
    out.push({
      sessionId,
      name,
      kind,
      status,
      cwd,
      pid: typeof r.pid === 'number' && Number.isFinite(r.pid) ? r.pid : null,
      shortId: typeof r.id === 'string' && r.id ? r.id : null,
      waitingFor: typeof r.waitingFor === 'string' && r.waitingFor ? r.waitingFor : null,
      startedAt: typeof r.startedAt === 'number' && Number.isFinite(r.startedAt) ? r.startedAt : null,
    });
  }
  return out;
}

export interface ListSessionsResult {
  /** `claude agents` を実行して読めたか。false のときは claude が無い / 失敗（一覧は空） */
  ok: boolean;
  sessions: ClaudeSession[];
  error: string | null;
}

/** `claude agents --json --cwd <root>` を実行する。PATH に無い・落ちた・遅い、はすべて ok: false。 */
export function listClaudeSessions(
  root: string,
  opts: { command?: string; timeoutMs?: number } = {},
): Promise<ListSessionsResult> {
  const command = opts.command ?? 'claude';
  const timeout = opts.timeoutMs ?? 8000;
  return new Promise(resolve => {
    execFile(
      command,
      ['agents', '--json', '--cwd', root],
      { timeout, maxBuffer: 4 * 1024 * 1024, env: process.env },
      (err, stdout) => {
        if (err) {
          const e = err as NodeJS.ErrnoException;
          resolve({ ok: false, sessions: [], error: e.code === 'ENOENT' ? `${command} が PATH にありません` : e.message });
          return;
        }
        resolve({ ok: true, sessions: parseAgentsJson(String(stdout), root), error: null });
      },
    );
  });
}

// === 登録（hook → vibeboard）===

export interface Registration {
  sessionId: string;
  cwd: string;
  socket: string;
  /** メモリにだけ持つ。ディスクにもブラウザにも出さない */
  token: string | null;
  pid: number | null;
  at: number;
}

export class Registry {
  private readonly map = new Map<string, Registration>();

  register(r: Registration): void {
    this.map.set(r.sessionId, r);
  }
  unregister(sessionId: string): boolean {
    return this.map.delete(sessionId);
  }
  get(sessionId: string): Registration | undefined {
    return this.map.get(sessionId);
  }
  has(sessionId: string): boolean {
    return this.map.has(sessionId);
  }
  list(): Registration[] {
    return [...this.map.values()];
  }
}

// === 投函 ===

export interface PostOptions {
  token?: string | null;
  /** 接続から peer が閉じるまでの上限。書き終えていれば時間切れでも成功とみなす */
  timeoutMs?: number;
}

/** 受信口ソケットへ auth 行（token があるとき）と user 行を書く。書けたら resolve、繋げなければ reject。 */
export function postToInbox(socketPath: string, text: string, opts: PostOptions = {}): Promise<{ reply: string }> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const lines: string[] = [];
  if (opts.token) lines.push(JSON.stringify({ type: 'auth', token: opts.token }));
  lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }));
  const payload = lines.join('\n') + '\n';

  return new Promise((resolve, reject) => {
    let settled = false;
    let written = false;
    let reply = '';
    const sock = net.createConnection(socketPath);
    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve({ reply });
    };
    const timer = setTimeout(() => {
      if (written) finish(null);
      else finish(Object.assign(new Error('受信口への書き込みが時間切れになりました'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    sock.on('connect', () => {
      sock.write(payload, err => {
        if (err) {
          finish(err);
          return;
        }
        written = true;
        sock.end(); // こちらは送り終えた。peer が読み切って閉じるのを待つ
      });
    });
    sock.on('data', (d: Buffer) => {
      reply += d.toString('utf8');
    });
    sock.on('error', err => {
      if (written) finish(null); // 書き終えたあとの切断は届いたものとして扱う
      else finish(err);
    });
    sock.on('close', () => finish(written ? null : Object.assign(new Error('受信口が先に閉じました'), { code: 'ECONNRESET' })));
  });
}

// === キュー ===

export type QueueState = 'waiting' | 'posted' | 'failed';
export type TaskKind = 'run' | 'explain';

export interface QueueItem {
  id: string;
  /** TODO.md 側のタスク id */
  taskId: string;
  text: string;
  kind: TaskKind;
  prompt: string;
  sessionId: string;
  state: QueueState;
  at: number;
  updatedAt: number;
  error: string | null;
}

export interface QueueInput {
  taskId: string;
  text: string;
  kind: TaskKind;
  prompt: string;
  sessionId: string;
}

export interface ExpireOptions {
  /** 「待ち」のまま送り先が登録されないとき、失敗にするまでの時間 */
  waitMs?: number;
  /** 「投函済み」を一覧に残す時間 */
  keepPostedMs?: number;
  /** 「失敗」を一覧に残す時間（再送はこの間だけできる） */
  keepFailedMs?: number;
}

export const QUEUE_WAIT_MS = 5 * 60 * 1000;
export const QUEUE_KEEP_POSTED_MS = 10 * 60 * 1000;
export const QUEUE_KEEP_FAILED_MS = 60 * 60 * 1000;
export const WAIT_EXPIRED_ERROR = '送り先が登録されないまま 5 分経ちました';

export function enqueue(items: QueueItem[], input: QueueInput, now: number): { items: QueueItem[]; item: QueueItem } {
  const item: QueueItem = {
    id: crypto.randomBytes(6).toString('hex'),
    taskId: input.taskId,
    text: input.text,
    kind: input.kind,
    prompt: input.prompt,
    sessionId: input.sessionId,
    state: 'waiting',
    at: now,
    updatedAt: now,
    error: null,
  };
  return { items: [...items, item], item };
}

export function transition(
  items: QueueItem[],
  id: string,
  state: QueueState,
  now: number,
  error: string | null = null,
): QueueItem[] {
  return items.map(i => (i.id === id ? { ...i, state, updatedAt: now, error: state === 'failed' ? error : null } : i));
}

/** 失敗を「待ち」に戻す。失敗以外はそのまま。 */
export function retry(items: QueueItem[], id: string, now: number): QueueItem[] {
  return items.map(i => (i.id === id && i.state === 'failed' ? { ...i, state: 'waiting', updatedAt: now, error: null } : i));
}

export function dismiss(items: QueueItem[], id: string): QueueItem[] {
  return items.filter(i => i.id !== id);
}

/** 時間で動く遷移: 待ちすぎ → 失敗、古い投函済み / 失敗 → 一覧から外す。 */
export function expire(items: QueueItem[], now: number, opts: ExpireOptions = {}): QueueItem[] {
  const waitMs = opts.waitMs ?? QUEUE_WAIT_MS;
  const keepPostedMs = opts.keepPostedMs ?? QUEUE_KEEP_POSTED_MS;
  const keepFailedMs = opts.keepFailedMs ?? QUEUE_KEEP_FAILED_MS;
  const out: QueueItem[] = [];
  for (const i of items) {
    if (i.state === 'waiting') {
      out.push(now - i.updatedAt >= waitMs ? { ...i, state: 'failed', updatedAt: now, error: WAIT_EXPIRED_ERROR } : i);
    } else if (i.state === 'posted') {
      if (now - i.updatedAt < keepPostedMs) out.push(i);
    } else if (now - i.updatedAt < keepFailedMs) {
      out.push(i);
    }
  }
  return out;
}

/** root ごとのキューの置き場所（tmp。vibeboard を再起動しても残る） */
export function queueFilePath(root: string, tmpDir: string = os.tmpdir()): string {
  const hash = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 8);
  return path.join(tmpDir, `vibeboard-tasks-${hash}.json`);
}

interface QueueFile {
  version: 1;
  root: string;
  items: QueueItem[];
}

const isQueueItem = (v: unknown): v is QueueItem => {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.taskId === 'string' &&
    typeof o.prompt === 'string' &&
    typeof o.sessionId === 'string' &&
    (o.state === 'waiting' || o.state === 'posted' || o.state === 'failed') &&
    typeof o.at === 'number' &&
    typeof o.updatedAt === 'number'
  );
};

/** ディスクに持つキュー。毎回読み、変更は tmp → rename で書く。時計は差し替えられる（テスト用）。 */
export class TaskQueue {
  readonly file: string;
  private readonly now: () => number;
  private readonly expireOpts: ExpireOptions;

  constructor(root: string, opts: { file?: string; now?: () => number; expire?: ExpireOptions } = {}) {
    this.file = opts.file ?? queueFilePath(root);
    this.now = opts.now ?? (() => Date.now());
    this.expireOpts = opts.expire ?? {};
    this.root = path.resolve(root);
  }
  private readonly root: string;

  private read(): QueueItem[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf-8');
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as Partial<QueueFile>;
      if (!parsed || !Array.isArray(parsed.items)) return [];
      return parsed.items.filter(isQueueItem).map(i => ({
        ...i,
        text: typeof i.text === 'string' ? i.text : '',
        kind: i.kind === 'explain' ? 'explain' : 'run',
        error: typeof i.error === 'string' ? i.error : null,
      }));
    } catch {
      return [];
    }
  }

  private write(items: QueueItem[]): void {
    const body: QueueFile = { version: 1, root: this.root, items };
    const tmp = `${this.file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** 期限切れを反映した一覧。反映で変わったら書き戻す。 */
  list(): QueueItem[] {
    const before = this.read();
    const after = expire(before, this.now(), this.expireOpts);
    if (JSON.stringify(after) !== JSON.stringify(before)) this.write(after);
    return after;
  }

  get(id: string): QueueItem | undefined {
    return this.list().find(i => i.id === id);
  }

  add(input: QueueInput): QueueItem {
    const { items, item } = enqueue(this.list(), input, this.now());
    this.write(items);
    return item;
  }

  update(id: string, state: QueueState, error: string | null = null): QueueItem | undefined {
    const items = transition(this.list(), id, state, this.now(), error);
    this.write(items);
    return items.find(i => i.id === id);
  }

  retry(id: string): QueueItem | undefined {
    const items = retry(this.list(), id, this.now());
    this.write(items);
    return items.find(i => i.id === id);
  }

  dismiss(id: string): boolean {
    const before = this.list();
    const after = dismiss(before, id);
    if (after.length === before.length) return false;
    this.write(after);
    return true;
  }
}
