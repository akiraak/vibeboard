import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { marked } from 'marked';
import type { CategoryConfig, CustomTabConfig, EditableFileConfig, VibeboardConfig } from './config';
import { reclaimPort, removePidFile, writePidFile } from './portGuard';
import {
  MAX_SOURCE_BYTES,
  applyEol,
  isEol,
  isSymlink,
  readSource,
  resolveSource,
  writeSourceAtomic,
} from './source';

interface TreeFile {
  name: string;
  path: string;
  title: string;
  mtime: number;
}

interface TreeDir {
  name: string;
  // ディレクトリ内の README.md のタイトル（無ければ null）。サイドバーで dir 名に併記する
  title: string | null;
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

// タイトルを抜けるのは .md / .html だけ。**拡張子を見てから読む**こと。
// 以前は読んでから判定していたため、対象外の拡張子でも中身を読んで捨てていた。
function extractTitle(absPath: string, fallback: string): string {
  if (absPath.endsWith('.md')) {
    return extractMdTitle(fs.readFileSync(absPath, 'utf-8'), fallback);
  }
  if (absPath.endsWith('.html')) {
    return extractHtmlTitle(fs.readFileSync(absPath, 'utf-8'), fallback);
  }
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

// マークダウン中の <img src="..."> / <audio src="..."> / <video src="..."> / <source src="...">
// と、メディア系拡張子に向く <a href="..."> の **相対パス** を /files/<rel-from-root> に書き換える。
// 元の Markdown は無編集のため GitHub / VSCode プレビュー等の相対パス参照は壊れない。
// 絶対 URL (http(s):// / // / data: / mailto: / # / 先頭 /) はそのまま。
// rootDir 外を指す相対パスもそのまま（リンク切れ表示にする）。
// <a href> は画像/音声/動画系拡張子のみ対象。
// .md 同士の遷移リンクは SPA 側で扱う想定のため触らない。
const ASSET_LINK_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|mp3|wav|ogg|flac|m4a|aac|mp4|webm|ogv|mov)(?:$|[?#])/i;

function resolveRelativeToFiles(src: string, mdDir: string, rootDir: string): string | null {
  const reAbsolute = /^(https?:)?\/\/|^data:|^mailto:|^tel:|^#|^\//i;
  if (reAbsolute.test(src)) return null;
  const hashIdx = src.indexOf('#');
  const queryIdx = src.indexOf('?');
  let cutAt = -1;
  if (hashIdx !== -1) cutAt = hashIdx;
  if (queryIdx !== -1 && (cutAt === -1 || queryIdx < cutAt)) cutAt = queryIdx;
  const pathPart = cutAt === -1 ? src : src.slice(0, cutAt);
  const suffix = cutAt === -1 ? '' : src.slice(cutAt);
  if (!pathPart) return null;
  const abs = path.resolve(mdDir, pathPart);
  const relFromRoot = path.relative(rootDir, abs);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) return null;
  const encoded = relFromRoot.split(path.sep).map(encodeURIComponent).join('/');
  return '/files/' + encoded + suffix;
}

function rewriteRelativeAssetUrls(html: string, mdFilePath: string, rootDir: string): string {
  const mdDir = path.dirname(mdFilePath);
  // <img>, <audio>, <video>, <source> の src 属性を書き換え (タグ名は共通処理)
  let out = html.replace(
    /<(img|audio|video|source)\b([^>]*?)\ssrc=(["'])([^"']+)\3([^>]*)>/gi,
    (match, tag, before, quote, src, after) => {
      const newSrc = resolveRelativeToFiles(src, mdDir, rootDir);
      if (newSrc === null) return match;
      return `<${tag}${before} src=${quote}${newSrc}${quote}${after}>`;
    },
  );
  out = out.replace(/<a\b([^>]*?)\shref=(["'])([^"']+)\2([^>]*)>/gi, (match, before, quote, href, after) => {
    if (!ASSET_LINK_EXT.test(href)) return match;
    const newHref = resolveRelativeToFiles(href, mdDir, rootDir);
    if (newHref === null) return match;
    return `<a${before} href=${quote}${newHref}${quote}${after}>`;
  });
  return out;
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
        // ディレクトリ内に README.md があればそのタイトルを取り出して dir 名に併記する
        const readmeAbs = path.join(abs, 'README.md');
        let title: string | null = null;
        if (fs.existsSync(readmeAbs) && fs.statSync(readmeAbs).isFile()) {
          const extracted = extractTitle(readmeAbs, '');
          if (extracted) title = extracted;
        }
        dirs.push({ name: entry.name, title, files: sub.files, dirs: sub.dirs, mtime });
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

// 絶対パスを root からの相対パスへ直す。クライアントへ渡す識別子はこの形に揃える
// （絶対パスは出さない。Windows の区切りも '/' に寄せる）。
function toRootRel(absPath: string, root: string): string {
  return path.relative(root, absPath).split(path.sep).join('/');
}

function isSafeName(file: string, ext: string): boolean {
  return !file.includes('..') && !file.includes('/') && !file.includes('\\') && file.endsWith(ext);
}

// サブディレクトリを含むパスの安全性を検証する。
// `..` / 空セグメント / Windows パス区切り / 絶対パスを弾き、末尾拡張子を強制する。
function isSafeSubPath(subPath: string, ext: string): boolean {
  if (!subPath) return false;
  if (subPath.includes('\\')) return false;
  if (subPath.startsWith('/')) return false;
  if (!subPath.endsWith(ext)) return false;
  for (const seg of subPath.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
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

export async function startServer(config: VibeboardConfig): Promise<void> {
  const app = express();
  // ファイル本文をまるごと JSON で往復させるため、MAX_SOURCE_BYTES (1MB) の中身が
  // エスケープで膨らんでも収まるだけの余裕を取る。実際の上限は source.ts 側で掛ける。
  app.use(express.json({ limit: '8mb' }));

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

  // markdown ドキュメント取得（HTML 変換）。サブパス対応 (`docs/specs/design/.../README.md` 等)
  app.get('/api/docs/:category/*', (req: Request, res: Response) => {
    const cat = categoryByName.get(req.params.category as string);
    const subPath = (req.params[0] as string) || '';

    if (!cat) {
      res.status(400).json({ success: false, data: null, error: '不正なカテゴリです' });
      return;
    }
    if (!isSafeSubPath(subPath, '.md')) {
      res.status(400).json({ success: false, data: null, error: '不正なファイルパスです' });
      return;
    }

    const filePath = path.resolve(cat.path, subPath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.status(404).json({ success: false, data: null, error: 'ファイルが見つかりません' });
      return;
    }
    if (!isInsideRoot(filePath, cat.path)) {
      res.status(400).json({ success: false, data: null, error: '不正なファイルパスです' });
      return;
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const basename = path.basename(subPath, '.md');
    const title = extractMdTitle(raw, basename);
    const md = raw.replace(/^---[\s\S]*?---\n*/, '');
    const html = rewriteRelativeAssetUrls(marked(md) as string, filePath, config.root);
    res.json({ success: true, data: { title, html }, error: null });
  });

  // design HTML をそのまま返す（iframe 用・カテゴリ指定）。サブパス対応
  app.get('/api/design/:category/*', (req: Request, res: Response) => {
    const cat = categoryByName.get(req.params.category as string);
    const subPath = (req.params[0] as string) || '';

    if (!cat) {
      res.status(400).send('不正なカテゴリです');
      return;
    }
    if (!isSafeSubPath(subPath, '.html')) {
      res.status(400).send('不正なファイルパスです');
      return;
    }

    const filePath = path.resolve(cat.path, subPath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.status(404).send('ファイルが見つかりません');
      return;
    }
    if (!isInsideRoot(filePath, cat.path)) {
      res.status(400).send('不正なファイルパスです');
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

  // SSE: **クライアントが今開いている 1 ファイル**の外部変更を通知する。
  // 注: `/api/files/:name` より先にマウントすること（:name にマッチしてしまうため）
  //
  // 以前は editable の 4 件を固定で監視していたが、クライアントは開いていない
  // ファイルの通知を捨てていたので実質は無駄だった。対象がプロジェクト全体に
  // 広がった今、ツリー全体を張るわけにもいかない（`fs.watch` の recursive は
  // WSL2 で不安定で、ポーリング保険の母数も跳ね上がる）。
  // クライアントが `?watch=<root 相対パス>` で対象を伝え、開くファイルが変わったら
  // 繋ぎ直す方式にする。
  app.get('/api/files/watch', (req: Request, res: Response) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // 対象が無い / 境界を通らないパスなら、何も監視せず接続だけ保つ
    // （エラーで切ると画面が「切断中」を出してしまうため）
    const requested = typeof req.query.watch === 'string' ? req.query.watch : '';
    const resolved = requested ? resolveSource(config.root, requested) : null;
    const target = resolved && resolved.ok
      ? { relPath: resolved.relPath, absPath: resolved.absPath }
      : null;

    let lastMtime: number | null = null;
    if (target && fs.existsSync(target.absPath)) {
      lastMtime = fs.statSync(target.absPath).mtimeMs;
    }

    const sendChange = () => {
      if (!target) return;
      let mtime: number;
      try {
        mtime = fs.statSync(target.absPath).mtimeMs;
      } catch {
        return;
      }
      if (lastMtime === mtime) return;
      lastMtime = mtime;
      res.write(`event: change\ndata: ${JSON.stringify({ path: target.relPath, mtime })}\n\n`);
    };

    // fs.watch はエディタの atomic rename で発火しないことがあるため、下のポーリングで保険
    let watcher: fs.FSWatcher | null = null;
    if (target) {
      try {
        watcher = fs.watch(target.absPath, () => sendChange());
        watcher.on('error', () => { /* ignore: poll で拾う */ });
      } catch {
        // ファイルが無い場合などは黙って無視（ポーリングで拾う）
      }
    }

    // ポーリング保険（WSL2 で fs.watch が不安定な事例があるため）
    const pollInterval = target ? setInterval(sendChange, 2000) : null;

    // keep-alive ping
    const pingInterval = setInterval(() => {
      res.write(`: ping\n\n`);
    }, 30000);

    const cleanup = () => {
      if (pollInterval) clearInterval(pollInterval);
      clearInterval(pingInterval);
      if (watcher) {
        try { watcher.close(); } catch { /* ignore */ }
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
    const html = rewriteRelativeAssetUrls(marked(md) as string, ec.path, config.root);
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

  // === プロジェクト内の任意ファイル（root 相対パス 1 本で指す） ===
  //
  // カテゴリや editable の一覧とは独立していて、**root 配下かどうかだけ**が境界。
  // 判定は source.ts の resolveSource に集約する。

  const sourceParam = (req: Request): string => (req.params[0] as string) || '';

  // 生テキスト + mtime + 改行コード。編集できないものは content: null と理由を返す
  app.get('/api/source/*', (req: Request, res: Response) => {
    const resolved = resolveSource(config.root, sourceParam(req));
    if (!resolved.ok) {
      res.status(resolved.status).json({ success: false, data: null, error: resolved.error });
      return;
    }
    let st: fs.Stats;
    try {
      st = fs.lstatSync(resolved.absPath);
    } catch {
      res.status(404).json({ success: false, data: null, error: 'ファイルが見つかりません' });
      return;
    }
    if (st.isDirectory()) {
      res.status(400).json({ success: false, data: null, error: 'ディレクトリは開けません' });
      return;
    }
    try {
      const data = readSource(resolved.absPath);
      res.json({ success: true, data: { path: resolved.relPath, ...data }, error: null });
    } catch {
      res.status(500).json({ success: false, data: null, error: '読み込みに失敗しました' });
    }
  });

  // 保存（mtime 楽観ロック + tmp → rename）。改行コードは eol で復元する
  app.put('/api/source/*', (req: Request, res: Response) => {
    const resolved = resolveSource(config.root, sourceParam(req));
    if (!resolved.ok) {
      res.status(resolved.status).json({ success: false, data: null, error: resolved.error });
      return;
    }
    const body = req.body as { content?: unknown; baseMtime?: unknown; eol?: unknown } | undefined;
    if (!body || typeof body.content !== 'string' || typeof body.baseMtime !== 'number') {
      res.status(400).json({ success: false, data: null, error: 'content / baseMtime が不正です' });
      return;
    }
    if (body.eol !== undefined && !isEol(body.eol)) {
      res.status(400).json({ success: false, data: null, error: 'eol が不正です' });
      return;
    }
    if (!fs.existsSync(resolved.absPath) || !fs.statSync(resolved.absPath).isFile()) {
      res.status(404).json({ success: false, data: null, error: 'ファイルが見つかりません' });
      return;
    }
    // tmp → rename はシンボリックリンク自体を置き換えてしまうため、書き込みは拒否する
    if (isSymlink(resolved.absPath)) {
      res.status(403).json({ success: false, data: null, error: 'シンボリックリンクは編集できません' });
      return;
    }
    const currentMtime = fs.statSync(resolved.absPath).mtimeMs;
    if (currentMtime !== body.baseMtime) {
      res.status(409).json({ success: false, data: { currentMtime }, error: '外部で更新されています' });
      return;
    }
    const out = applyEol(body.content, isEol(body.eol) ? body.eol : 'lf');
    if (Buffer.byteLength(out, 'utf-8') > MAX_SOURCE_BYTES) {
      res.status(413).json({ success: false, data: null, error: 'ファイルが大きすぎます' });
      return;
    }
    try {
      writeSourceAtomic(resolved.absPath, out);
    } catch {
      res.status(500).json({ success: false, data: null, error: '書き込みに失敗しました' });
      return;
    }
    res.json({ success: true, data: { mtime: fs.statSync(resolved.absPath).mtimeMs }, error: null });
  });

  // Markdown を HTML 化して返す（root 相対パス）。編集タブとカテゴリのプレビューを
  // 1 本にまとめるためのもので、素材の相対パス書き換えも従来と同じ処理を通す。
  app.get('/api/render/*', (req: Request, res: Response) => {
    const relPath = (req.params[0] as string) || '';
    const resolved = resolveSource(config.root, relPath);
    if (!resolved.ok) {
      res.status(resolved.status).json({ success: false, data: null, error: resolved.error });
      return;
    }
    if (!relPath.toLowerCase().endsWith('.md')) {
      res.status(400).json({ success: false, data: null, error: 'Markdown ではありません' });
      return;
    }
    if (!fs.existsSync(resolved.absPath) || !fs.statSync(resolved.absPath).isFile()) {
      res.status(404).json({ success: false, data: null, error: 'ファイルが見つかりません' });
      return;
    }
    const raw = fs.readFileSync(resolved.absPath, 'utf-8');
    const mtime = fs.statSync(resolved.absPath).mtimeMs;
    const title = extractMdTitle(raw, path.basename(relPath, '.md'));
    const md = raw.replace(/^---[\s\S]*?---\n*/, '');
    const html = rewriteRelativeAssetUrls(marked(md) as string, resolved.absPath, config.root);
    res.json({ success: true, data: { title, html, mtime }, error: null });
  });

  // index.html はテンプレ置換しつつ返す（タイトル / クライアント設定の inject）
  // 配布物は `vibeboard/src/web/` に生のまま含まれる（tsconfig で除外、package.json の files で同梱）
  const webDir = path.join(__dirname, '..', 'src', 'web');
  const indexHtmlRaw = fs.readFileSync(path.join(webDir, 'index.html'), 'utf-8');
  // クライアント側に出すカテゴリ情報（絶対パスは漏らさない）
  // path は **root 相対**。クライアントはこれを繋いで /api/source/* を引くので必要になる
  // （絶対パスは従来どおり出さない）。
  const clientCategories = config.categories.map(c => ({
    name: c.name,
    label: c.label,
    archive: c.archive,
    path: toRootRel(c.path, config.root),
  }));
  const clientEditable = {
    label: config.editable.label,
    files: config.editable.files.map(f => ({
      name: f.name,
      label: f.label,
      path: toRootRel(f.path, config.root),
    })),
  };
  // customTabs は baseUrl ごとクライアントへ流す（クライアントが直接 fetch するため）。
  // baseUrl はループバック前提なので秘匿対象ではない。
  const clientCustomTabs: CustomTabConfig[] = config.customTabs.map(t => ({
    name: t.name,
    label: t.label,
    baseUrl: t.baseUrl,
  }));
  const renderIndexHtml = (): string => {
    const clientConfig = JSON.stringify({
      title: config.title,
      categories: clientCategories,
      editable: clientEditable,
      customTabs: clientCustomTabs,
    });
    return indexHtmlRaw
      .replace(/__VIBEBOARD_TITLE__/g, escapeHtml(config.title))
      .replace(/__VIBEBOARD_CLIENT_CONFIG__/g, clientConfig);
  };

  app.get(['/', '/index.html'], (_req: Request, res: Response) => {
    res.type('html').send(renderIndexHtml());
  });

  // プロジェクトルートの静的ファイルを /files プレフィックスで配信
  //   - マークダウン内の <img src="../foo.png"> のような相対パス画像を vibeboard 上で表示するため
  //   - dotfiles ('.env' / '.git/' 等) は 403。node_modules 配下も明示的に弾く
  //   - host デフォルトは 127.0.0.1 で外部公開していない前提
  app.use('/files', (req: Request, res: Response, next) => {
    const decoded = (() => {
      try { return decodeURIComponent(req.path); } catch { return req.path; }
    })();
    if (/(^|\/)node_modules(\/|$)/.test(decoded)) {
      res.status(403).type('text').send('forbidden');
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    next();
  }, express.static(config.root, { dotfiles: 'deny', fallthrough: true, index: false }));

  // 静的配信
  app.use(express.static(webDir));

  // ポートが埋まっていた場合、同じ root の vibeboard なら停止して 1 度だけ再試行する。
  try {
    await listenOnce(app, config);
  } catch (err) {
    if (!isAddrInUse(err)) throw err;
    const result = await reclaimPort(config);
    if (!result.ok) {
      console.error(`[vibeboard] 起動に失敗しました: ${result.message}`);
      process.exit(1);
    }
    console.log(`[vibeboard] ${result.message}。再試行します`);
    await listenOnce(app, config);
  }

  writePidFile(config);
  const cleanup = () => removePidFile(config.port);
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      cleanup();
      process.exit(0);
    });
  }

  console.log(`[vibeboard] running at http://${config.host}:${config.port}`);
  console.log(`[vibeboard] root: ${config.root}`);
  console.log(`[vibeboard] title: ${config.title}`);
  console.log(`[vibeboard] categories: ${config.categories.map(c => c.name).join(', ')}`);
  console.log(`[vibeboard] editable: ${config.editable.files.map(f => f.name).join(', ')}`);
  if (config.customTabs.length > 0) {
    const cts = config.customTabs.map(t => `${t.name}→${t.baseUrl}`).join(', ');
    console.log(`[vibeboard] customTabs: ${cts}`);
  }
}

function isAddrInUse(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
}

function listenOnce(app: express.Express, config: VibeboardConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host);
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });
}
