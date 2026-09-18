/**
 * サイドバーの検索（Plans / Specs / Files）。パスと本文を文字列で絞り込む。
 *
 * 規則（docs/plans/vibeboard-search.md）:
 *   - 大文字小文字を区別しない部分一致。空白区切りは AND（全部の語がパスか本文のどこかにある）
 *   - カテゴリは拡張子で絞り dotfile を飛ばす（ツリーと同じ）。Files は除外名だけ見て dotfile も出す
 *   - 本文は MAX_SOURCE_BYTES まで。二進は飛ばす（パスの一致だけで拾う）
 *   - 上限 200 件。パスの一致を先に、次に本文の一致（一致した行数の多い順）
 */
import fs from 'fs';
import path from 'path';
import { isBinary, MAX_SOURCE_BYTES } from './source';

export const SEARCH_LIMIT = 200;
export const SNIPPET_MAX = 160;

export interface SearchHit {
  path: string;          // root からの相対パス（'/' 区切り）
  name: string;
  title: string | null;  // Markdown の見出し（カテゴリのときだけ）
  pathMatch: boolean;    // パスが一致したか
  lines: number;         // 本文で一致した行数
  snippet: string | null; // 最初に一致した行（切り詰め）
  mtime: number;
}

export interface SearchOptions {
  exts?: string[] | null;   // null なら拡張子で絞らない（Files）
  excludes?: string[];      // 名前の明示リスト（Files）
  skipDotfiles?: boolean;   // カテゴリは true
  limit?: number;
}

/** 検索語を語に割る（空白区切り・小文字化・空を落とす） */
export function parseQuery(q: string): string[] {
  return String(q || '')
    .split(/\s+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 全部の語がどこかにあるか（パス ＋ 本文をまとめて見る。語ごとに OR ではなく AND） */
export function matchesAll(terms: string[], haystacks: string[]): boolean {
  const lower = haystacks.map(h => h.toLowerCase());
  return terms.every(t => lower.some(h => h.includes(t)));
}

function extractTitle(raw: string): string | null {
  const body = raw.replace(/^---[\s\S]*?---\n*/, '');
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

function snippetOf(line: string, terms: string[]): string {
  const s = line.trim();
  if (s.length <= SNIPPET_MAX) return s;
  const lower = s.toLowerCase();
  const first = Math.min(...terms.map(t => { const i = lower.indexOf(t); return i < 0 ? Infinity : i; }));
  const start = Number.isFinite(first) ? Math.max(0, first - 40) : 0;
  const cut = s.slice(start, start + SNIPPET_MAX);
  return (start > 0 ? '…' : '') + cut + (start + SNIPPET_MAX < s.length ? '…' : '');
}

/** 1 ファイルの本文を検査する。二進・大きすぎるものは null（パスの一致だけで判断する）
 *
 * `lines` は **語が全部そろった行**の数（パスで既に一致した語は数えない）。「1」のような短い語で
 * 大きいファイルが上に来ないようにするため。1 行にそろわないときは 0 で、snippet はどれかの語がある最初の行。
 */
export function scanText(raw: Buffer, terms: string[], pathTerms: string[] = []): { lines: number; snippet: string | null; text: string } | null {
  if (raw.length > MAX_SOURCE_BYTES || isBinary(raw)) return null;
  const text = raw.toString('utf-8');
  const contentTerms = terms.filter(t => !pathTerms.includes(t));
  const need = contentTerms.length > 0 ? contentTerms : terms;
  let lines = 0;
  let snippet: string | null = null;
  let fallback: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const l = line.toLowerCase();
    if (need.every(t => l.includes(t))) {
      lines++;
      if (snippet === null) snippet = snippetOf(line, need);
    } else if (fallback === null && need.some(t => l.includes(t))) {
      fallback = snippetOf(line, need);
    }
  }
  return { lines, snippet: snippet ?? fallback, text };
}

/** root 配下を歩いて検索する。結果はパス一致 → 本文一致（行数の多い順）→ mtime 降順 */
export function searchFiles(root: string, q: string, options: SearchOptions = {}): SearchHit[] {
  const terms = parseQuery(q);
  if (terms.length === 0) return [];
  const exts = options.exts === undefined ? ['.md', '.html'] : options.exts;
  const excludes = options.excludes || [];
  const skipDotfiles = options.skipDotfiles !== false;
  const limit = options.limit || SEARCH_LIMIT;
  const hits: SearchHit[] = [];

  const walk = (absDir: string, relPrefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (excludes.includes(entry.name)) continue;
      if (skipDotfiles && entry.name.startsWith('.')) continue;
      const abs = path.join(absDir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;   // シンボリックリンクは辿らない
      if (exts && !exts.includes(path.extname(entry.name))) continue;
      // 大きいファイルは読まずに飛ばす（stat だけ）。13GB の作業ツリーでも数秒で返すため
      let mtime = 0;
      let size = 0;
      try {
        const st = fs.statSync(abs);
        mtime = st.mtimeMs;
        size = st.size;
      } catch {
        continue;
      }
      const relLower = rel.toLowerCase();
      const pathTerms = terms.filter(t => relLower.includes(t));
      let scanned: ReturnType<typeof scanText> = null;
      if (size <= MAX_SOURCE_BYTES) {
        try {
          scanned = scanText(fs.readFileSync(abs), terms, pathTerms);
        } catch {
          continue;
        }
      }
      const pathMatch = pathTerms.length === terms.length;
      const text = scanned ? scanned.text : '';
      if (!pathMatch && !matchesAll(terms, [rel, text])) continue;
      hits.push({
        path: rel,
        name: entry.name,
        title: exts && scanned && path.extname(entry.name) === '.md' ? extractTitle(text) : null,
        pathMatch,
        lines: scanned ? scanned.lines : 0,
        snippet: scanned ? scanned.snippet : null,
        mtime,
      });
    }
  };
  walk(root, '');

  hits.sort((a, b) => {
    if (a.pathMatch !== b.pathMatch) return a.pathMatch ? -1 : 1;
    if (a.lines !== b.lines) return b.lines - a.lines;
    return b.mtime - a.mtime;
  });
  return hits.slice(0, limit);
}
