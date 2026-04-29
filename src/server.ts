import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { marked } from 'marked';

const app = express();
app.use(express.json({ limit: '1mb' }));
const PORT = Number(process.env.DEV_ADMIN_PORT) || 3010;
const HOST = '127.0.0.1';

const ROOT_DIR = path.join(__dirname, '../..');
const DOCS_DIR = path.join(ROOT_DIR, 'docs');
const MD_CATEGORIES = ['plans', 'specs'] as const;
type MdCategory = typeof MD_CATEGORIES[number];

// ルート直下の編集可能ファイル（パストラバーサル防止の固定マップ）
const EDITABLE_FILES: Record<string, string> = {
  'TODO.md': path.join(ROOT_DIR, 'TODO.md'),
  'DONE.md': path.join(ROOT_DIR, 'DONE.md'),
};

interface TreeFile {
  name: string;
  path: string;
  title: string;
  mtime: number;
}

interface TreeDir {
  name: string;
  files: TreeFile[];
  dirs: TreeDir[];
  mtime: number;
}

interface Tree {
  files: TreeFile[];
  dirs: TreeDir[];
}

function extractMdTitle(raw: string, fallback: string): string {
  const fm = raw.match(/^---[\s\S]*?title:\s*(.+?)\s*\n[\s\S]*?---/);
  if (fm) return fm[1].trim();
  const stripped = raw.replace(/^---[\s\S]*?---\n*/, '');
  const h1 = stripped.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return fallback;
}

function extractHtmlTitle(raw: string, fallback: string): string {
  const t = raw.match(/<title>([^<]+)<\/title>/i);
  if (t) return t[1].trim();
  const h1 = raw.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1) return h1[1].trim();
  return fallback;
}

function extractTitle(absPath: string, fallback: string): string {
  const raw = fs.readFileSync(absPath, 'utf-8');
  if (absPath.endsWith('.md')) return extractMdTitle(raw, fallback);
  if (absPath.endsWith('.html')) return extractHtmlTitle(raw, fallback);
  return fallback;
}

// カテゴリ配下を再帰的にツリー化する（mtime 降順で並べる）
function listTree(absDir: string, exts: string[], relPrefix: string = ''): Tree {
  if (!fs.existsSync(absDir)) return { files: [], dirs: [] };
  const entries = fs.readdirSync(absDir, { withFileTypes: true });

  const files: TreeFile[] = [];
  const dirs: TreeDir[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(absDir, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const sub = listTree(abs, exts, rel);
      if (sub.files.length > 0 || sub.dirs.length > 0) {
        // ディレクトリ自身と配下の最新 mtime を採用（中身の更新が dir mtime に反映されない Linux 仕様の回避）
        const selfMtime = fs.statSync(abs).mtimeMs;
        const childMtimes = [
          ...sub.files.map(f => f.mtime),
          ...sub.dirs.map(d => d.mtime),
        ];
        const mtime = Math.max(selfMtime, ...childMtimes);
        dirs.push({ name: entry.name, files: sub.files, dirs: sub.dirs, mtime });
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (!exts.includes(ext)) continue;
      const fallback = entry.name.replace(/\.[^.]+$/, '');
      const mtime = fs.statSync(abs).mtimeMs;
      files.push({ name: entry.name, path: rel, title: extractTitle(abs, fallback), mtime });
    }
  }

  files.sort((a, b) => b.mtime - a.mtime);
  dirs.sort((a, b) => b.mtime - a.mtime);

  return { files, dirs };
}

function isSafeName(file: string, ext: string): boolean {
  return !file.includes('..') && !file.includes('/') && !file.includes('\\') && file.endsWith(ext);
}

// カテゴリルートからファイルを再帰的に探す（サブディレクトリ対応）
function findFileUnder(root: string, file: string): string | null {
  if (!fs.existsSync(root)) return null;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile() && entry.name === file) {
        return abs;
      }
    }
  }
  return null;
}

function findMdFile(category: MdCategory, file: string): string | null {
  return findFileUnder(path.join(DOCS_DIR, category), file);
}

// ドキュメント一覧（ツリー構造）
app.get('/api/docs', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      plans: listTree(path.join(DOCS_DIR, 'plans'), ['.md', '.html']),
      specs: listTree(path.join(DOCS_DIR, 'specs'), ['.md', '.html']),
    },
    error: null,
  });
});

