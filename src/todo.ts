import { createHash } from 'crypto';
import path from 'path';

// TODO.md を「タスクの木」として読む純関数。ファイルにもプロセスにも触らない。
//
// プレビュー（marked）は Markdown をそのまま描くだけで、階層は見た目のインデントでしか
// 分からない。ここでは字下げを解釈して親子にし、タスクの下に書かれた
// `依存:` / `派生元:` / `関連:` の行と Markdown リンクを「関係」として取り出す。
//
// **書式は決め打ちしない。** `- [ ]` で始まる行だけをタスクとして拾い、それ以外の行
// （メモ・続き）は捨てずにそのタスクに付ける。解釈できない関係は「見つからない」として
// 残すだけで、本文を落とすことはしない。
//
// TODO.md 自体には id を書かせない（人がそのまま読み書きできる Markdown のままにする）。
// タスク同士の参照は文面で引く。

export type TodoState = 'open' | 'done' | 'active' | 'cancelled';

export type RelationKind = 'depends' | 'derived' | 'related';

/** ドキュメントへの関連（Markdown リンク / パス）。 */
export interface TodoDoc {
  /** チップに出す名前。リンクの文字列（無ければファイル名） */
  label: string;
  /** 書かれたままの href */
  href: string;
  /** root 相対パス。root の外を指すなら null */
  path: string | null;
  /** そのファイルが実在するか（path が null なら false） */
  exists: boolean;
  /** どこに書かれていたか。text = タスクの行そのもの / note = メモ行 / relation = 関係行 */
  source: 'text' | 'note' | 'relation';
  /** 関係行に書かれていた場合の種類 */
  kind: RelationKind | null;
}

/** 同じファイルの中の別タスクへの参照。 */
export interface TodoRef {
  kind: RelationKind;
  /** 書かれたままの相手の文面 */
  text: string;
  /** 引けた相手の id。引けなければ null */
  taskId: string | null;
  /** 候補が複数あって決められなかった */
  ambiguous: boolean;
}

export interface TodoInbound {
  kind: RelationKind;
  /** 参照している側のタスク */
  taskId: string;
}

export interface TodoNode {
  id: string;
  /** 1 始まりの行番号 */
  line: number;
  /** `[ ]` の中の 1 文字 */
  mark: string;
  state: TodoState;
  /** チェックボックスより後ろの文面（Markdown のまま） */
  text: string;
  /** text を inline の Markdown として HTML 化したもの */
  html: string;
  /** メモ行（字下げした続き）。先頭の箇条書き記号は落とす */
  notes: string[];
  notesHtml: string[];
  heading: string;
  parentId: string | null;
  depth: number;
  docs: TodoDoc[];
  refs: TodoRef[];
  inbound: TodoInbound[];
  children: TodoNode[];
  /** 子孫の数（自分を除く） */
  total: number;
  /** 子孫のうち完了の数 */
  done: number;
}

export interface TodoSection {
  heading: string;
  level: number;
  tasks: TodoNode[];
}

export interface TodoTree {
  sections: TodoSection[];
  /** タスクの総数 */
  count: number;
  /** 状態ごとの数 */
  states: Record<TodoState, number>;
}

