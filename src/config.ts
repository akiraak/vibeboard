import fs from 'fs';
import path from 'path';
import { DEFAULT_EXCLUDES } from './source';

export interface CategoryConfig {
  name: string;     // URL セグメント / ハッシュキー (例: 'plans')
  label: string;    // タブ表示名 (例: 'Plans')
  path: string;     // root からの相対 or 絶対パス。サーバ側で絶対化される
  archive: boolean; // true のとき、ファイル/ディレクトリの archive 操作を許可
}

// Files タブ（プロジェクト内の全ファイルを開く）
export interface FilesConfig {
  label: string;
  // ツリーからも読み書きからも外す名前。パスのどのセグメントに現れても対象。
  // 既定（.git / node_modules）は常に含む。設定の exclude はそこに足すだけ
  exclude: string[];
}

export interface CustomTabConfig {
  name: string;    // URL セグメント / ハッシュキー (例: 'sample')
  label: string;   // タブ表示名 (例: 'Sample')
  baseUrl: string; // プラグインの HTTP ベース URL (末尾スラッシュなしに正規化)
  // タブの中身を出すプロセスの起動コマンド (省略時は自分で起動する)。
  // **配列でだけ受ける**。1 本の文字列にすると shell を通すことになり、
  // 設定ファイルの中身がそのままシェルの文になる。
  command: string[] | null;
}

// Tasks タブの「タスク追加」（バックグラウンドの claude -p）の調整。省略可
export interface TaskAddConfig {
  /** --model に渡す値（null なら CLI の既定モデル） */
  model: string | null;
  /** 1 ジョブの制限時間（秒） */
  timeoutSec: number;
}

export interface VibeboardConfig {
  root: string;
  port: number;
  host: string;
  title: string;
  categories: CategoryConfig[];
  files: FilesConfig;
  customTabs: CustomTabConfig[];
  taskAdd: TaskAddConfig;
}

interface ParsedArgs {
  root?: string;
  port?: number;
  title?: string;
  config?: string;
  rest: string[];
}

// 既定のカテゴリ。設定ファイルの categories に書いても消えない（消すのは `hidden: true` だけ）
const DEFAULT_CATEGORIES: CategoryConfig[] = [
  { name: 'plans', label: 'Plans', path: 'docs/plans', archive: true },
  { name: 'specs', label: 'Specs', path: 'docs/specs', archive: false },
];

/** plans のタブが無い（hidden）ときのプランの置き場所 */
export const DEFAULT_PLANS_DIR = 'docs/plans';

/**
 * 「プラン作成」の文面・画面の説明・CLAUDE.md の定型文に入れるプランの置き場所
 * （root 相対・`/` 区切り）。設定した plans の path に従い、plans を hidden にしていれば既定に戻す
 * （タブを隠していてもプランを作る場面はある）。
 */
export function plansDirOf(config: Pick<VibeboardConfig, 'root' | 'categories'>): string {
  const plans = config.categories.find(c => c.name === 'plans');
  if (!plans) return DEFAULT_PLANS_DIR;
  return path.relative(config.root, plans.path).split(path.sep).join('/') || '.';
}

// UI 側で固定のスラッグを持つタブ。カテゴリ名にも customTab 名にも使えない
const RESERVED_CATEGORY_NAMES = new Set(['todo', 'files', 'tasks']);
const FORBIDDEN_PATH_CHARS = /[\/\\]/;
const CUSTOM_TAB_NAME_RE = /^[a-z0-9][a-z0-9-]*$/i;

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' || a === '--port' || a === '--title' || a === '--config') {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} の値が指定されていません`);
      if (a === '--root') out.root = v;
      else if (a === '--config') out.config = v;
      else if (a === '--port') {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`--port の値が不正です: ${v}`);
        out.port = n;
      } else out.title = v;
      i++;
      continue;
    }
    const m = a.match(/^--(root|port|title|config)=(.*)$/);
    if (m) {
      if (m[1] === 'port') {
        const n = Number(m[2]);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`--port の値が不正です: ${m[2]}`);
        out.port = n;
      } else if (m[1] === 'root') out.root = m[2];
      else if (m[1] === 'config') out.config = m[2];
      else out.title = m[2];
      continue;
    }
    out.rest.push(a);
  }
  return out;
}

