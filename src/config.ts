import fs from 'fs';
import path from 'path';

export interface CategoryConfig {
  name: string;     // URL セグメント / ハッシュキー (例: 'plans')
  label: string;    // タブ表示名 (例: 'Plans')
  path: string;     // root からの相対 or 絶対パス。サーバ側で絶対化される
  archive: boolean; // true のとき、ファイル/ディレクトリの archive 操作を許可
}

export interface EditableFileConfig {
  name: string;  // URL トークン兼サイドバー識別子 (例: 'TODO.md')
  label: string; // サイドバー表示。省略時は basename without ext
  path: string;  // root からの相対 or 絶対パス。省略時は name
}

export interface EditableConfig {
  label: string;             // 「TODO」タブの表示名
  files: EditableFileConfig[];
}

export interface VibeboardConfig {
  root: string;
  port: number;
  host: string;
  title: string;
  categories: CategoryConfig[];
  editable: EditableConfig;
}

interface ParsedArgs {
  root?: string;
  port?: number;
  title?: string;
  config?: string;
  rest: string[];
}

const DEFAULT_CATEGORIES: CategoryConfig[] = [
  { name: 'plans', label: 'Plans', path: 'docs/plans', archive: true },
  { name: 'specs', label: 'Specs', path: 'docs/specs', archive: false },
];

const DEFAULT_EDITABLE: EditableConfig = {
  label: 'TODO',
  files: [
    { name: 'TODO.md', label: 'TODO', path: 'TODO.md' },
    { name: 'DONE.md', label: 'DONE', path: 'DONE.md' },
  ],
};

const RESERVED_CATEGORY_NAMES = new Set(['todo']);
const FORBIDDEN_PATH_CHARS = /[\/\\]/;

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

function normalizeCategories(raw: unknown, root: string): CategoryConfig[] {
  if (raw === undefined) {
    // デフォルトは相対パスで持っているので root に紐づけて絶対化する
    return DEFAULT_CATEGORIES.map(c => ({ ...c, path: path.resolve(root, c.path) }));
  }
  if (!Array.isArray(raw)) {
    throw new Error('categories は配列である必要があります');
  }
  if (raw.length === 0) {
    throw new Error('categories を空にはできません (省略すればデフォルトが使われます)');
  }
  const seen = new Set<string>();
  const out: CategoryConfig[] = [];
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
    const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim() : name;
    const rawPath = typeof e.path === 'string' && e.path.trim() ? e.path.trim() : `docs/${name}`;
    const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);
    ensureUnderRoot(absPath, root, `categories[${i}].path`);
    const archive = typeof e.archive === 'boolean' ? e.archive : false;
    out.push({ name, label, path: absPath, archive });
  }
  return out;
}

function normalizeEditable(raw: unknown, root: string): EditableConfig {
  if (raw === undefined) {
    // デフォルトは name と同じ相対パス。root に紐づけて絶対化する。
    return {
      label: DEFAULT_EDITABLE.label,
      files: DEFAULT_EDITABLE.files.map(f => ({ ...f, path: path.resolve(root, f.path) })),
    };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('editable はオブジェクトである必要があります');
  }
  const e = raw as Record<string, unknown>;
  const label = typeof e.label === 'string' && e.label.trim()
    ? e.label.trim()
    : DEFAULT_EDITABLE.label;
  const filesRaw = e.files;
  if (filesRaw === undefined) {
    return {
      label,
      files: DEFAULT_EDITABLE.files.map(f => ({ ...f, path: path.resolve(root, f.path) })),
    };
  }
  if (!Array.isArray(filesRaw)) {
    throw new Error('editable.files は配列である必要があります');
  }
  if (filesRaw.length === 0) {
    throw new Error('editable.files を空にはできません (省略すればデフォルトが使われます)');
  }
  const seen = new Set<string>();
  const files: EditableFileConfig[] = [];
  for (let i = 0; i < filesRaw.length; i++) {
    const entry = filesRaw[i];
    let name: string;
    let labelStr: string | undefined;
    let pathStr: string | undefined;
    if (typeof entry === 'string') {
      name = entry.trim();
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const ee = entry as Record<string, unknown>;
      name = typeof ee.name === 'string' ? ee.name.trim() : '';
      if (typeof ee.label === 'string' && ee.label.trim()) labelStr = ee.label.trim();
      if (typeof ee.path === 'string' && ee.path.trim()) pathStr = ee.path.trim();
    } else {
      throw new Error(`editable.files[${i}] は文字列かオブジェクトである必要があります`);
    }
    if (!name) throw new Error(`editable.files[${i}].name は必須です`);
    if (FORBIDDEN_PATH_CHARS.test(name) || name.startsWith('.')) {
      throw new Error(`editable.files[${i}].name に使えない文字が含まれます: ${name}`);
    }
    if (!name.toLowerCase().endsWith('.md')) {
      throw new Error(`editable.files[${i}].name は .md で終わる必要があります: ${name}`);
    }
    if (seen.has(name)) {
      throw new Error(`editable.files[${i}].name が重複しています: ${name}`);
    }
    seen.add(name);
    const finalLabel = labelStr ?? name.replace(/\.md$/i, '');
    const rawPath = pathStr ?? name;
    const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);
    ensureUnderRoot(absPath, root, `editable.files[${i}].path`);
    files.push({ name, label: finalLabel, path: absPath });
  }
  return { label, files };
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
  const editable = normalizeEditable(raw.editable, root);

  return {
    config: {
      root,
      port,
      host: '127.0.0.1',
      title,
      categories,
      editable,
    },
    rest: parsed.rest,
  };
}
