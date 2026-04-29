import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { marked } from 'marked';
import type { CategoryConfig, EditableFileConfig, VibeboardConfig } from './config';

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

// `child` が `root` 配下に収まることを realpath 越しに保証する。
// シンボリックリンクが root 外を指すケースを弾くための安全網。
function isInsideRoot(child: string, root: string): boolean {
  try {
    const realChild = fs.realpathSync(child);
    const realRoot = fs.realpathSync(root);
    if (realChild === realRoot) return true;
    return realChild.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
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
        if (!isInsideRoot(abs, root)) continue;
        stack.push(abs);
      } else if (entry.isFile() && entry.name === file) {
        if (!isInsideRoot(abs, root)) continue;
        return abs;
      }
    }
  }
  return null;
}

export function startServer(config: VibeboardConfig): void {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // カテゴリと編集対象を name→config の Map に持っておく（O(1) 参照）
  const categoryByName = new Map<string, CategoryConfig>(
    config.categories.map(c => [c.name, c])
  );
  const editableByName = new Map<string, EditableFileConfig>(
    config.editable.files.map(f => [f.name, f])
  );

  // ドキュメント一覧（ツリー構造）
  app.get('/api/docs', (_req: Request, res: Response) => {
    const data: Record<string, Tree> = {};
    for (const cat of config.categories) {
      data[cat.name] = listTree(cat.path, ['.md', '.html']);
    }
    res.json({ success: true, data, error: null });
  });

  // markdown ドキュメント取得（HTML 変換）
  app.get('/api/docs/:category/:file', (req: Request, res: Response) => {
    const cat = categoryByName.get(req.params.category as string);
    const file = req.params.file as string;

    if (!cat) {
      res.status(400).json({ success: false, data: null, error: '不正なカテゴリです' });
      return;
    }
    if (!isSafeName(file, '.md')) {
      res.status(400).json({ success: false, data: null, error: '不正なファイル名です' });
      return;
    }

    const filePath = findFileUnder(cat.path, file);
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
    const cat = categoryByName.get(req.params.category as string);
    const file = req.params.file as string;

    if (!cat) {
      res.status(400).send('不正なカテゴリです');
      return;
    }
    if (!isSafeName(file, '.html')) {
      res.status(400).send('不正なファイル名です');
      return;
    }

    const filePath = findFileUnder(cat.path, file);
    if (!filePath) {
      res.status(404).send('ファイルが見つかりません');
      return;
    }
    res.type('html').sendFile(filePath);
  });

  // カテゴリ直下のディレクトリをアーカイブ（<category>/<dir>/ → <category>/archive/<dir>/）
  app.post('/api/docs/:category/:dir/archive-dir', (req: Request, res: Response) => {
    const cat = categoryByName.get(req.params.category as string);
    const dirName = req.params.dir as string;
    if (!cat) {
      res.status(400).json({ success: false, data: null, error: '不正なカテゴリです' });
      return;
    }
    if (!cat.archive) {
      res.status(400).json({ success: false, data: null, error: 'このカテゴリは archive 操作を許可していません' });
      return;
    }
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
    const src = path.join(cat.path, dirName);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
      res.status(404).json({ success: false, data: null, error: 'ディレクトリが見つかりません' });
      return;
    }
    const archiveDir = path.join(cat.path, 'archive');
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
    const dst = path.join(archiveDir, dirName);
    if (fs.existsSync(dst)) {
      res.status(409).json({ success: false, data: null, error: 'archive 側に同名ディレクトリが既に存在します' });
      return;
    }
    fs.renameSync(src, dst);
    res.json({ success: true, data: { path: `archive/${dirName}` }, error: null });
  });

  // カテゴリ直下の md をアーカイブ（<category>/<file> → <category>/archive/<file>）
  app.post('/api/docs/:category/:file/archive', (req: Request, res: Response) => {
    const cat = categoryByName.get(req.params.category as string);
    const file = req.params.file as string;
    if (!cat) {
      res.status(400).json({ success: false, data: null, error: '不正なカテゴリです' });
      return;
    }
    if (!cat.archive) {
      res.status(400).json({ success: false, data: null, error: 'このカテゴリは archive 操作を許可していません' });
      return;
    }
    if (!isSafeName(file, '.md')) {
      res.status(400).json({ success: false, data: null, error: '不正なファイル名です' });
      return;
    }
    const src = path.join(cat.path, file);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      res.status(404).json({ success: false, data: null, error: 'ファイルが見つかりません' });
      return;
    }
    const archiveDir = path.join(cat.path, 'archive');
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
    const dst = path.join(archiveDir, file);
    if (fs.existsSync(dst)) {
      res.status(409).json({ success: false, data: null, error: 'archive 側に同名ファイルが既に存在します' });
      return;
    }
    fs.renameSync(src, dst);
    res.json({ success: true, data: { path: `archive/${file}` }, error: null });
  });

  // SSE: 編集可能ファイルの外部変更を通知
  // 注: `/api/files/:name` より先にマウントすること（:name にマッチしてしまうため）
  app.get('/api/files/watch', (req: Request, res: Response) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const lastMtime: Record<string, number> = {};
    for (const [name, ec] of editableByName) {
      if (fs.existsSync(ec.path)) lastMtime[name] = fs.statSync(ec.path).mtimeMs;
    }

    const sendChange = (name: string) => {
      const ec = editableByName.get(name);
      if (!ec || !fs.existsSync(ec.path)) return;
      let mtime: number;
      try {
        mtime = fs.statSync(ec.path).mtimeMs;
      } catch {
        return;
      }
      if (lastMtime[name] === mtime) return;
      lastMtime[name] = mtime;
      res.write(`event: change\ndata: ${JSON.stringify({ name, mtime })}\n\n`);
    };

    // fs.watch はエディタの atomic rename で発火しないことがあるため、個別監視 + 下のポーリングで保険
    const watchers: fs.FSWatcher[] = [];
    for (const [name, ec] of editableByName) {
      try {
        const watcher = fs.watch(ec.path, () => sendChange(name));
        watcher.on('error', () => { /* ignore: poll で拾う */ });
        watchers.push(watcher);
      } catch {
        // ファイルが無い場合などは黙って無視（ポーリングで拾う）
      }
    }

    // ポーリング保険（WSL2 で fs.watch が不安定な事例があるため）
    const pollInterval = setInterval(() => {
      for (const name of editableByName.keys()) sendChange(name);
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

  // 編集可能ファイル: 生 Markdown + mtime
  app.get('/api/files/:name', (req: Request, res: Response) => {
    const ec = editableByName.get(req.params.name as string);
    if (!ec) {
      res.status(400).json({ success: false, data: null, error: '編集対象外のファイルです' });
      return;
    }
    if (!fs.existsSync(ec.path)) {
      res.status(404).json({ success: false, data: null, error: 'ファイルが見つかりません' });
      return;
    }
    const content = fs.readFileSync(ec.path, 'utf-8');
    const mtime = fs.statSync(ec.path).mtimeMs;
    res.json({ success: true, data: { content, mtime }, error: null });
  });

  // 編集可能ファイル: marked で HTML 化
  app.get('/api/files/:name/render', (req: Request, res: Response) => {
    const name = req.params.name as string;
    const ec = editableByName.get(name);
    if (!ec) {
      res.status(400).json({ success: false, data: null, error: '編集対象外のファイルです' });
      return;
    }
    if (!fs.existsSync(ec.path)) {
      res.status(404).json({ success: false, data: null, error: 'ファイルが見つかりません' });
      return;
    }
    const raw = fs.readFileSync(ec.path, 'utf-8');
    const mtime = fs.statSync(ec.path).mtimeMs;
    const title = extractMdTitle(raw, name.replace(/\.md$/, ''));
    const md = raw.replace(/^---[\s\S]*?---\n*/, '');
    const html = marked(md) as string;
    res.json({ success: true, data: { title, html, mtime }, error: null });
  });

  // 編集可能ファイル: 保存（mtime 楽観ロック + tmp → rename のアトミック書き込み）
  app.put('/api/files/:name', (req: Request, res: Response) => {
    const ec = editableByName.get(req.params.name as string);
    if (!ec) {
      res.status(400).json({ success: false, data: null, error: '編集対象外のファイルです' });
      return;
    }
    const body = req.body as { content?: unknown; baseMtime?: unknown } | undefined;
    if (!body || typeof body.content !== 'string' || typeof body.baseMtime !== 'number') {
      res.status(400).json({ success: false, data: null, error: 'content / baseMtime が不正です' });
      return;
    }
    if (!fs.existsSync(ec.path)) {
      res.status(404).json({ success: false, data: null, error: 'ファイルが見つかりません' });
      return;
    }
    const currentMtime = fs.statSync(ec.path).mtimeMs;
    if (currentMtime !== body.baseMtime) {
      res.status(409).json({
        success: false,
        data: { currentMtime },
        error: '外部で更新されています',
      });
      return;
    }
    const tmp = `${ec.path}.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.writeFileSync(tmp, body.content, 'utf-8');
      fs.renameSync(tmp, ec.path);
    } catch (e) {
      if (fs.existsSync(tmp)) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
      res.status(500).json({ success: false, data: null, error: '書き込みに失敗しました' });
      return;
    }
    const newMtime = fs.statSync(ec.path).mtimeMs;
    res.json({ success: true, data: { mtime: newMtime }, error: null });
  });

  // index.html はテンプレ置換しつつ返す（タイトル / クライアント設定の inject）
  // 配布物は `vibeboard/src/web/` に生のまま含まれる（tsconfig で除外、package.json の files で同梱）
  const webDir = path.join(__dirname, '..', 'src', 'web');
  const indexHtmlRaw = fs.readFileSync(path.join(webDir, 'index.html'), 'utf-8');
  // クライアント側に出すカテゴリ情報（絶対パスは漏らさない）
  const clientCategories = config.categories.map(c => ({
    name: c.name,
    label: c.label,
    archive: c.archive,
  }));
  const clientEditable = {
    label: config.editable.label,
    files: config.editable.files.map(f => ({ name: f.name, label: f.label })),
  };
  const renderIndexHtml = (): string => {
    const clientConfig = JSON.stringify({
      title: config.title,
      categories: clientCategories,
      editable: clientEditable,
    });
    return indexHtmlRaw
      .replace(/__VIBEBOARD_TITLE__/g, escapeHtml(config.title))
      .replace(/__VIBEBOARD_CLIENT_CONFIG__/g, clientConfig);
  };

  app.get(['/', '/index.html'], (_req: Request, res: Response) => {
    res.type('html').send(renderIndexHtml());
  });

  // 静的配信
  app.use(express.static(webDir));

  app.listen(config.port, config.host, () => {
    console.log(`[vibeboard] running at http://${config.host}:${config.port}`);
    console.log(`[vibeboard] root: ${config.root}`);
    console.log(`[vibeboard] title: ${config.title}`);
    console.log(`[vibeboard] categories: ${config.categories.map(c => c.name).join(', ')}`);
    console.log(`[vibeboard] editable: ${config.editable.files.map(f => f.name).join(', ')}`);
  });
}