export interface ParseTodoOptions {
  /** 解釈している Markdown の root 相対パス。相対リンクの起点になる */
  mdPath?: string;
  /** root 相対パスのファイルが実在するか */
  exists?: (relPath: string) => boolean;
  /** inline の Markdown を HTML にする（marked.parseInline 等）。無ければエスケープだけ */
  inline?: (markdown: string) => string;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const TASK_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+\[(.)\]\s*(.*)$/;
const BULLET_RE = /^(?:[-*+]|\d+[.)])\s+/;
const FENCE_RE = /^\s*(```|~~~)/;
const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** 関係行のラベル。行頭にこれと `:` があるときだけ関係として読む。 */
const RELATION_LABELS: Array<[RegExp, RelationKind]> = [
  [/^(?:依存|依存先|depends(?:\s+on)?|blocked(?:\s+by)?)$/i, 'depends'],
  [/^(?:派生元|derived(?:\s+from)?|from)$/i, 'derived'],
  [/^(?:関連|関連プラン|関連仕様|プラン|仕様|related|see)$/i, 'related'],
];
const RELATION_LINE_RE = /^([^:：]{1,20}?)\s*[:：]\s*(.+)$/;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * タスク id。**本文から作る**（行番号だと項目が増減しただけでずれる）。
 * 同じ文面が別の見出し・別の親の下にあっても別物になるよう、親までの道を混ぜる。
 * `tools/vibeboard-tasks` 側と同じ作りにしてあり、同じタスクは同じ id になる。
 */
function taskId(heading: string, parentTexts: string[], text: string): string {
  const key = [heading, ...parentTexts, text].join(' / ');
  return createHash('sha1').update(key).digest('hex').slice(0, 8);
}

function stateOf(mark: string): TodoState {
  if (mark === 'x' || mark === 'X') return 'done';
  if (mark === '~') return 'active';
  if (mark === '-') return 'cancelled';
  return 'open';
}

function indentWidth(ws: string): number {
  return ws.replace(/\t/g, '  ').length;
}

/** 参照の照合に使う形。リンクは文字列に、コードは中身に、空白は 1 つに潰して小文字にする。 */
function normalizeText(s: string): string {
  return s
    .replace(LINK_RE, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_~]+/g, '')
    .replace(/[「」『』"'“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** href を root 相対パスにする。root の外・外部 URL なら null。 */
export function resolveDocPath(href: string, mdPath: string): string | null {
  if (!href || EXTERNAL_RE.test(href)) return null;
  let p = href;
  const cut = Math.min(...[p.indexOf('#'), p.indexOf('?')].filter(i => i >= 0));
  if (Number.isFinite(cut)) p = p.slice(0, cut);
  if (!p) return null;
  if (p.startsWith('/')) return null;
  const dir = path.posix.dirname(mdPath.split(path.sep).join('/'));
  const joined = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, p));
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) return null;
  return joined;
}

function looksLikePath(s: string): boolean {
  return /^[^\s「」]+\.(?:md|markdown|html?|txt|json|ya?ml|csv)$/i.test(s) || /^[^\s「」]+\/[^\s「」]+$/.test(s);
}

interface RelationLine {
  kind: RelationKind;
  /** Markdown リンク */
  links: Array<{ label: string; href: string }>;
  /** 裸のパス */
  paths: string[];
  /** タスクの文面 */
  targets: string[];
}

/** メモ行が関係行なら分解する。違えば null。 */
export function parseRelationLine(note: string): RelationLine | null {
  const m = RELATION_LINE_RE.exec(note.trim());
  if (!m) return null;
  const label = m[1].trim();
  let kind: RelationKind | null = null;
  for (const [re, k] of RELATION_LABELS) {
    if (re.test(label)) {
      kind = k;
      break;
    }
  }
  if (!kind) return null;

  const links: Array<{ label: string; href: string }> = [];
  let rest = m[2].replace(LINK_RE, (_all, text: string, href: string) => {
    links.push({ label: text, href });
    return ' ';
  });
  const targets: string[] = [];
  rest = rest.replace(/「([^」]+)」/g, (_all, t: string) => {
    targets.push(t.trim());
    return ' ';
  });
  // 「」やリンクで相手を示してあれば、残りの文字（「と」「の前に」など）は相手として読まない
  const explicit = targets.length > 0 || links.length > 0;
  const paths: string[] = [];
  const pieces = rest
    .replace(/`([^`]*)`/g, '$1')
    .split(/[、,]/)
    .map(s => s.trim())
    .filter(s => s && !/^[/／・]$/.test(s));
  for (const piece of pieces) {
    if (looksLikePath(piece)) paths.push(piece);
    else if (!explicit) targets.push(piece);
  }
  return { kind, links, paths, targets };
}

/** 文面で相手のタスクを引く。完全一致 → 先頭一致 → 部分一致の順で、1 件に絞れたときだけ返す。 */
function findTask(
  target: string,
  all: TodoNode[],
  self: TodoNode,
): { node: TodoNode | null; ambiguous: boolean } {
  const key = normalizeText(target);
  if (!key) return { node: null, ambiguous: false };
  const candidates = all.filter(n => n !== self);
  const pick = (matches: TodoNode[]): TodoNode | null => {
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) return null;
    // 複数あれば兄弟 → 同じ見出し の順で絞る
    const siblings = matches.filter(n => n.parentId === self.parentId);
    if (siblings.length === 1) return siblings[0];
    const same = matches.filter(n => n.heading === self.heading);
    if (same.length === 1) return same[0];
    return null;
  };
  const exact = candidates.filter(n => normalizeText(n.text) === key);
  if (exact.length > 0) {
    const node = pick(exact);
    return { node, ambiguous: !node };
  }
  const prefix = candidates.filter(n => normalizeText(n.text).startsWith(key));
  if (prefix.length > 0) {
    const node = pick(prefix);
    return { node, ambiguous: !node };
  }
  const partial = candidates.filter(n => normalizeText(n.text).includes(key));
  if (partial.length > 0) {
    const node = pick(partial);
    return { node, ambiguous: !node };
  }
  return { node: null, ambiguous: false };
}