function deriveTitleFromRoot(root: string): string {
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: unknown };
      if (typeof pkg.name === 'string' && pkg.name.trim()) return pkg.name.trim();
    } catch {
      // 無視してフォールバック
    }
  }
  const base = path.basename(path.resolve(root));
  return base || 'vibeboard';
}

interface RawConfigFile {
  title?: unknown;
  port?: unknown;
  categories?: unknown;
  editable?: unknown;
  files?: unknown;
  customTabs?: unknown;
  taskAdd?: unknown;
}

function readConfigFile(root: string, explicitPath: string | undefined): {
  raw: RawConfigFile;
  source: string | null;
} {
  const target = explicitPath
    ? path.resolve(explicitPath)
    : path.join(root, 'vibeboard.config.json');
  if (!fs.existsSync(target)) {
    if (explicitPath) {
      throw new Error(`--config に指定されたファイルが存在しません: ${target}`);
    }
    return { raw: {}, source: null };
  }
  let text: string;
  try {
    text = fs.readFileSync(target, 'utf-8');
  } catch {
    throw new Error(`設定ファイルの読み込みに失敗しました: ${target}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`設定ファイルの JSON が不正です: ${target}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`設定ファイルはオブジェクトである必要があります: ${target}`);
  }
  return { raw: parsed as RawConfigFile, source: target };
}

function ensureUnderRoot(absPath: string, root: string, label: string): void {
  // 親が未作成のこともあるので、realpath ではなく単純な prefix チェックで十分
  const normalized = path.resolve(absPath);
  const normalizedRoot = path.resolve(root);
  if (normalized !== normalizedRoot && !normalized.startsWith(normalizedRoot + path.sep)) {
    throw new Error(`${label} のパスが root の外を指しています: ${normalized}`);
  }
}

// 設定ファイルの categories の 1 要素。書かれなかったフィールドは undefined のまま持ち、
// 既定のカテゴリを上書きするときに「書いたものだけ差し替える」のに使う
interface CategoryEntry {
  index: number;
  name: string;
  hidden: boolean;
  label?: string;
  path?: string;
  archive?: boolean;
}

// categories は既定（plans / specs）への**差分**として読む:
// - 既定と同じ name → 書いたフィールドだけ上書き / 既定に無い name → タブを足す
// - `hidden: true` → そのタブを出さない（既定を消す唯一の方法）
// - 並びは書いた順。書かれていない既定は、既定の順で 1 つ前の既定の直後（無ければ先頭）に入る
function normalizeCategories(raw: unknown, root: string): CategoryConfig[] {
  const list = raw === undefined ? [] : raw;
  if (!Array.isArray(list)) {
    throw new Error('categories は配列である必要があります');
  }
  const entries = readCategoryEntries(list);
  const byName = new Map(entries.map(e => [e.name, e]));

  const order = entries.map(e => e.name);
  let prev: string | null = null;
  for (const def of DEFAULT_CATEGORIES) {
    if (!byName.has(def.name)) {
      order.splice(prev === null ? 0 : order.indexOf(prev) + 1, 0, def.name);
    }
    prev = def.name;
  }

  const out: CategoryConfig[] = [];
  for (const name of order) {
    const e = byName.get(name);
    if (e?.hidden) continue;
    const def = DEFAULT_CATEGORIES.find(d => d.name === name);
    const rawPath = e?.path ?? def?.path ?? `docs/${name}`;
    const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);
    ensureUnderRoot(absPath, root, e ? `categories[${e.index}].path` : `既定のカテゴリ ${name} の path`);
    out.push({
      name,
      label: e?.label ?? def?.label ?? name,
      path: absPath,
      archive: e?.archive ?? def?.archive ?? false,
    });
  }
  return out;
}

