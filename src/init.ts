import fs from 'fs';
import path from 'path';

export interface InitOptions {
  root: string;
  dryRun: boolean;
  /** `.claude/settings.json` に SessionStart / SessionEnd の hook を書くか（既定 true。`--no-hooks` で false） */
  hooks?: boolean;
}

export interface InitResult {
  action: 'create' | 'replace' | 'append' | 'unchanged';
  claudeMdPath: string;
  nextContent: string;
  prevContent: string;
}

const BEGIN_MARKER = '<!-- vibeboard:begin -->';
const END_MARKER = '<!-- vibeboard:end -->';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveTemplatePath(): string {
  // dist/init.js から見ると ../src/templates/...、src/init.ts (ts-node) から見ると ../templates/...
  const candidates = [
    path.join(__dirname, '..', 'src', 'templates', 'claude-md-snippet.md'),
    path.join(__dirname, 'templates', 'claude-md-snippet.md'),
    path.join(__dirname, '..', 'templates', 'claude-md-snippet.md'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`claude-md-snippet.md が見つかりませんでした (探索: ${candidates.join(', ')})`);
}

function buildBlock(snippet: string): string {
  return `${BEGIN_MARKER}\n${snippet.trimEnd()}\n${END_MARKER}`;
}

export function planInit(opts: InitOptions): InitResult {
  const claudeMdPath = path.join(opts.root, 'CLAUDE.md');
  const templatePath = resolveTemplatePath();
  const snippet = fs.readFileSync(templatePath, 'utf-8');
  const block = buildBlock(snippet);

  let prevContent = '';
  let action: InitResult['action'];
  let nextContent: string;

  if (fs.existsSync(claudeMdPath)) {
    prevContent = fs.readFileSync(claudeMdPath, 'utf-8');
    const re = new RegExp(`${escapeRegExp(BEGIN_MARKER)}[\\s\\S]*?${escapeRegExp(END_MARKER)}`);
    if (re.test(prevContent)) {
      nextContent = prevContent.replace(re, block);
      action = nextContent === prevContent ? 'unchanged' : 'replace';
    } else {
      const sep = prevContent.length === 0
        ? ''
        : prevContent.endsWith('\n\n') ? '' : prevContent.endsWith('\n') ? '\n' : '\n\n';
      nextContent = prevContent + sep + block + '\n';
      action = 'append';
    }
  } else {
    nextContent = block + '\n';
    action = 'create';
  }

  return { action, claudeMdPath, nextContent, prevContent };
}

// === hooks（Tasks タブの送り先の登録）===
//
// Claude Code のセッションは起動時に SessionStart hook を走らせ、hook には自分の受信口ソケットが
// `CLAUDE_CODE_MESSAGING_SOCKET` として渡る。それを vibeboard へ知らせる hook を
// `.claude/settings.json` に書いておけば、待ち受け（`vibeboard listen`）を人が起動しなくても
// Tasks タブから届く。settings.json はコミットできるので、clone した先でも効く。

export const HOOK_SCRIPT_REL = 'scripts/session-hook.mjs';
const HOOK_SCRIPT_RE = /scripts[\\/]session-hook\.mjs/;

/** hook のコマンド。vibeboard が root の中にあれば root 相対（コミットしても他所で効く）、外なら絶対パス。 */
export function hookCommand(root: string, vibeboardDir: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(vibeboardDir));
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    const posix = rel.split(path.sep).join('/');
    return `node "\${CLAUDE_PROJECT_DIR:-.}/${posix}/${HOOK_SCRIPT_REL}"`;
  }
  return `node "${path.resolve(vibeboardDir)}/${HOOK_SCRIPT_REL}"`;
}

/** その hook 項目は vibeboard のものか（コマンドが session-hook.mjs を指す） */
export function isOurHook(h: unknown): boolean {
  if (!h || typeof h !== 'object') return false;
  const cmd = (h as Record<string, unknown>).command;
  return typeof cmd === 'string' && HOOK_SCRIPT_RE.test(cmd);
}

type HookGroup = { matcher?: unknown; hooks?: unknown } & Record<string, unknown>;

function ourGroup(event: 'SessionStart' | 'SessionEnd', command: string): HookGroup {
  // SessionStart は async（起動を待たせない。時間切れの強制も無い。script 側で 1 秒で諦める）。
  // SessionEnd は同期で 3 秒（終了時の予算は per-hook の timeout まで延びる）。
  // 事象名は stdin の JSON にも入るが、引数でも渡しておく（stdin が来ない環境の保険）
  const cmd = `${command} ${event}`;
  const hook = event === 'SessionStart'
    ? { type: 'command', command: cmd, async: true }
    : { type: 'command', command: cmd, timeout: 3 };
  return { hooks: [hook] };
}

/**
 * settings.json の中身に vibeboard の SessionStart / SessionEnd hook を併合する。
 * 他の hooks は残し、コマンドが session-hook.mjs を指す項目だけを自分のものとして置き換える（冪等）。
 */