export function parseTodo(markdown: string, options: ParseTodoOptions = {}): TodoTree {
  const mdPath = options.mdPath || 'TODO.md';
  const exists = options.exists || (() => false);
  const inline = options.inline || escapeHtml;

  const lines = String(markdown).split(/\r?\n/);
  const sections: TodoSection[] = [];
  const all: TodoNode[] = [];
  const byId = new Set<string>();
  // 開いている親の連なり。字下げ幅の比較だけで深さを決める（幅は文書ごとにまちまち）
  const stack: Array<{ indent: number; node: TodoNode }> = [];
  let heading = '';
  let level = 0;
  let inFence = false;
  let afterBlank = true;

  const currentSection = (): TodoSection => {
    let s = sections[sections.length - 1];
    if (!s || s.heading !== heading || s.level !== level) {
      s = { heading, level, tasks: [] };
      sections.push(s);
    }
    return s;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (!line.trim()) {
      afterBlank = true;
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      heading = headingMatch[2].trim();
      level = headingMatch[1].length;
      stack.length = 0;
      afterBlank = true;
      continue;
    }

    const match = TASK_RE.exec(line);
    if (!match) {
      // タスクの続き（メモ）。**行の字下げで持ち主を決める**（直前のタスクに付けると、
      // より深い子の後ろに書かれた続きが子のものになる）。
      // 空行のあとの字下げなしの行は、リストの外の段落なので誰のものでもない
      const width = indentWidth(line.match(/^\s*/)![0]);
      if (afterBlank && width === 0) {
        stack.length = 0;
        continue;
      }
      afterBlank = false;
      const text = line.trim().replace(BULLET_RE, '');
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s].indent <= width) {
          stack[s].node.notes.push(text);
          break;
        }
      }
      continue;
    }

    afterBlank = false;
    const indent = indentWidth(match[1]);
    const mark = match[2];
    const text = match[3].trim();

    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1].node : null;
    const parentTexts = stack.map(s => s.node.text);

    const node: TodoNode = {
      id: taskId(heading, parentTexts, text),
      line: i + 1,
      mark,
      state: stateOf(mark),
      text,
      html: '',
      notes: [],
      notesHtml: [],
      heading,
      parentId: parent ? parent.id : null,
      depth: stack.length,
      docs: [],
      refs: [],
      inbound: [],
      children: [],
      total: 0,
      done: 0,
    };
    // 万一 id がぶつかったら（同じ見出し・同じ親・同じ文面）後から来たほうを捨てない
    if (byId.has(node.id)) node.id = taskId(heading, parentTexts, `${text} #${all.length}`);
    byId.add(node.id);

    if (parent) parent.children.push(node);
    else currentSection().tasks.push(node);
    all.push(node);
    stack.push({ indent, node });
  }

  // 関係を取り出す（全タスクが揃ってから。参照先が後ろに書かれていてもよいように）
  const docOf = (
    label: string,
    href: string,
    source: TodoDoc['source'],
    kind: RelationKind | null,
  ): TodoDoc => {
    const p = resolveDocPath(href, mdPath);
    return {
      label: label || path.posix.basename(href),
      href,
      path: p,
      exists: p !== null && exists(p),
      source,
      kind,
    };
  };
  const collectLinks = (s: string): Array<{ label: string; href: string }> => {
    const out: Array<{ label: string; href: string }> = [];
    for (const m of s.matchAll(LINK_RE)) out.push({ label: m[1], href: m[2] });
    return out;
  };

  for (const node of all) {
    node.html = inline(node.text);
    node.notesHtml = node.notes.map(n => inline(n));
    for (const l of collectLinks(node.text)) {
      if (!EXTERNAL_RE.test(l.href)) node.docs.push(docOf(l.label, l.href, 'text', null));
    }
    for (const note of node.notes) {
      const rel = parseRelationLine(note);
      if (!rel) {
        for (const l of collectLinks(note)) {
          if (!EXTERNAL_RE.test(l.href)) node.docs.push(docOf(l.label, l.href, 'note', null));
        }
        continue;
      }
      for (const l of rel.links) node.docs.push(docOf(l.label, l.href, 'relation', rel.kind));
      for (const p of rel.paths) node.docs.push(docOf('', p, 'relation', rel.kind));
      for (const t of rel.targets) {
        const found = findTask(t, all, node);
        node.refs.push({
          kind: rel.kind,
          text: t,
          taskId: found.node ? found.node.id : null,
          ambiguous: found.ambiguous,
        });
        if (found.node) found.node.inbound.push({ kind: rel.kind, taskId: node.id });
      }
    }
  }

  // 子孫の数
  const count = (n: TodoNode): { total: number; done: number } => {
    let total = 0;
    let done = 0;
    for (const c of n.children) {
      const sub = count(c);
      total += 1 + sub.total;
      done += (c.state === 'done' ? 1 : 0) + sub.done;
    }
    n.total = total;
    n.done = done;
    return { total, done };
  };
  for (const s of sections) for (const t of s.tasks) count(t);

  const states: Record<TodoState, number> = { open: 0, done: 0, active: 0, cancelled: 0 };
  for (const n of all) states[n.state] += 1;

  return { sections: sections.filter(s => s.tasks.length > 0), count: all.length, states };
}