function readCategoryEntries(raw: unknown[]): CategoryEntry[] {
  const seen = new Set<string>();
  const out: CategoryEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`categories[${i}] はオブジェクトである必要があります`);
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (!name) throw new Error(`categories[${i}].name は必須です`);
    if (FORBIDDEN_PATH_CHARS.test(name) || name.startsWith('.')) {
      throw new Error(`categories[${i}].name に使えない文字が含まれます: ${name}`);
    }
    if (RESERVED_CATEGORY_NAMES.has(name)) {
      throw new Error(`categories[${i}].name は予約語です: ${name}`);
    }
    if (seen.has(name)) {
      throw new Error(`categories[${i}].name が重複しています: ${name}`);
    }
    seen.add(name);
    if (e.hidden !== undefined && typeof e.hidden !== 'boolean') {
      throw new Error(`categories[${i}].hidden は true / false で指定してください: ${String(e.hidden)}`);
    }
    out.push({
      index: i,
      name,
      hidden: e.hidden === true,
      label: typeof e.label === 'string' && e.label.trim() ? e.label.trim() : undefined,
      path: typeof e.path === 'string' && e.path.trim() ? e.path.trim() : undefined,
      archive: typeof e.archive === 'boolean' ? e.archive : undefined,
    });
  }
  return out;
}
function normalizeFiles(raw: unknown): FilesConfig {
  if (raw === undefined) {
    return { label: 'Files', exclude: [...DEFAULT_EXCLUDES] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('files はオブジェクトである必要があります');
  }
  const e = raw as Record<string, unknown>;
  const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim() : 'Files';

  if (e.exclude === undefined) {
    return { label, exclude: [...DEFAULT_EXCLUDES] };
  }
  if (!Array.isArray(e.exclude)) {
    throw new Error('files.exclude は配列である必要があります');
  }
  // 既定は書いても書かなくても外さない。除外は読み書きの防壁でもあるので、
  // 書き写し忘れで .git が画面から編集できるようになるのを防ぐ（外す手段はあえて作らない）
  const exclude: string[] = [...DEFAULT_EXCLUDES];
  for (let i = 0; i < e.exclude.length; i++) {
    const v = e.exclude[i];
    if (typeof v !== 'string' || !v.trim()) {
      throw new Error(`files.exclude[${i}] は空でない文字列である必要があります`);
    }
    const name = v.trim();
    // 除外はパスの 1 セグメント名で指定する（グロブやパスは受けない）
    if (FORBIDDEN_PATH_CHARS.test(name) || name === '.' || name === '..') {
      throw new Error(`files.exclude[${i}] にはパス区切りを含められません: ${name}`);
    }
    if (!exclude.includes(name)) exclude.push(name);
  }
  return { label, exclude };
}

// 起動コマンド。shell を通さないため配列だけを受ける (文字列は明示的に弾く)。
function normalizeCommand(raw: unknown, label: string): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') {
    throw new Error(`${label} は配列で指定してください (例: ["node", "server.js"])`);
  }
  if (!Array.isArray(raw)) {
    throw new Error(`${label} は配列である必要があります`);
  }
  if (raw.length === 0) {
    throw new Error(`${label} を空配列にはできません`);
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (typeof v !== 'string' || !v.trim()) {
      throw new Error(`${label}[${i}] は空でない文字列である必要があります`);
    }
    out.push(v);
  }
  return out;
}