export function mergeHooks(settings: unknown, command: string): { next: Record<string, unknown>; changed: boolean } {
  const base: Record<string, unknown> =
    settings && typeof settings === 'object' && !Array.isArray(settings) ? { ...(settings as Record<string, unknown>) } : {};
  const hooksRaw = base.hooks;
  const hooks: Record<string, unknown> =
    hooksRaw && typeof hooksRaw === 'object' && !Array.isArray(hooksRaw) ? { ...(hooksRaw as Record<string, unknown>) } : {};
  for (const event of ['SessionStart', 'SessionEnd'] as const) {
    const arr = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const kept: unknown[] = [];
    for (const g of arr) {
      if (!g || typeof g !== 'object') {
        kept.push(g);
        continue;
      }
      const group = g as HookGroup;
      const list = Array.isArray(group.hooks) ? (group.hooks as unknown[]) : [];
      const others = list.filter(h => !isOurHook(h));
      if (others.length === list.length) kept.push(group); // 自分のものが無い → そのまま
      else if (others.length > 0) kept.push({ ...group, hooks: others }); // 混在 → 自分のぶんだけ抜く
      // 全部自分のもの → 落とす（下で付け直す）
    }
    kept.push(ourGroup(event, command));
    hooks[event] = kept;
  }
  const next = { ...base, hooks };
  const changed = JSON.stringify(next) !== JSON.stringify(settings ?? null);
  return { next, changed };
}

export interface HooksPlan {
  settingsPath: string;
  prevContent: string | null;
  nextContent: string;
  changed: boolean;
  command: string;
}

/** `<root>/.claude/settings.json` に書く内容を組む。既存の JSON が壊れていれば止める（上書きしない）。 */
export function planHooks(root: string, vibeboardDir: string = path.resolve(__dirname, '..')): HooksPlan {
  const settingsPath = path.join(root, '.claude', 'settings.json');
  const command = hookCommand(root, vibeboardDir);
  let prevContent: string | null = null;
  let prev: unknown = {};
  if (fs.existsSync(settingsPath)) {
    prevContent = fs.readFileSync(settingsPath, 'utf-8');
    try {
      prev = prevContent.trim() ? JSON.parse(prevContent) : {};
    } catch (err) {
      throw new Error(`${settingsPath} が JSON として読めません（直してから流し直してください）: ${(err as Error).message}`);
    }
    if (!prev || typeof prev !== 'object' || Array.isArray(prev)) {
      throw new Error(`${settingsPath} はオブジェクトである必要があります`);
    }
  }
  const { next, changed } = mergeHooks(prev, command);
  const nextContent = JSON.stringify(next, null, 2) + '\n';
  return { settingsPath, prevContent, nextContent, changed: prevContent === null || changed, command };
}

export function runInit(opts: InitOptions): void {
  const result = planInit(opts);
  const label = actionLabel(result.action);

  if (opts.dryRun) {
    console.log(`[vibeboard init] dry-run: ${result.claudeMdPath} を ${label}します`);
    if (result.action === 'unchanged') {
      console.log('（変更はありません）');
    } else {
      console.log('--- 書き込み後の内容 ---');
      console.log(result.nextContent);
      console.log('--- ここまで ---');
    }
  } else if (result.action === 'unchanged') {
    console.log(`[vibeboard init] ${result.claudeMdPath} は既に最新です（変更なし）`);
  } else {
    fs.writeFileSync(result.claudeMdPath, result.nextContent, 'utf-8');
    console.log(`[vibeboard init] ${result.claudeMdPath} を${label}しました`);
  }

  if (opts.hooks === false) {
    console.log('[vibeboard init] --no-hooks: .claude/settings.json には触れません（Tasks タブの送り先は vibeboard listen で待ち受けてください）');
    return;
  }
  const plan = planHooks(opts.root);
  if (opts.dryRun) {
    console.log(`[vibeboard init] dry-run: ${plan.settingsPath} に hooks を${plan.prevContent === null ? '新規作成' : plan.changed ? '併合' : '変更なしで保持'}します`);
    if (plan.changed) {
      console.log('--- 書き込み後の内容 ---');
      console.log(plan.nextContent);
      console.log('--- ここまで ---');
    } else {
      console.log('（変更はありません）');
    }
    return;
  }
  if (!plan.changed) {
    console.log(`[vibeboard init] ${plan.settingsPath} の hooks は既に最新です（変更なし）`);
    return;
  }
  fs.mkdirSync(path.dirname(plan.settingsPath), { recursive: true });
  fs.writeFileSync(plan.settingsPath, plan.nextContent, 'utf-8');
  console.log(`[vibeboard init] ${plan.settingsPath} に SessionStart / SessionEnd の hook を書きました（${plan.command}）`);
  console.log('[vibeboard init] 既に開いている Claude Code のセッションには効きません。起動し直すと Tasks タブの送り先に「登録済み」で出ます');
}

function actionLabel(a: InitResult['action']): string {
  switch (a) {
    case 'create': return '新規作成';
    case 'replace': return 'マーカー間を置換';
    case 'append': return '末尾に追記';
    case 'unchanged': return '変更なしで保持';
  }
}
