import fs from 'fs';
import path from 'path';

// プロジェクト内の任意ファイルを読み書きするための「境界」。
// **書き込みを許す範囲を決めるのはこのファイルだけ**にする（server.ts 側で判定を散らさない）。
//
// テキストエディタと同じく全拡張子・全ディレクトリを対象にするので、
// 拡張子ホワイトリストは持たない。代わりに以下で守る:
//   1. root 配下に収まること（`..` / 絶対パス / シンボリックリンク経由の脱出を弾く）
//   2. 除外リストに入っていないこと
//   3. シンボリックリンクでないこと（読みは follow、書きは置き換えで挙動が変わるため）
//   4. サイズ上限
//   5. テキストであること（バイナリ / 不正な UTF-8 は読み取り専用）

/** 既定の除外。開いて編集する対象ではなく、かつ桁違いに数が多いものだけ。 */
export const DEFAULT_EXCLUDES = ['.git', 'node_modules'];

/** 編集対象として開けるサイズの上限。 */
export const MAX_SOURCE_BYTES = 1024 * 1024;

/** バイナリ判定で覗く先頭バイト数。 */
const SNIFF_BYTES = 8192;

export type Eol = 'lf' | 'crlf' | 'mixed';

export type ReadOnlyReason = 'binary' | 'too-large' | 'symlink';

export interface SourceOk {
  ok: true;
  absPath: string;
  relPath: string;
}

export interface SourceErr {
  ok: false;
  status: number;
  error: string;
}

export type SourceResult = SourceOk | SourceErr;

/**
 * root 相対パスとして受け付けられる形かを検証する。
 * express が 1 度デコード済みの値をそのまま渡す前提で、ここで再デコードはしない
 * （`%252e%252e` のような二重エンコードを通してしまうため）。
 */
export function isSafeRelPath(relPath: string): boolean {
  if (!relPath) return false;
  if (relPath.includes('\0')) return false;
  if (relPath.includes('\\')) return false;
  if (relPath.startsWith('/')) return false;
  if (path.isAbsolute(relPath)) return false;
  for (const seg of relPath.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/** パスのどこかのセグメントが除外名に一致するか。 */
export function isExcluded(relPath: string, excludes: string[]): boolean {
  const segs = relPath.split('/');
  return excludes.some(ex => segs.includes(ex));
}

/**
 * `absPath` が `root` 配下に収まることを realpath 越しに保証する。
 *
 * 呼ぶ前に `isSafeRelPath` が `..` と絶対パスを弾いているので、`path.resolve` の
 * 結果が字面の上で root を出ることはない。**残る脱出経路は途中のシンボリックリンク
 * だけ**なので、そこを realpath で潰す。
 * 新規作成では absPath 自体が未存在なので、存在する最も近い祖先まで遡って確かめる。
 */
function resolvesInsideRoot(absPath: string, root: string): boolean {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return false;
  }
  let cur = absPath;
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
  try {
    const realCur = fs.realpathSync(cur);
    return realCur === realRoot || realCur.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

/**
 * root 相対パスを解決する。存在確認はしない（新規作成でも使うため）。
 */
export function resolveSource(
  root: string,
  relPath: string,
  excludes: string[] = DEFAULT_EXCLUDES,
): SourceResult {
  if (!isSafeRelPath(relPath)) {
    return { ok: false, status: 400, error: '不正なファイルパスです' };
  }
  if (isExcluded(relPath, excludes)) {
    return { ok: false, status: 403, error: '対象外のパスです' };
  }
  const absPath = path.resolve(root, relPath);
  if (!resolvesInsideRoot(absPath, root)) {
    return { ok: false, status: 400, error: '不正なファイルパスです' };
  }
  return { ok: true, absPath, relPath };
}

/** シンボリックリンクか（リンク先は辿らない）。 */
export function isSymlink(absPath: string): boolean {
  try {
    return fs.lstatSync(absPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * バイナリ判定。先頭に NUL があるか、UTF-8 として解釈できないものはテキストとして扱わない。
 * Shift_JIS のファイルを UTF-8 で読んで書き戻すと壊れるので、そこも弾く。
 */
export function isBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, SNIFF_BYTES);
  if (head.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return false;
  } catch {
    return true;
  }
}

/**
 * 改行コードを判定する。
 * **`textarea` は値を LF に正規化する**ので、これを保存時に復元しないと
 * CRLF のファイルが全行差分になる。
 */
export function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lfTotal = (text.match(/\n/g) || []).length;
  const loneLf = lfTotal - crlf;
  if (crlf > 0 && loneLf > 0) return 'mixed';
  if (crlf > 0) return 'crlf';
  return 'lf';
}

/**
 * 保存直前に改行コードを戻す。
 * 一度 LF へ潰してから適用するので、CRLF のまま送られてきても二重変換にならない。
 * `mixed` は復元しようがないので LF に寄せる（画面側で通知する）。
 */
export function applyEol(text: string, eol: Eol): string {
  const lf = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
}

export function isEol(v: unknown): v is Eol {
  return v === 'lf' || v === 'crlf' || v === 'mixed';
}

export interface SourceContent {
  content: string | null;
  mtime: number;
  size: number;
  eol: Eol;
  readOnly: boolean;
  readOnlyReason: ReadOnlyReason | null;
}

/**
 * ファイルを読む。編集できないものは `content: null` + 理由を返す
 * （一覧から開けはするが保存はさせない、というテキストエディタと同じ扱い）。
 */
export function readSource(absPath: string): SourceContent {
  const st = fs.statSync(absPath);
  const base = {
    content: null,
    mtime: st.mtimeMs,
    size: st.size,
    eol: 'lf' as Eol,
    readOnly: true,
  };
  if (isSymlink(absPath)) {
    return { ...base, readOnlyReason: 'symlink' };
  }
  if (st.size > MAX_SOURCE_BYTES) {
    return { ...base, readOnlyReason: 'too-large' };
  }
  const buf = fs.readFileSync(absPath);
  if (isBinary(buf)) {
    return { ...base, readOnlyReason: 'binary' };
  }
  const content = buf.toString('utf-8');
  return {
    content,
    mtime: st.mtimeMs,
    size: st.size,
    eol: detectEol(content),
    readOnly: false,
    readOnlyReason: null,
  };
}

/**
 * tmp へ書いて rename する（既存の編集機能と同じアトミック書き込み）。
 * シンボリックリンクに対しては**リンク自体を置き換えてしまう**ので、
 * 呼ぶ側で `isSymlink` を弾いてから使うこと。
 */
export function writeSourceAtomic(absPath: string, data: string): void {
  const tmp = `${absPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, data, 'utf-8');
    fs.renameSync(tmp, absPath);
  } catch (e) {
    if (fs.existsSync(tmp)) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
    throw e;
  }
}