function normalizeBaseUrl(raw: string, label: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} は URL として解釈できません: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} は http または https のみ許可されます: ${raw}`);
  }
  if (url.search || url.hash) {
    throw new Error(`${label} に ? や # は含められません: ${raw}`);
  }
  // 末尾スラッシュを取り除いて正規化（pathname が '/' のみの場合は空文字に）
  let pathname = url.pathname;
  if (pathname.endsWith('/')) pathname = pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${pathname}`;
}

function normalizeCustomTabs(
  raw: unknown,
  reservedNames: Set<string>,
): CustomTabConfig[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error('customTabs は配列である必要があります');
  }
  const seen = new Set<string>();
  const out: CustomTabConfig[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`customTabs[${i}] はオブジェクトである必要があります`);
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (!name) throw new Error(`customTabs[${i}].name は必須です`);
    if (!CUSTOM_TAB_NAME_RE.test(name)) {
      throw new Error(`customTabs[${i}].name に使えない文字が含まれます: ${name}`);
    }
    if (reservedNames.has(name)) {
      throw new Error(`customTabs[${i}].name は他のタブと衝突しています: ${name}`);
    }
    if (seen.has(name)) {
      throw new Error(`customTabs[${i}].name が重複しています: ${name}`);
    }
    seen.add(name);
    const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim() : name;
    const rawBaseUrl = typeof e.baseUrl === 'string' ? e.baseUrl.trim() : '';
    if (!rawBaseUrl) throw new Error(`customTabs[${i}].baseUrl は必須です`);
    const baseUrl = normalizeBaseUrl(rawBaseUrl, `customTabs[${i}].baseUrl`);
    const command = normalizeCommand(e.command, `customTabs[${i}].command`);
    out.push({ name, label, baseUrl, command });
  }
  return out;
}

const DEFAULT_TASK_ADD: TaskAddConfig = { model: null, timeoutSec: 120 };

function normalizeTaskAdd(raw: unknown): TaskAddConfig {
  if (raw === undefined) return { ...DEFAULT_TASK_ADD };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('taskAdd はオブジェクトである必要があります');
  }
  const e = raw as Record<string, unknown>;
  const model = typeof e.model === 'string' && e.model.trim() ? e.model.trim() : null;
  let timeoutSec = DEFAULT_TASK_ADD.timeoutSec;
  if (e.timeoutSec !== undefined) {
    if (typeof e.timeoutSec !== 'number' || !Number.isFinite(e.timeoutSec) || e.timeoutSec <= 0) {
      throw new Error(`taskAdd.timeoutSec は正の数である必要があります: ${String(e.timeoutSec)}`);
    }
    timeoutSec = e.timeoutSec;
  }
  return { model, timeoutSec };
}

export function resolveConfig(argv: string[]): { config: VibeboardConfig; rest: string[] } {
  const parsed = parseArgs(argv);

  const root = path.resolve(
    parsed.root
      ?? process.env.VIBEBOARD_ROOT
      ?? process.cwd()
  );
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`--root に指定されたパスがディレクトリとして存在しません: ${root}`);
  }

  const { raw } = readConfigFile(root, parsed.config);

  // 優先順位: CLI > 環境変数 > 設定ファイル > デフォルト
  const portEnv = process.env.VIBEBOARD_PORT ?? process.env.DEV_ADMIN_PORT;
  const portFromFile = typeof raw.port === 'number' && Number.isFinite(raw.port) && raw.port > 0
    ? raw.port
    : undefined;
  const port = parsed.port
    ?? (portEnv ? Number(portEnv) : undefined)
    ?? portFromFile
    ?? 3010;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`port の値が不正です: ${port}`);
  }

  const titleFromFile = typeof raw.title === 'string' && raw.title.trim()
    ? raw.title.trim()
    : undefined;
  const title = (parsed.title ?? process.env.VIBEBOARD_TITLE ?? '').trim()
    || titleFromFile
    || deriveTitleFromRoot(root);

  const categories = normalizeCategories(raw.categories, root);
  // editable（旧 Root タブの設定）は廃止した。残っていても起動は止めず、一言だけ知らせて無視する
  if (raw.editable !== undefined) {
    console.log('[vibeboard] 設定の editable は Root タブの廃止に伴い無視されます（ルート直下のファイルは Files タブで開けます）');
  }
  const files = normalizeFiles(raw.files);
  // categories の name と固定スラッグを予約名としてまとめて customTabs に渡す
  const reservedForCustomTabs = new Set<string>([
    ...RESERVED_CATEGORY_NAMES,
    ...categories.map(c => c.name),
  ]);
  const customTabs = normalizeCustomTabs(raw.customTabs, reservedForCustomTabs);
  const taskAdd = normalizeTaskAdd(raw.taskAdd);

  return {
    config: {
      root,
      port,
      host: '127.0.0.1',
      title,
      categories,
      files,
      customTabs,
      taskAdd,
    },
    rest: parsed.rest,
  };
}