// markdown ドキュメント取得（HTML 変換）
app.get('/api/docs/:category/:file', (req: Request, res: Response) => {
  const category = req.params.category as string;
  const file = req.params.file as string;

  if (!MD_CATEGORIES.includes(category as MdCategory)) {
    res.status(400).json({ success: false, data: null, error: '不正なカテゴリです' });
    return;
  }
  if (!isSafeName(file, '.md')) {
    res.status(400).json({ success: false, data: null, error: '不正なファイル名です' });
    return;
  }

  const filePath = findMdFile(category as MdCategory, file);
  if (!filePath) {
    res.status(404).json({ success: false, data: null, error: 'ファイルが見つかりません' });
    return;
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const title = extractMdTitle(raw, file.replace(/\.md$/, ''));
  const md = raw.replace(/^---[\s\S]*?---\n*/, '');
  const html = marked(md) as string;
  res.json({ success: true, data: { title, html }, error: null });
});

// design HTML をそのまま返す（iframe 用・カテゴリ指定）
app.get('/api/design/:category/:file', (req: Request, res: Response) => {
  const category = req.params.category as string;
  const file = req.params.file as string;

  if (!MD_CATEGORIES.includes(category as MdCategory)) {
    res.status(400).send('不正なカテゴリです');
    return;
  }
  if (!isSafeName(file, '.html')) {
    res.status(400).send('不正なファイル名です');
    return;
  }

  const filePath = findFileUnder(path.join(DOCS_DIR, category), file);
  if (!filePath) {
    res.status(404).send('ファイルが見つかりません');
    return;
  }
  res.type('html').sendFile(filePath);
});

// plans 直下のディレクトリをアーカイブ（docs/plans/<dir>/ → docs/plans/archive/<dir>/）
app.post('/api/docs/plans/:dir/archive-dir', (req: Request, res: Response) => {
  const dirName = req.params.dir as string;
  if (
    !dirName
    || dirName.includes('..')
    || dirName.includes('/')
    || dirName.includes('\\')
    || dirName.startsWith('.')
    || dirName === 'archive'
  ) {
    res.status(400).json({ success: false, data: null, error: '不正なディレクトリ名です' });
    return;
  }
  const plansDir = path.join(DOCS_DIR, 'plans');
  const src = path.join(plansDir, dirName);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    res.status(404).json({ success: false, data: null, error: 'ディレクトリが見つかりません' });
    return;
  }
  const archiveDir = path.join(plansDir, 'archive');
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
  const dst = path.join(archiveDir, dirName);
  if (fs.existsSync(dst)) {
    res.status(409).json({ success: false, data: null, error: 'archive 側に同名ディレクトリが既に存在します' });
    return;
  }
  fs.renameSync(src, dst);
  res.json({ success: true, data: { path: `archive/${dirName}` }, error: null });
});

// plans の md をアーカイブ（docs/plans/<file> → docs/plans/archive/<file>）
app.post('/api/docs/plans/:file/archive', (req: Request, res: Response) => {
  const file = req.params.file as string;
  if (!isSafeName(file, '.md')) {
    res.status(400).json({ success: false, data: null, error: '不正なファイル名です' });
    return;
  }
  const plansDir = path.join(DOCS_DIR, 'plans');
  const src = path.join(plansDir, file);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    res.status(404).json({ success: false, data: null, error: 'ファイルが見つかりません' });
    return;
  }
  const archiveDir = path.join(plansDir, 'archive');
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
  const dst = path.join(archiveDir, file);
  if (fs.existsSync(dst)) {
    res.status(409).json({ success: false, data: null, error: 'archive 側に同名ファイルが既に存在します' });
    return;
  }
  fs.renameSync(src, dst);
  res.json({ success: true, data: { path: `archive/${file}` }, error: null });
});

// 旧: design 専用エンドポイント（specs/design/ 限定、後方互換）
app.get('/api/design/:file', (req: Request, res: Response) => {
  const file = req.params.file as string;
  if (!isSafeName(file, '.html')) {
    res.status(400).send('不正なファイル名です');
    return;
  }
  const filePath = path.join(DOCS_DIR, 'specs', 'design', file);
  if (!fs.existsSync(filePath)) {
    res.status(404).send('ファイルが見つかりません');
    return;
  }
  res.type('html').sendFile(filePath);
});