/** 本文に `- [ ]` の行が 1 つでもあるか（ツリーを出すかどうかの判定）。 */
export function hasTaskLines(markdown: string): boolean {
  return /^\s*(?:[-*+]|\d+[.)])\s+\[.\]/m.test(String(markdown));
}

// === Tasks タブ向け: prompt の組み立てと削除（純関数。ファイルもプロセスも触らない） ===
//
// Tasks タブは TODO.md のタスクを、待ち受けている Claude Code の画面へ渡して実行させる。
// **クライアントから来るのは id と決め打ちの値だけ**で、文面はここで木から組む
// （文面をブラウザから渡させない）。削除も id だけを受け、対象の部分木の行だけを外す。

export interface TaskContext {
  node: TodoNode;
  /** 根からその親までの文面（浅い順）。子項目だけ渡すと何の話か分からないので文脈に添える */
  parentTexts: string[];
}

/** 木を上から順に平らに並べる（サイドバーの並び順そのもの）。 */
export function flattenTodo(tree: TodoTree): TodoNode[] {
  const out: TodoNode[] = [];
  const walk = (nodes: TodoNode[]) => {
    for (const n of nodes) {
      out.push(n);
      walk(n.children);
    }
  };
  for (const s of tree.sections) walk(s.tasks);
  return out;
}

function findIn(nodes: TodoNode[], id: string, parents: string[]): TaskContext | null {
  for (const n of nodes) {
    if (n.id === id) return { node: n, parentTexts: parents };
    const deeper = findIn(n.children, id, [...parents, n.text]);
    if (deeper) return deeper;
  }
  return null;
}