// SSE: ルート直下の編集可能ファイルの外部変更を通知
// 注: `/api/files/:name` より先にマウントすること（:name にマッチしてしまうため）
app.get('/api/files/watch', (req: Request, res: Response) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const lastMtime: Record<string, number> = {};
  for (const [name, abs] of Object.entries(EDITABLE_FILES)) {
    if (fs.existsSync(abs)) lastMtime[name] = fs.statSync(abs).mtimeMs;
  }

  const sendChange = (name: string) => {
    const abs = EDITABLE_FILES[name];
    if (!abs || !fs.existsSync(abs)) return;
    let mtime: number;
    try {
      mtime = fs.statSync(abs).mtimeMs;
    } catch {
      return;
    }
    if (lastMtime[name] === mtime) return;
    lastMtime[name] = mtime;
    res.write(`event: change\ndata: ${JSON.stringify({ name, mtime })}\n\n`);
  };

  // fs.watch はエディタの atomic rename で発火しないことがあるため、個別監視 + 下のポーリングで保険
  const watchers: fs.FSWatcher[] = [];
  for (const [name, abs] of Object.entries(EDITABLE_FILES)) {
    try {
      const watcher = fs.watch(abs, () => sendChange(name));
      watcher.on('error', () => { /* ignore: poll で拾う */ });
      watchers.push(watcher);
    } catch {
      // ファイルが無い場合などは黙って無視（ポーリングで拾う）
    }
  }

  // ポーリング保険（WSL2 で fs.watch が不安定な事例があるため）
  const pollInterval = setInterval(() => {
    for (const name of Object.keys(EDITABLE_FILES)) sendChange(name);
  }, 2000);

  // keep-alive ping
  const pingInterval = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 30000);

  const cleanup = () => {
    clearInterval(pollInterval);
    clearInterval(pingInterval);
    for (const w of watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
  };
  req.on('close', cleanup);
});

// ルート直下の編集可能ファイル: 生 Markdown + mtime
app.get('/api/files/:name', (req: Request, res: Response) => {
  const name = req.params.name as string;
  const abs = EDITABLE_FILES[name];
  if (!abs) {
    res.status(400).json({ success: false, data: null, error: '編集対象外のファイルです' });
    return;
  }
  if (!fs.existsSync(abs)) {
    res.status(404).json({ success: false, data: null, error: 'ファイルが見つかりません' });
    return;
  }
  const content = fs.readFileSync(abs, 'utf-8');
  const mtime = fs.statSync(abs).mtimeMs;
  res.json({ success: true, data: { content, mtime }, error: null });
});

// ルート直下の編集可能ファイル: marked で HTML 化
app.get('/api/files/:name/render', (req: Request, res: Response) => {
  const name = req.params.name as string;
  const abs = EDITABLE_FILES[name];
  if (!abs) {
    res.status(400).json({ success: false, data: null, error: '編集対象外のファイルです' });
    return;
  }
  if (!fs.existsSync(abs)) {
    res.status(404).json({ success: false, data: null, error: 'ファイルが見つかりません' });
    return;
  }
  const raw = fs.readFileSync(abs, 'utf-8');
  const mtime = fs.statSync(abs).mtimeMs;
  const title = extractMdTitle(raw, name.replace(/\.md$/, ''));
  const md = raw.replace(/^---[\s\S]*?---\n*/, '');
  const html = marked(md) as string;
  res.json({ success: true, data: { title, html, mtime }, error: null });
});

// ルート直下の編集可能ファイル: 保存（mtime 楽観ロック + tmp → rename のアトミック書き込み）
app.put('/api/files/:name', (req: Request, res: Response) => {
  const name = req.params.name as string;
  const abs = EDITABLE_FILES[name];
  if (!abs) {
    res.status(400).json({ success: false, data: null, error: '編集対象外のファイルです' });
    return;
  }
  const body = req.body as { content?: unknown; baseMtime?: unknown } | undefined;
  if (!body || typeof body.content !== 'string' || typeof body.baseMtime !== 'number') {
    res.status(400).json({ success: false, data: null, error: 'content / baseMtime が不正です' });
    return;
  }
  if (!fs.existsSync(abs)) {
    res.status(404).json({ success: false, data: null, error: 'ファイルが見つかりません' });
    return;
  }
  const currentMtime = fs.statSync(abs).mtimeMs;
  if (currentMtime !== body.baseMtime) {
    res.status(409).json({
      success: false,
      data: { currentMtime },
      error: '外部で更新されています',
    });
    return;
  }
  const tmp = `${abs}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, body.content, 'utf-8');
    fs.renameSync(tmp, abs);
  } catch (e) {
    if (fs.existsSync(tmp)) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
    res.status(500).json({ success: false, data: null, error: '書き込みに失敗しました' });
    return;
  }
  const newMtime = fs.statSync(abs).mtimeMs;
  res.json({ success: true, data: { mtime: newMtime }, error: null });
});

// 静的配信（dev-admin/src/web/）
app.use(express.static(path.join(__dirname, 'web')));

app.listen(PORT, HOST, () => {
  console.log(`[dev-admin] running at http://${HOST}:${PORT}`);
});