/** id のタスクと、親の文面の列。無ければ null。 */
export function findTaskById(tree: TodoTree, id: string): TaskContext | null {
  for (const s of tree.sections) {
    const found = findIn(s.tasks, id, []);
    if (found) return found;
  }
  return null;
}

/** そのタスクと子孫を、元の見た目のまま組み直す（メモ行も含める）。 */
export function renderSubtree(node: TodoNode): string {
  const base = node.depth;
  const lines: string[] = [];
  const walk = (n: TodoNode) => {
    const pad = '  '.repeat(n.depth - base);
    lines.push(`${pad}- [${n.mark}] ${n.text}`);
    for (const note of n.notes) lines.push(`${pad}  ${note}`);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return lines.join('\n');
}

function taskBody(ctx: TaskContext, lead: string): string[] {
  const parts = [lead, ''];
  if (ctx.node.heading) parts.push(`## ${ctx.node.heading}`, '');
  if (ctx.parentTexts.length > 0) {
    parts.push('親タスク:');
    ctx.parentTexts.forEach((t, i) => parts.push(`${'  '.repeat(i)}- ${t}`));
    parts.push('');
  }
  parts.push('対象のタスク:', renderSubtree(ctx.node), '');
  return parts;
}

/**
 * 「実行」の prompt。タスクをこなし、終わったら DONE.md へ移させる。
 * DONE.md へ移すのは**選択肢にしない**（済んだ項目が TODO.md に残るのはただの取りこぼし）。
 */
export function buildPrompt(tree: TodoTree, id: string): string | null {
  const ctx = findTaskById(tree, id);
  if (!ctx) return null;
  const parts = taskBody(ctx, 'このプロジェクトの TODO.md にある次のタスクに取り組んでください。');
  parts.push('進め方はこのプロジェクトの CLAUDE.md に従ってください。');
  parts.push('終わったら TODO.md から該当項目を消し、DONE.md に記録してください。');
  return parts.join('\n');
}

/** 「説明」の prompt。実行させず、意図・進め方・影響を説明させるだけ。ファイルは何も変えさせない。 */
export function buildExplainPrompt(tree: TodoTree, id: string): string | null {
  const ctx = findTaskById(tree, id);
  if (!ctx) return null;
  const parts = taskBody(ctx, 'このプロジェクトの TODO.md にある次のタスクを説明してください。');
  parts.push('このタスクの意図・進め方・影響する範囲を説明してください。');
  parts.push('**コードも TODO.md も変更しないでください（説明だけ）。**');
  return parts.join('\n');
}

/**
 * 「プラン作成」の prompt。プランファイルと TODO.md のリンク・子タスクだけを作らせ、実装には入らせない。
 * 作業着手ルール（プラン → TODO.md にリンク → Phase / Step を子タスクに）を、このタスクに当てはめた形。
 */
export function buildPlanPrompt(tree: TodoTree, id: string): string | null {
  const ctx = findTaskById(tree, id);
  if (!ctx) return null;
  const parts = taskBody(ctx, 'このプロジェクトの TODO.md にある次のタスクのプランを作ってください。');
  parts.push('やること:');
  parts.push('1. `docs/plans/<task-name>.md` にプランファイルを作る（目的・背景、対応方針、影響範囲、テスト方針。Phase / Step に分かれるならファイル内でも明示する）');
  parts.push('2. TODO.md のこのタスクにプランファイルへのリンクを付ける（例: `[plan](docs/plans/<task-name>.md)`）');
  parts.push('3. Phase / Step があれば、このタスクの子タスク（字下げした `- [ ]`）として TODO.md に足す');
  parts.push('');
  parts.push('**プランを作るだけで、実装には着手しないでください。** TODO.md の変更はリンクと子タスクの追加だけにし、DONE.md には移さないでください。');
  parts.push('プランの書き方にこのプロジェクトの CLAUDE.md の決まりがあれば、それに従ってください。');
  return parts.join('\n');
}

/**
 * 「commit & push」の prompt。作業ツリーの変更をコミットして push させる。**タスクには紐づかない**（プロジェクト全体の操作）。
 * vibeboard 自身は git を叩かない（メッセージ・TODO.md の整理・秘密の除外は、セッションの判断と承認の中でやらせる）。
 */
export function buildCommitPrompt(): string {
  return [
    'このプロジェクトの作業ツリーの変更をコミットして push してください。',
    '',
    'やること:',
    '1. `git status` と `git diff` で変更を確かめる。まとまりの違う変更が混ざっていれば、分けるか 1 つにするかを判断して、その理由を書き残す',
    '2. TODO.md を確認し、済んだタスクがあれば DONE.md へ移してからコミットに含める',
    '3. 変更内容から要点をまとめたコミットメッセージを書き、コミットして push する',
    '4. 秘密（.env・資格情報・トークン）や管理外にすべきファイルは含めない',
    '',
    'ブランチや push 先の決まりがこのプロジェクトの CLAUDE.md にあれば、それに従ってください。',
  ].join('\n');
}

/** 「追加の指示」の上限。これより長ければサーバが断る（画面側も maxlength で止める） */
export const NOTE_MAX = 4000;

/**
 * 画面から来た「追加の指示」を丸める。改行とタブは残し、他の制御文字は落として前後の空白を削る。
 * **文面を組むのはサーバのまま**で、ここを通ったものだけが prompt の末尾に入る（`appendNote`）。
 */
export function sanitizeNote(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')
    .split('')
    .filter(c => {
      const k = c.charCodeAt(0);
      return c === '\n' || c === '\t' || (k >= 0x20 && k !== 0x7f);
    })
    .join('')
    .trim();
}

/**
 * prompt の末尾に「追加の指示」を足す。空なら**今までと同じ文面のまま**返す。
 * 実行の文面は「終わったら DONE.md へ」で終わるので、食い違ったときにどちらを採るかも書いておく。
 */
export function appendNote(prompt: string, note: string): string {
  const body = sanitizeNote(note);
  if (!body) return prompt;
  return [
    prompt,
    '',
    '追加の指示:',
    body,
    '',
    'この追加の指示が上の内容と食い違うときは、追加の指示を優先してください。',
  ].join('\n');
}

function leadWidth(line: string): number {
  return indentWidth((line.match(/^\s*/) as RegExpMatchArray)[0]);
}

/**
 * ノード（＝その部分木）が占める元テキストの行範囲 [start, end)（0 始まり）。
 * 判定は字下げ: そのノードより深いタスク行と、幅がノード以上のメモ行と、間の空行が範囲。
 * 兄弟以下のタスク・見出し・浅いメモ行で止まる。末尾の空行は含めない。
 * メモ行の持ち主は parseTodo と同じ規則（幅がノード以上なら node かその子孫のもの）。
 */
function nodeSpan(lines: string[], node: TodoNode): { start: number; end: number } {
  const start = node.line - 1;
  const head = lines[start] ?? '';
  const m0 = TASK_RE.exec(head);
  const ni = m0 ? indentWidth(m0[1]) : leadWidth(head);
  let last = start;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (HEADING_RE.test(line)) break;
    const m = TASK_RE.exec(line);
    if (m) {
      if (indentWidth(m[1]) <= ni) break;
      last = i;
      continue;
    }
    if (leadWidth(line) < ni) break;
    last = i;
  }
  return { start, end: last + 1 };
}

/**
 * TODO.md のテキストから、そのタスク（部分木）だけを外して返す。見つからなければ null。
 * 消すのは対象の行・付随するメモ行・子孫のタスクだけ。兄弟や他の節・前後の行は残す。
 * 改行コードは元のまま。前後が空行なら二重空行を避けて手前の空行を 1 つ落とす。
 */
export function removeTask(markdown: string, id: string): string | null {
  const src = String(markdown);
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const ctx = findTaskById(parseTodo(src), id);
  if (!ctx) return null;
  const { start, end } = nodeSpan(lines, ctx.node);
  let from = start;
  const beforeBlank = from > 0 && lines[from - 1].trim() === '';
  const afterBlank = end >= lines.length || lines[end].trim() === '';
  if (beforeBlank && afterBlank) from -= 1;
  return [...lines.slice(0, from), ...lines.slice(end)].join(eol);
}
