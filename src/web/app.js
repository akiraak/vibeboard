'use strict';

// 編集対象タブ（TODO 系）の URL スラッグ。表示ラベルは設定可能だがスラッグは固定。
const EDITABLE_TAB = 'todo';
// プロジェクト内の全ファイルを開くタブ。こちらもスラッグは固定。
const FILES_TAB = 'files';

// サーバから注入された設定。`__VIBEBOARD__` には categories / editable も含まれる。
const VB_CONFIG = (typeof window !== 'undefined' && window.__VIBEBOARD__) || {};
const CATEGORY_DEFS = Array.isArray(VB_CONFIG.categories) && VB_CONFIG.categories.length > 0
  ? VB_CONFIG.categories
  : [
      { name: 'plans', label: 'Plans', archive: true },
      { name: 'specs', label: 'Specs', archive: false },
    ];
const CATEGORY_BY_NAME = new Map(CATEGORY_DEFS.map(c => [c.name, c]));
const EDITABLE_LABEL = (VB_CONFIG.editable && VB_CONFIG.editable.label) || 'Root';
const EDITABLE_FILES = (VB_CONFIG.editable && Array.isArray(VB_CONFIG.editable.files) && VB_CONFIG.editable.files.length > 0)
  ? VB_CONFIG.editable.files
  : [{ name: 'TODO.md', label: 'TODO' }, { name: 'DONE.md', label: 'DONE' }, { name: 'CLAUDE.md', label: 'CLAUDE' }, { name: 'README.md', label: 'README' }];
const EDITABLE_NAMES = EDITABLE_FILES.map(f => f.name);
const EDITABLE_BY_NAME = new Map(EDITABLE_FILES.map(f => [f.name, f]));
// customTabs はサーバ側で正規化済み（name/label/baseUrl）。未指定なら空配列。
const CUSTOM_TABS = Array.isArray(VB_CONFIG.customTabs) ? VB_CONFIG.customTabs : [];
const CUSTOM_TAB_BY_NAME = new Map(CUSTOM_TABS.map(t => [t.name, t]));
const FILES_LABEL = (VB_CONFIG.files && VB_CONFIG.files.label) || 'Files';
const CATEGORIES = [
  EDITABLE_TAB,
  FILES_TAB,
  ...CATEGORY_DEFS.map(c => c.name),
  ...CUSTOM_TABS.map(t => t.name),
];

const STORAGE_CATEGORY = 'vibeboard.activeCategory';
const STORAGE_EXPANDED = 'vibeboard.expanded';
const STORAGE_SIDEBAR_COLLAPSED = 'vibeboard.sidebarCollapsed';
const STORAGE_SORT = 'vibeboard.sort';

// ソート状態: { key: 'mtime'|'name', mtimeDir: 'asc'|'desc', nameDir: 'asc'|'desc' }
// 各キーの方向は独立に記憶する（キー切替時に直前の向きを復元）
const SORT_KEYS = ['mtime', 'name'];
const SORT_DIRS = ['asc', 'desc'];
const DEFAULT_SORT_STATE = { key: 'mtime', mtimeDir: 'desc', nameDir: 'asc' };

const sidebarNav = document.getElementById('sidebar-nav');
const sidebarSort = document.getElementById('sidebar-sort');
const contentArea = document.getElementById('content-area');
const pageTitle = document.getElementById('page-title');
const topbarSub = document.getElementById('topbar-sub');
const topbarTabs = document.getElementById('topbar-tabs');

let docsTree = Object.fromEntries([
  ...CATEGORY_DEFS.map(c => [c.name, { files: [], dirs: [] }]),
  [FILES_TAB, { files: [], dirs: [] }],
]);
// デフォルトは最初のドキュメントカテゴリ（無ければ編集タブ）
let activeCategory = CATEGORY_DEFS.length > 0 ? CATEGORY_DEFS[0].name : EDITABLE_TAB;
let expanded = {};
// カテゴリごとのソート設定（'mtime-desc' | 'name-asc'）。loadPersisted で復元する
let sortByCategory = {};

// 現在開いている編集対象（openDoc で更新）。
// Root タブ / カテゴリ / この先の Files タブを 1 つの状態で扱う。
// **API を引くのは path（root 相対）1 本**で、key は hash とサイドバー上の識別子。
const docState = {
  tab: null,           // EDITABLE_TAB | カテゴリ名
  key: null,           // hash 上の識別子（Root: 'TODO.md' / カテゴリ: 'sub/foo.md'）
  path: null,          // root 相対パス（例 'docs/plans/foo.md'）
  mode: 'preview',     // 'preview' | 'edit'
  content: '',         // textarea 上の現在値
  savedContent: '',    // 直近に取得/保存した内容（isDirty 判定用）
  mtime: 0,            // 楽観ロック用 baseMtime
  eol: 'lf',           // 保存時に復元する改行コード（textarea は LF に潰すため必須）
  readOnly: false,     // バイナリ / サイズ超過 / シンボリックリンク
  readOnlyReason: null,
  conflict: null,      // { mtime: number, barVisible: boolean } | null
};

// SSE 接続状態。監視対象は「今開いているファイル」1 本で、開くたびに張り替える。
const sseState = {
  source: null,
  connected: false,
  watchPath: null,     // 現在サーバへ伝えている root 相対パス（null = 監視なし）
  reconnecting: false, // 意図的な張り替え中。「切断中」を出さないための印
};

// customTabs 用の状態。サイドバー結果をキャッシュ / SSE を 1 タブだけアクティブに保つ。
const customTabState = {
  // name -> { items: array, error: string | null }
  cache: new Map(),
  // 現在開いているプラグイン SSE。タブ切替時に必ず close する
  source: null,
  sourceName: null,
  // 現在右ペインに表示している iframe（item-changed で reload するため）
  iframe: null,
  iframeName: null,
  iframeItemId: null,
};

// 現在表示中ドキュメントの TOC アクティブ追従用 IntersectionObserver。
// openDoc / 他カテゴリ表示への切替前に必ず disconnect する。
let activeTocObserver = null;

// 自分の保存による mtime を一時記録（SSE で戻ってきたとき外部変更として扱わないため）
const selfWrittenMtimes = new Set();
let saveInFlight = false;

const TITLE_BASE = (typeof VB_CONFIG.title === 'string' && VB_CONFIG.title) || 'vibeboard';

function isDocDirty() {
  if (docState.readOnly) return false;
  return docState.content !== docState.savedContent;
}

// tab + key から root 相対パスを組む。API はこれで引く。
function docPathFor(tab, key) {
  if (!key) return null;
  // Files タブの key は既に root 相対パスそのもの
  if (tab === FILES_TAB) return key;
  if (tab === EDITABLE_TAB) {
    const f = EDITABLE_BY_NAME.get(key);
    if (!f) return null;
    return typeof f.path === 'string' && f.path ? f.path : key;
  }
  const cat = CATEGORY_BY_NAME.get(tab);
  if (!cat) return null;
  const base = typeof cat.path === 'string' ? cat.path : `docs/${tab}`;
  return base ? `${base}/${key}` : key;
}

function sourceUrl(path) {
  return `/api/source/${encodePath(path)}`;
}

function renderUrl(path) {
  return `/api/render/${encodePath(path)}`;
}

// 拡張子が .md のときだけプレビューを出せる
function isMarkdownPath(path) {
  return typeof path === 'string' && /\.md$/i.test(path);
}

function formatMtime(mtime) {
  if (typeof mtime !== 'number' || !mtime) return '';
  const dt = new Date(mtime);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  const ss = String(dt.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function loadPersisted() {
  const cat = localStorage.getItem(STORAGE_CATEGORY);
  if (cat && CATEGORIES.includes(cat)) activeCategory = cat;
  try {
    const raw = localStorage.getItem(STORAGE_EXPANDED);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') expanded = parsed;
  } catch {
    expanded = {};
  }
  try {
    const raw = localStorage.getItem(STORAGE_SORT);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        const normalized = normalizeSortState(v);
        if (normalized) sortByCategory[k] = normalized;
      }
    }
  } catch {
    sortByCategory = {};
  }
}

// 任意入力（旧フォーマット文字列含む）を新フォーマットに正規化。不正なら null
function normalizeSortState(v) {
  if (!v) return null;
  if (typeof v === 'object') {
    const key = SORT_KEYS.includes(v.key) ? v.key : DEFAULT_SORT_STATE.key;
    const mtimeDir = SORT_DIRS.includes(v.mtimeDir) ? v.mtimeDir : DEFAULT_SORT_STATE.mtimeDir;
    const nameDir = SORT_DIRS.includes(v.nameDir) ? v.nameDir : DEFAULT_SORT_STATE.nameDir;
    return { key, mtimeDir, nameDir };
  }
  return null;
}

function saveActiveCategory() {
  localStorage.setItem(STORAGE_CATEGORY, activeCategory);
}

function saveExpanded() {
  localStorage.setItem(STORAGE_EXPANDED, JSON.stringify(expanded));
}

function saveSortByCategory() {
  localStorage.setItem(STORAGE_SORT, JSON.stringify(sortByCategory));
}

function getSortState(category) {
  if (sortByCategory[category]) return sortByCategory[category];
  // Files タブはファイルブラウザなので名前昇順を既定にする
  if (category === FILES_TAB) return { key: 'name', mtimeDir: 'desc', nameDir: 'asc' };
  return { ...DEFAULT_SORT_STATE };
}

function getDirForKey(state, key) {
  return key === 'name' ? state.nameDir : state.mtimeDir;
}

async function fetchJson(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || '読み込みに失敗しました');
  return json.data;
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

function decodePath(p) {
  return p.split('/').map(decodeURIComponent).join('/');
}

// 本文 (.md-content) 内の相対 .md / .html リンクのクリックを SPA の hash 遷移へ変換する。
// 元の Markdown は無編集のまま（GitHub / VSCode プレビューの相対リンクを壊さない）。
// 画像・音声等のメディアはサーバ側で /files に書き換え済みなのでここでは扱わない。
// カテゴリのルートは docs/<category> を前提（vibeboard 既定構成）。クロスカテゴリの
// 相対リンク（例 plans → ../../specs/...）も docs ルートからの正規化で解決する。
// .md#section の section アンカーは SPA 未対応のため落として doc 先頭へ遷移する。
function resolveDocLinkHash(href) {
  if (!href) return null;
  // 絶対 URL / data / mailto / tel / ページ内アンカー / 既に / 始まりは対象外
  if (/^(https?:)?\/\/|^data:|^mailto:|^tel:|^#|^\//i.test(href)) return null;
  // フラグメント / クエリを除去してパス本体を取り出す
  let pathPart = href;
  const hashIdx = href.indexOf('#');
  const qIdx = href.indexOf('?');
  let cut = -1;
  if (hashIdx !== -1) cut = hashIdx;
  if (qIdx !== -1 && (cut === -1 || qIdx < cut)) cut = qIdx;
  if (cut !== -1) pathPart = href.slice(0, cut);
  if (!pathPart || !/\.(md|html)$/i.test(pathPart)) return null;

  const cur = parseHash();
  if (!cur || cur.category === EDITABLE_TAB) return null;

  // 現在ドキュメントの docs ルート相対パスから dirname を取り、相対解決する
  const curFull = `docs/${cur.category}/${cur.filePath}`;
  const segs = curFull.split('/').slice(0, -1); // dirname
  for (const part of pathPart.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (segs.length) segs.pop(); continue; }
    segs.push(part);
  }
  const resolved = segs.join('/');
  const m = resolved.match(/^docs\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const newCat = m[1];
  const newPath = m[2];
  if (!CATEGORIES.includes(newCat) || newCat === EDITABLE_TAB) return null;
  return `#${newCat}/${encodePath(newPath)}`;
}

// contentArea（安定コンテナ。子は描画ごとに差し替え）に委譲クリックを 1 度だけ張る。
function setupDocLinkInterception() {
  contentArea.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a');
    if (!a || !contentArea.contains(a)) return;
    const targetHash = resolveDocLinkHash(a.getAttribute('href'));
    if (!targetHash) return;
    e.preventDefault();
    if (location.hash === targetHash) handleRoute();
    else location.hash = targetHash;
  });
}

// ディレクトリとファイルを 1 列にマージし、state.key / 対応する方向でソートする
function mergeAndSort(dirs, files, state) {
  const items = [
    ...dirs.map(d => ({ kind: 'dir', data: d })),
    ...files.map(f => ({ kind: 'file', data: f })),
  ];
  const dir = getDirForKey(state, state.key);
  const cmpAsc = state.key === 'name'
    ? (a, b) => a.data.name.localeCompare(b.data.name, 'ja')
    : (a, b) => (a.data.mtime || 0) - (b.data.mtime || 0);
  items.sort((a, b) => {
    const v = cmpAsc(a, b);
    return dir === 'desc' ? -v : v;
  });
  return items;
}

function renderTabs() {
  topbarTabs.querySelectorAll('.topbar-tab').forEach(tab => {
    const isActive = tab.dataset.category === activeCategory;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
}

function renderFileItem(category, file, depth) {
  const a = document.createElement('a');
  a.className = 'nav-item';
  a.href = `#${category}/${encodePath(file.path)}`;
  a.dataset.category = category;
  a.dataset.path = file.path;
  if (depth > 0) a.style.marginLeft = `${depth * 22}px`;

  const title = document.createElement('div');
  title.textContent = file.title;
  a.appendChild(title);

  // タイトルがファイル名そのものなら 2 行目は出さない（Files タブは常にこちら）
  if (file.title !== file.name) {
    const fileName = document.createElement('div');
    fileName.className = 'nav-item-file';
    fileName.textContent = file.name;
    a.appendChild(fileName);
  }

  return a;
}

function renderDir(category, dir, parentPath, depth) {
  const dirPath = parentPath ? `${parentPath}/${dir.name}` : dir.name;
  const expandKey = `${category}/${dirPath}`;
  const isExpanded = !!expanded[expandKey];

  const block = document.createElement('div');
  block.className = 'nav-dir-block';

  const header = document.createElement('div');
  header.className = 'nav-dir' + (isExpanded ? ' expanded' : '');
  if (depth > 0) header.style.marginLeft = `${depth * 22}px`;
  header.dataset.expandKey = expandKey;

  const toggle = document.createElement('span');
  toggle.className = 'nav-dir-toggle';
  toggle.textContent = isExpanded ? '▼' : '▶';
  header.appendChild(toggle);

  // タイトル（README.md）を 1 行目、ディレクトリ名を 2 行目に縦積みで表示する。
  // 見切れ防止のため横並びにはせず折り返す。
  const labelWrap = document.createElement('span');
  labelWrap.className = 'nav-dir-label';

  if (dir.title && dir.title !== dir.name) {
    const title = document.createElement('span');
    title.className = 'nav-dir-title';
    title.textContent = dir.title;
    labelWrap.appendChild(title);
  }

  const name = document.createElement('span');
  name.className = 'nav-dir-name';
  name.textContent = dir.name;
  labelWrap.appendChild(name);

  header.appendChild(labelWrap);

  // archive=true のカテゴリ直下のディレクトリ（archive 本体は除く）にアーカイブボタンを付ける
  const catDef = CATEGORY_BY_NAME.get(category);
  if (catDef && catDef.archive && depth === 0 && dir.name !== 'archive') {
    const archiveBtn = document.createElement('button');
    archiveBtn.type = 'button';
    archiveBtn.className = 'nav-dir-archive';
    archiveBtn.title = 'アーカイブする';
    archiveBtn.setAttribute('aria-label', `${dir.name} をアーカイブ`);
    archiveBtn.textContent = '📦';
    archiveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      archiveDirectory(category, dir.name);
    });
    header.appendChild(archiveBtn);
  }

  header.addEventListener('click', () => {
    expanded[expandKey] = !expanded[expandKey];
    saveExpanded();
    renderSidebar();
  });

  block.appendChild(header);

  if (isExpanded) {
    const children = document.createElement('div');
    children.className = 'nav-dir-children';
    const sortState = getSortState(category);
    for (const item of mergeAndSort(dir.dirs, dir.files, sortState)) {
      if (item.kind === 'dir') {
        children.appendChild(renderDir(category, item.data, dirPath, depth + 1));
      } else {
        children.appendChild(renderFileItem(category, item.data, depth + 1));
      }
    }
    block.appendChild(children);
  }

  return block;
}

function renderTodoSidebar() {
  sidebarNav.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const f of EDITABLE_FILES) {
    const a = document.createElement('a');
    a.className = 'nav-item';
    a.href = `#${EDITABLE_TAB}/${encodeURIComponent(f.name)}`;
    a.dataset.category = EDITABLE_TAB;
    a.dataset.path = f.name;

    const title = document.createElement('div');
    title.textContent = f.label;
    a.appendChild(title);

    const fileName = document.createElement('div');
    fileName.className = 'nav-item-file';
    fileName.textContent = f.name;
    a.appendChild(fileName);

    frag.appendChild(a);
  }
  sidebarNav.appendChild(frag);
  refreshActiveHighlight();
  refreshSidebarConflictBadge();
}

// サイドバー上端のソート切替トグル。
// 通常カテゴリのときのみ表示し、TODO タブでは hidden にする。
// アクティブキーには ↑/↓ を併記。アクティブを再クリックすると方向を反転、
// 非アクティブをクリックするとそのキーの記憶済み方向で切替。
function renderSortControl() {
  if (!sidebarSort) return;
  if (activeCategory === EDITABLE_TAB) {
    sidebarSort.hidden = true;
    sidebarSort.innerHTML = '';
    return;
  }
  sidebarSort.hidden = false;
  sidebarSort.innerHTML = '';

  const state = getSortState(activeCategory);
  const options = [
    { key: 'mtime', label: '更新日' },
    { key: 'name', label: '名前' },
  ];
  const group = document.createElement('div');
  group.className = 'sidebar-sort-group';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', '並び順');
  for (const opt of options) {
    const isActive = state.key === opt.key;
    const dir = getDirForKey(state, opt.key);
    const arrow = isActive ? (dir === 'desc' ? ' ↓' : ' ↑') : '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sidebar-sort-btn' + (isActive ? ' active' : '');
    btn.textContent = opt.label + arrow;
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    btn.title = isActive
      ? (dir === 'desc' ? 'クリックで昇順に切替' : 'クリックで降順に切替')
      : `${opt.label}順に切替`;
    btn.addEventListener('click', () => {
      const cur = getSortState(activeCategory);
      const next = { ...cur };
      if (cur.key === opt.key) {
        // アクティブ再クリック → 方向反転
        const flipped = getDirForKey(cur, opt.key) === 'desc' ? 'asc' : 'desc';
        if (opt.key === 'name') next.nameDir = flipped;
        else next.mtimeDir = flipped;
      } else {
        // 非アクティブクリック → キー切替（方向はそのキーの記憶を維持）
        next.key = opt.key;
      }
      sortByCategory[activeCategory] = next;
      saveSortByCategory();
      renderSidebar();
    });
    group.appendChild(btn);
  }
  sidebarSort.appendChild(group);
}

function renderSidebar() {
  renderSortControl();

  if (activeCategory === EDITABLE_TAB) {
    renderTodoSidebar();
    return;
  }

  if (CUSTOM_TAB_BY_NAME.has(activeCategory)) {
    renderCustomTabSidebar(activeCategory);
    return;
  }

  const tree = docsTree[activeCategory] || { files: [], dirs: [] };
  sidebarNav.innerHTML = '';

  if (tree.files.length === 0 && tree.dirs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'loading-text';
    empty.textContent = activeCategory === FILES_TAB ? 'ファイルがありません' : 'ドキュメントがありません';
    sidebarNav.appendChild(empty);
    return;
  }

  // archive ディレクトリはツリーの一番下に出す（それ以外は選択ソートで混ぜて並べる）。
  // Files タブはただのファイル一覧なので archive を特別扱いしない。
  const isCategory = activeCategory !== FILES_TAB;
  const regularDirs = isCategory ? tree.dirs.filter(d => d.name !== 'archive') : tree.dirs;
  const archiveDirs = isCategory ? tree.dirs.filter(d => d.name === 'archive') : [];

  const sortState = getSortState(activeCategory);
  const frag = document.createDocumentFragment();
  for (const item of mergeAndSort(regularDirs, tree.files, sortState)) {
    if (item.kind === 'dir') {
      frag.appendChild(renderDir(activeCategory, item.data, '', 0));
    } else {
      frag.appendChild(renderFileItem(activeCategory, item.data, 0));
    }
  }
  for (const dir of archiveDirs) {
    frag.appendChild(renderDir(activeCategory, dir, '', 0));
  }
  sidebarNav.appendChild(frag);

  refreshActiveHighlight();
}

function refreshActiveHighlight() {
  const parsed = parseHash();
  sidebarNav.querySelectorAll('.nav-item').forEach(el => {
    const match = parsed
      && el.dataset.category === parsed.category
      && el.dataset.path === parsed.filePath;
    el.classList.toggle('active', !!match);
  });
}

function findFileMeta(category, filePath) {
  function walk(node) {
    for (const f of node.files) if (f.path === filePath) return f;
    for (const d of node.dirs) {
      const found = walk(d);
      if (found) return found;
    }
    return null;
  }
  const tree = docsTree[category];
  if (!tree) return null;
  return walk(tree);
}

function clearTocObserver() {
  if (activeTocObserver) {
    activeTocObserver.disconnect();
    activeTocObserver = null;
  }
}


// 見出しテキストから id 用 slug を生成する。日本語は \p{L} で残し、空白等はハイフンへ。
// used Set で重複時は -2, -3… を suffix にする
function slugifyHeading(text, used) {
  let base = String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[\s　]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '');
  if (!base) base = 'section';
  let slug = base;
  let n = 2;
  while (used.has(slug)) {
    slug = `${base}-${n}`;
    n++;
  }
  used.add(slug);
  return slug;
}

// .md-content 内の H2〜H4 から TOC を組み立てて tocEl に挿入する。
// H1 は topbar の page-title と重複するため除外、見出し 0〜1 件なら何もしない（CSS :empty で非表示）
function buildDocToc(mdContentEl, tocEl) {
  if (!mdContentEl || !tocEl) return;
  const headings = Array.from(mdContentEl.querySelectorAll('h2, h3, h4'));
  if (headings.length < 2) return;

  const used = new Set();
  headings.forEach((h) => { if (h.id) used.add(h.id); });
  headings.forEach((h) => {
    if (!h.id) h.id = slugifyHeading(h.textContent, used);
  });

  const list = document.createElement('ul');
  list.className = 'doc-toc-list';
  const linkById = new Map();
  headings.forEach((h) => {
    const level = parseInt(h.tagName.substring(1), 10);
    const li = document.createElement('li');
    li.className = `doc-toc-item doc-toc-item-h${level}`;
    const a = document.createElement('a');
    a.className = 'doc-toc-link';
    a.href = `#${encodeURIComponent(h.id)}`;
    a.dataset.targetId = h.id;
    a.textContent = h.textContent;
    // ルーティングは hash ベースなのでデフォルトのアンカー遷移は抑止し、直接スムーズスクロール
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById(h.id);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    li.appendChild(a);
    list.appendChild(li);
    linkById.set(h.id, a);
  });
  tocEl.appendChild(list);

  setupTocActiveTracking(headings, linkById);
}

// .main-content の縦スクロールに追従して active な TOC リンクを切り替える。
// IntersectionObserver の rootMargin で「上端付近の active zone」を作り、
// ゾーン内の最上位を、なければゾーン上に隠れた直近の見出しを active にする。
function setupTocActiveTracking(headings, linkById) {
  clearTocObserver();
  const root = document.querySelector('.main-content');
  if (!root || headings.length === 0) return;

  const visible = new Set();
  let activeId = null;

  const setActive = (id) => {
    if (id === activeId) return;
    if (activeId) {
      const prev = linkById.get(activeId);
      if (prev) prev.classList.remove('active');
    }
    if (id) {
      const next = linkById.get(id);
      if (next) next.classList.add('active');
    }
    activeId = id;
  };

  const pickActive = () => {
    if (visible.size > 0) {
      for (const h of headings) if (visible.has(h.id)) return h.id;
    }
    const cutoff = root.getBoundingClientRect().top + 16;
    let above = null;
    for (const h of headings) {
      if (h.getBoundingClientRect().top <= cutoff) above = h.id;
      else break;
    }
    return above || headings[0].id;
  };

  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) visible.add(e.target.id);
      else visible.delete(e.target.id);
    }
    setActive(pickActive());
  }, {
    root,
    rootMargin: '0px 0px -70% 0px',
    threshold: 0,
  });

  headings.forEach((h) => observer.observe(h));
  activeTocObserver = observer;
  // IO の初回コールバック前に、現状から推定した先頭見出しを active にしておく
  setActive(pickActive());
}

async function archiveDirectory(category, dirName) {
  if (!confirm(`ディレクトリ ${dirName}/ を archive に移動します。よろしいですか？`)) return;
  try {
    const res = await fetch(`/api/docs/${encodeURIComponent(category)}/${encodeURIComponent(dirName)}/archive-dir`, { method: 'POST' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'アーカイブに失敗しました');
    docsTree = await fetchAllTrees();

    const parsed = parseHash();
    const inArchivedDir = parsed
      && parsed.category === category
      && parsed.filePath.startsWith(`${dirName}/`);
    if (inArchivedDir) {
      const newHash = `${category}/${encodePath(`archive/${parsed.filePath}`)}`;
      if (location.hash === `#${newHash}`) {
        renderSidebar();
        handleRoute();
      } else {
        location.hash = newHash;
      }
    } else {
      renderSidebar();
    }
  } catch (err) {
    alert(err.message);
  }
}

async function archiveFile(category, filename) {
  if (!confirm(`${filename} を archive に移動します。よろしいですか？`)) return;
  try {
    const res = await fetch(`/api/docs/${encodeURIComponent(category)}/${encodeURIComponent(filename)}/archive`, { method: 'POST' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'アーカイブに失敗しました');
    docsTree = await fetchAllTrees();
    const newHash = `${category}/archive/${encodeURIComponent(filename)}`;
    if (location.hash === `#${newHash}`) {
      renderSidebar();
      handleRoute();
    } else {
      location.hash = newHash;
    }
  } catch (err) {
    alert(err.message);
  }
}

// 編集対象を開く。Root タブもカテゴリも同じ経路を通る。
// 読み書きは /api/source/<root 相対パス>、プレビューは /api/render/<同> の 2 本だけ。
async function openDoc(tab, key) {
  clearTocObserver();
  contentArea.innerHTML = '<div class="loading-text">読み込み中...</div>';
  const path = docPathFor(tab, key);
  if (!path) {
    showError('対応していないファイルです');
    return;
  }
  try {
    const data = await fetchJson(sourceUrl(path));
    docState.tab = tab;
    docState.key = key;
    docState.path = path;
    docState.content = data.content || '';
    docState.savedContent = data.content || '';
    docState.mtime = data.mtime;
    docState.eol = data.eol || 'lf';
    docState.readOnly = !!data.readOnly;
    docState.readOnlyReason = data.readOnlyReason || null;
    docState.conflict = null;
    // プレビューできないものは編集モード固定（読み取り専用の理由をそこに出す）
    if (!isMarkdownPath(path)) docState.mode = 'edit';
    else if (docState.mode !== 'preview' && docState.mode !== 'edit') docState.mode = 'preview';

    pageTitle.textContent = tab === EDITABLE_TAB ? key.replace(/\.md$/, '') : key.split('/').pop();
    topbarSub.textContent = path;
    contentArea.innerHTML = '';
    contentArea.appendChild(buildDocLayout());

    if (docState.mode === 'preview') await renderDocPreviewBody();
    else renderDocEditBody();
    updateConflictIndicators();
  } catch (err) {
    showError(err.message);
  }
}

function buildDocLayout() {
  const wrap = document.createElement('div');
  wrap.className = 'todo-view';

  const toolbar = document.createElement('div');
  toolbar.className = 'todo-toolbar';

  // .md 以外はプレビューできないのでサブタブ自体を出さない
  if (isMarkdownPath(docState.path)) {
    const subtabs = document.createElement('div');
    subtabs.className = 'todo-subtabs';
    subtabs.setAttribute('role', 'tablist');
    for (const m of ['preview', 'edit']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'todo-subtab' + (docState.mode === m ? ' active' : '');
      btn.dataset.mode = m;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', docState.mode === m ? 'true' : 'false');
      btn.textContent = m === 'preview' ? 'プレビュー' : '編集';
      btn.addEventListener('click', () => switchDocMode(m));
      subtabs.appendChild(btn);
    }
    toolbar.appendChild(subtabs);
  } else {
    const label = document.createElement('div');
    label.className = 'todo-subtabs';
    toolbar.appendChild(label);
  }

  const actions = document.createElement('div');
  actions.className = 'todo-actions';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'doc-action doc-action-refresh';
  refreshBtn.dataset.role = 'refresh';
  refreshBtn.textContent = '↻ 再取得';
  refreshBtn.addEventListener('click', () => refetchDoc());
  actions.appendChild(refreshBtn);

  // カテゴリ直下の md はこれまでどおりアーカイブできる
  const catDef = CATEGORY_BY_NAME.get(docState.tab);
  if (catDef && catDef.archive && docState.key && !docState.key.includes('/')) {
    const archiveBtn = document.createElement('button');
    archiveBtn.type = 'button';
    archiveBtn.className = 'doc-action';
    archiveBtn.textContent = 'アーカイブする';
    archiveBtn.addEventListener('click', () => archiveFile(docState.tab, docState.key));
    actions.appendChild(archiveBtn);
  }

  if (docState.mode === 'edit' && !docState.readOnly) {
    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'doc-action';
    discardBtn.textContent = '変更を破棄';
    discardBtn.addEventListener('click', discardDocChanges);
    actions.appendChild(discardBtn);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'doc-action doc-action-primary';
    saveBtn.textContent = '保存';
    saveBtn.dataset.role = 'save';
    saveBtn.addEventListener('click', () => saveDoc());
    actions.appendChild(saveBtn);
  }
  toolbar.appendChild(actions);

  wrap.appendChild(toolbar);

  const body = document.createElement('div');
  body.className = 'todo-body';
  body.id = 'todo-body';
  wrap.appendChild(body);

  return wrap;
}

async function switchDocMode(mode) {
  if (docState.mode === mode) return;
  if (docState.mode === 'edit' && isDocDirty()) {
    if (!confirm('未保存の変更があります。破棄してプレビューに切り替えますか？')) return;
    docState.content = docState.savedContent;
    docState.conflict = null;
  }
  docState.mode = mode;
  clearTocObserver();
  contentArea.innerHTML = '';
  contentArea.appendChild(buildDocLayout());
  if (mode === 'preview') await renderDocPreviewBody();
  else renderDocEditBody();
  updateConflictIndicators();
}

// プレビュー本文を描く。カテゴリでは従来どおり目次ペインを併せて出す。
async function renderDocPreviewBody() {
  const body = document.getElementById('todo-body');
  if (!body) return;
  body.innerHTML = '<div class="loading-text">読み込み中...</div>';
  try {
    const data = await fetchJson(renderUrl(docState.path));
    if (typeof data.mtime === 'number') docState.mtime = data.mtime;
    body.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'md-content';
    div.innerHTML = data.html;

    const withToc = docState.tab !== EDITABLE_TAB;
    if (withToc) {
      const layout = document.createElement('div');
      layout.className = 'doc-pane-layout';
      const toc = document.createElement('nav');
      toc.className = 'doc-toc';
      toc.setAttribute('aria-label', 'ページ内目次');
      layout.appendChild(toc);
      const inner = document.createElement('div');
      inner.className = 'doc-body';
      inner.appendChild(div);
      layout.appendChild(inner);
      body.appendChild(layout);
      buildDocToc(div, toc);
    } else {
      body.appendChild(div);
    }
    renderMermaidIn(div);
    injectCopyButtons(div);
  } catch (err) {
    body.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'error-text';
    div.textContent = err.message;
    body.appendChild(div);
  }
}

const READ_ONLY_REASONS = {
  binary: 'バイナリのため編集できません（テキストとして読めない内容です）',
  'too-large': 'サイズが上限を超えているため編集できません',
  symlink: 'シンボリックリンクのため編集できません',
};

function renderDocEditBody() {
  const body = document.getElementById('todo-body');
  if (!body) return;
  body.innerHTML = '';

  if (docState.readOnly) {
    const note = document.createElement('div');
    note.className = 'empty-state';
    note.textContent = READ_ONLY_REASONS[docState.readOnlyReason] || '編集できないファイルです';
    body.appendChild(note);
    return;
  }

  // 改行コードが混在しているファイルは復元しようがないので、保存で LF に寄ることを先に伝える
  if (docState.eol === 'mixed') {
    const warn = document.createElement('div');
    warn.className = 'todo-info-bar';
    warn.textContent = '改行コードが CRLF と LF で混在しています。保存すると LF に統一されます';
    body.appendChild(warn);
  }

  const textarea = document.createElement('textarea');
  textarea.className = 'todo-editor';
  textarea.value = docState.content;
  textarea.setAttribute('spellcheck', 'false');
  textarea.addEventListener('input', () => {
    docState.content = textarea.value;
  });
  // Cmd/Ctrl+S で保存
  textarea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      saveDoc();
    }
  });
  body.appendChild(textarea);
  textarea.focus();
}

function discardDocChanges() {
  if (!isDocDirty()) return;
  if (!confirm('未保存の変更を破棄します。よろしいですか？')) return;
  docState.content = docState.savedContent;
  docState.conflict = null;
  renderDocEditBody();
  updateConflictIndicators();
}

async function refetchDoc() {
  if (!docState.path) return;
  if (docState.mode === 'edit' && isDocDirty()) {
    if (!confirm('未保存の変更があります。再取得すると失われます。続行しますか？')) return;
  }
  try {
    // モードによらず生を取り直す（mtime / 改行コード / 読み取り専用の判定を更新するため）
    const data = await fetchJson(sourceUrl(docState.path));
    docState.content = data.content || '';
    docState.savedContent = data.content || '';
    docState.mtime = data.mtime;
    docState.eol = data.eol || 'lf';
    docState.readOnly = !!data.readOnly;
    docState.readOnlyReason = data.readOnlyReason || null;
    if (docState.mode === 'preview') await renderDocPreviewBody();
    else renderDocEditBody();
    docState.conflict = null;
    updateConflictIndicators();
    showToast('最新を読み込みました', 1500);
  } catch (err) {
    alert(`再取得に失敗しました: ${err.message}`);
  }
}

function updateRefreshButton() {
  const btn = document.querySelector('.todo-toolbar [data-role="refresh"]');
  if (!btn) return;
  const label = formatMtime(docState.mtime);
  btn.title = label ? `最終取得: ${label}\nショートカット: R` : 'ショートカット: R';
  btn.classList.toggle('emphasized', !!docState.conflict);
}

async function saveDoc(options = {}) {
  const { force = false } = options;
  if (!docState.path || docState.readOnly) return;
  if (!force && !isDocDirty()) {
    showToast('変更はありません');
    return;
  }
  saveInFlight = true;
  try {
    const res = await fetch(sourceUrl(docState.path), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: docState.content,
        baseMtime: docState.mtime,
        // textarea が LF に潰した本文を、取得時の改行コードへ戻してもらう
        eol: docState.eol,
      }),
    });
    if (res.status === 409) {
      const json = await res.json().catch(() => ({}));
      const currentMtime = json && json.data && typeof json.data.currentMtime === 'number'
        ? json.data.currentMtime
        : null;
      await handleSaveConflict(currentMtime);
      return;
    }
    const json = await res.json();
    if (!json.success) throw new Error(json.error || '保存に失敗しました');
    docState.mtime = json.data.mtime;
    docState.savedContent = docState.content;
    docState.conflict = null;
    // 自分の書き込みによる SSE 通知を外部変更として扱わないための記録
    const savedMtime = json.data.mtime;
    selfWrittenMtimes.add(savedMtime);
    setTimeout(() => selfWrittenMtimes.delete(savedMtime), 5000);
    updateConflictIndicators();
    // 見出しを直すとサイドバーの表示名も変わるので取り直す
    if (docState.tab !== EDITABLE_TAB) refreshDocsTree();
    showToast('保存しました');
  } catch (err) {
    alert(`保存に失敗しました: ${err.message}`);
  } finally {
    saveInFlight = false;
  }
}

// サイドバーのツリーを取り直して描き直す（タイトルは本文の H1 から抜いているため）
// カテゴリのツリーと Files タブのツリーをまとめて取り直す
async function fetchAllTrees() {
  const [docs, all] = await Promise.all([
    fetchJson('/api/docs'),
    fetchJson('/api/tree'),
  ]);
  return { ...docs, [FILES_TAB]: all };
}

async function refreshDocsTree() {
  try {
    docsTree = await fetchAllTrees();
    renderSidebar();
  } catch {
    // 一覧の更新に失敗しても編集自体は成立しているので黙って諦める
  }
}

function handleSaveConflict(currentMtime) {
  return new Promise((resolve) => {
    showConflictDialog({
      onReload: async () => {
        try {
          await reloadEditFromExternal({ notify: false });
          showToast('最新内容を読み込みました');
        } catch (err) {
          alert(`再取得に失敗しました: ${err.message}`);
        }
        resolve();
      },
      onKeep: () => {
        // 編集は維持。mtime はそのまま（次の保存でも競合するが、意図的な運用）
        resolve();
      },
      onForce: async () => {
        // baseMtime を現在値に差し替えて再 PUT
        if (typeof currentMtime === 'number') {
          docState.mtime = currentMtime;
        } else {
          try {
            const data = await fetchJson(sourceUrl(docState.path));
            docState.mtime = data.mtime;
          } catch (err) {
            alert(`mtime 取得に失敗しました: ${err.message}`);
            resolve();
            return;
          }
        }
        await saveDoc({ force: true });
        resolve();
      },
    });
  });
}

function showConflictDialog({ onReload, onKeep, onForce }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = '外部で更新されています';
  modal.appendChild(title);

  const body = document.createElement('div');
  body.className = 'modal-body';
  body.textContent = 'このファイルは別の場所で更新されました。どう処理しますか？';
  modal.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const close = () => overlay.remove();
  const makeBtn = (label, cls, handler) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `modal-btn${cls ? ' ' + cls : ''}`;
    b.textContent = label;
    b.addEventListener('click', () => { close(); handler(); });
    return b;
  };
  actions.appendChild(makeBtn('手元の内容を維持', '', onKeep));
  actions.appendChild(makeBtn('リロードする（編集を破棄）', '', onReload));
  actions.appendChild(makeBtn('強制上書き', 'modal-btn-danger', onForce));

  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// marked は ```mermaid を <pre><code class="language-mermaid"> で出力するので
// Mermaid 公式形式 <pre class="mermaid"> に置換し、未描画要素を mermaid.run() に渡す。
function renderMermaidIn(root) {
  if (!root) return;
  const codeBlocks = root.querySelectorAll('pre > code.language-mermaid');
  codeBlocks.forEach((code) => {
    const pre = code.parentElement;
    const el = document.createElement('div');
    el.className = 'mermaid';
    el.textContent = code.textContent;
    pre.replaceWith(el);
  });
  const targets = root.querySelectorAll('div.mermaid:not([data-processed])');
  if (targets.length === 0) return;
  if (!window.mermaid) {
    window.addEventListener('mermaid-ready', () => renderMermaidIn(root), { once: true });
    return;
  }
  try {
    window.mermaid.run({ nodes: Array.from(targets) }).catch(() => { /* noop */ });
  } catch {
    /* noop */
  }
}

// 各 <pre> の右上にコピー用ボタンを差し込む。冪等。
// mermaid 変換後 (<pre> が <div.mermaid> に置換された後) に呼ぶ前提。
function injectCopyButtons(root) {
  if (!root) return;
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector(':scope > .copy-btn')) return;
    const code = pre.querySelector('code');
    if (!code) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.textContent = 'copy';
    btn.setAttribute('aria-label', 'コードをコピー');
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.innerText);
        btn.textContent = '✓ copied';
        setTimeout(() => { btn.textContent = 'copy'; }, 1500);
      } catch {
        btn.textContent = 'failed';
        setTimeout(() => { btn.textContent = 'copy'; }, 1500);
      }
    });
    pre.appendChild(btn);
  });
}

function showToast(message, durationMs = 2000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  // enter animation
  requestAnimationFrame(() => toast.classList.add('toast-show'));
  setTimeout(() => {
    toast.classList.remove('toast-show');
    setTimeout(() => toast.remove(), 200);
  }, durationMs);
}

function renderDesign(category, filePath) {
  clearTocObserver();
  const filename = filePath.split('/').pop();
  const meta = findFileMeta(category, filePath);
  pageTitle.textContent = meta ? meta.title : filename;
  topbarSub.textContent = `${category}/${filePath}`;

  const wrap = document.createElement('div');
  wrap.className = 'design-frame-wrap';

  const toolbar = document.createElement('div');
  toolbar.className = 'design-frame-toolbar';
  const left = document.createElement('span');
  left.textContent = filePath;
  const designUrl = `/api/design/${encodeURIComponent(category)}/${encodePath(filePath)}`;
  const right = document.createElement('a');
  right.className = 'design-frame-open';
  right.href = designUrl;
  right.target = '_blank';
  right.rel = 'noopener';
  right.textContent = '別タブで開く ↗';
  toolbar.appendChild(left);
  toolbar.appendChild(right);

  const iframe = document.createElement('iframe');
  iframe.className = 'design-frame';
  iframe.src = designUrl;
  iframe.title = filename;

  wrap.appendChild(toolbar);
  wrap.appendChild(iframe);

  contentArea.innerHTML = '';
  contentArea.appendChild(wrap);
}

function showError(message) {
  clearTocObserver();
  contentArea.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'error-text';
  div.textContent = message;
  contentArea.appendChild(div);
}

function showEmpty() {
  clearTocObserver();
  pageTitle.textContent = 'ドキュメント';
  topbarSub.textContent = '';
  contentArea.innerHTML = '<div class="empty-state">サイドバーからドキュメントを選択してください。</div>';
}

function parseHash() {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return null;
  const slash = hash.indexOf('/');
  if (slash < 0) return null;
  const category = hash.slice(0, slash);
  const filePath = decodePath(hash.slice(slash + 1));
  return { category, filePath };
}

function expandAncestors(category, filePath) {
  const parts = filePath.split('/');
  if (parts.length <= 1) return false;
  let changed = false;
  let prefix = '';
  for (let i = 0; i < parts.length - 1; i++) {
    prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
    const key = `${category}/${prefix}`;
    if (!expanded[key]) {
      expanded[key] = true;
      changed = true;
    }
  }
  if (changed) saveExpanded();
  return changed;
}

// 別のファイルへ移る前に未保存を確認する。false なら遷移を中止させる。
// 以前は Root タブだけの処理だったが、カテゴリも編集できるようになったので共通化した。
function confirmLeaveDoc(nextTab, nextKey) {
  if (!docState.key) return true;
  if (docState.tab === nextTab && docState.key === nextKey) return true;
  if (!isDocDirty()) return true;
  if (!confirm('未保存の変更があります。破棄して別のファイルに移動しますか？')) return false;
  docState.content = docState.savedContent;
  docState.conflict = null;
  return true;
}

// 現在開いているドキュメントの hash（未保存確認で引き返すときに使う）
function currentDocHash() {
  if (!docState.tab || !docState.key) return null;
  return `#${docState.tab}/${encodePath(docState.key)}`;
}

function handleRoute() {
  const rawHash = location.hash.replace(/^#/, '');

  // 旧 #design/xxx.html → #specs/design/xxx.html （specs カテゴリがある場合のみ）
  // 'design' という名前の**実在するカテゴリ**がある場合はそちらが優先。
  // 互換処理が本物のカテゴリを横取りして specs へ飛ばしてしまうため。
  if (
    rawHash.startsWith('design/') &&
    !CATEGORY_BY_NAME.has('design') &&
    CATEGORY_BY_NAME.has('specs')
  ) {
    location.replace(`#specs/${rawHash}`);
    return;
  }

  const parsed = parseHash();
  if (!parsed) {
    refreshActiveHighlight();
    showEmpty();
    setWatchTarget(null);
    // hash が無くても customTab がアクティブなら SSE は繋いでおく（サイドバー更新のため）
    if (CUSTOM_TAB_BY_NAME.has(activeCategory)) {
      ensureCustomTabSource(activeCategory);
    } else {
      disconnectCustomTabSource();
      clearCustomTabIframe();
    }
    return;
  }

  const { category, filePath } = parsed;
  if (!CATEGORIES.includes(category)) {
    setWatchTarget(null);
    showError('不正なカテゴリです');
    return;
  }

  let needSidebarRerender = false;
  if (activeCategory !== category) {
    // 直前のカテゴリが customTab だった場合、対応する SSE をクリーンアップ
    if (CUSTOM_TAB_BY_NAME.has(activeCategory) && activeCategory !== category) {
      disconnectCustomTabSource();
      clearCustomTabIframe();
    }
    activeCategory = category;
    saveActiveCategory();
    renderTabs();
    needSidebarRerender = true;
  }

  if (CUSTOM_TAB_BY_NAME.has(category)) {
    setWatchTarget(null);
    // customTab: filePath は item id。空文字なら未選択扱い。
    if (needSidebarRerender) {
      renderSidebar();
    } else {
      refreshActiveHighlight();
    }
    ensureCustomTabSource(category);
    if (filePath) {
      renderCustomTabView(category, filePath);
    } else {
      showEmpty();
    }
    return;
  }

  if (category === EDITABLE_TAB) {
    if (!EDITABLE_NAMES.includes(filePath)) {
      if (needSidebarRerender) renderSidebar();
      else refreshActiveHighlight();
      setWatchTarget(null);
      showError('対応していないファイルです');
      return;
    }
    if (!confirmLeaveDoc(EDITABLE_TAB, filePath)) {
      // 元のファイルに戻す（履歴を増やさないよう replace）
      const back = currentDocHash();
      if (back) location.replace(back);
      return;
    }
    if (needSidebarRerender) renderSidebar();
    else refreshActiveHighlight();
    setWatchTarget(docPathFor(EDITABLE_TAB, filePath));
    openDoc(EDITABLE_TAB, filePath);
    return;
  }

  if (!confirmLeaveDoc(category, filePath)) {
    const back = currentDocHash();
    if (back) location.replace(back);
    return;
  }

  if (category === FILES_TAB) {
    // Files タブは拡張子で分けない（.html もソースとして開く）
    if (expandAncestors(category, filePath)) needSidebarRerender = true;
    if (needSidebarRerender) renderSidebar();
    else refreshActiveHighlight();
    setWatchTarget(filePath);
    openDoc(FILES_TAB, filePath);
    return;
  }

  if (expandAncestors(category, filePath)) {
    needSidebarRerender = true;
  }
  if (needSidebarRerender) renderSidebar();
  else refreshActiveHighlight();

  const lastDot = filePath.lastIndexOf('.');
  const ext = lastDot >= 0 ? filePath.slice(lastDot).toLowerCase() : '';
  if (ext === '.html') {
    // .html はカテゴリではレンダリング結果を iframe で見る（ソースは編集対象外）
    setWatchTarget(null);
    renderDesign(category, filePath);
  } else if (ext === '.md') {
    setWatchTarget(docPathFor(category, filePath));
    openDoc(category, filePath);
  } else {
    setWatchTarget(null);
    showError('対応していないファイル形式です');
  }
}

// 設定された editable / categories / customTabs から topbar の tab ボタンを動的に組み立てる
function buildTabs() {
  topbarTabs.innerHTML = '';
  const tabs = [
    ...CUSTOM_TABS.map(t => ({ name: t.name, label: t.label })),
    { name: EDITABLE_TAB, label: EDITABLE_LABEL },
    ...CATEGORY_DEFS.map(c => ({ name: c.name, label: c.label })),
    { name: FILES_TAB, label: FILES_LABEL },
  ];
  for (const t of tabs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'topbar-tab';
    btn.setAttribute('role', 'tab');
    btn.dataset.category = t.name;
    btn.setAttribute('aria-selected', 'false');
    btn.textContent = t.label;
    topbarTabs.appendChild(btn);
  }
}

function setupTabs() {
  topbarTabs.querySelectorAll('.topbar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const cat = tab.dataset.category;
      if (!CATEGORIES.includes(cat) || activeCategory === cat) return;
      // 編集タブから離れるときは未保存確認
      if (isDocDirty()) {
        if (!confirm('未保存の変更があります。破棄して他のタブに移動しますか？')) return;
        docState.content = docState.savedContent;
        docState.conflict = null;
        updateConflictIndicators();
      }
      // customTab から離れる場合は SSE / iframe を破棄
      if (CUSTOM_TAB_BY_NAME.has(activeCategory)) {
        disconnectCustomTabSource();
        clearCustomTabIframe();
      }
      activeCategory = cat;
      saveActiveCategory();
      renderTabs();
      renderSidebar();

      if (location.hash) {
        history.pushState(null, '', location.pathname + location.search);
      }
      refreshActiveHighlight();
      showEmpty();
      setWatchTarget(null);

      // customTab に入ったら SSE を確立（サイドバーは renderSidebar 内でフェッチ済み）
      if (CUSTOM_TAB_BY_NAME.has(cat)) {
        ensureCustomTabSource(cat);
      }
    });
  });
}

function setupBeforeUnload() {
  window.addEventListener('beforeunload', (e) => {
    if (isDocDirty()) {
      e.preventDefault();
      // 一部ブラウザ（古い Chrome 等）は returnValue 設定を要求する
      e.returnValue = '';
      return '';
    }
  });
}

// `R` 単独キーで TODO を再取得。Cmd/Ctrl+R は奪わずブラウザリロードに任せる
function setupRefreshShortcut() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'r' && e.key !== 'R') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!docState.path || activeCategory !== docState.tab) return;
    const target = e.target;
    if (target) {
      const tag = target.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
      if (target.isContentEditable) return;
    }
    e.preventDefault();
    refetchDoc();
  });
}

// === SSE: 外部変更のリアルタイム反映 ===

// 監視対象を設定して SSE を張り直す。同じ対象なら何もしない。
// EventSource は URL を後から変えられないので、開くファイルが変わるたびに繋ぎ直す。
function setWatchTarget(path) {
  if (typeof EventSource === 'undefined') return;
  const next = path || null;
  if (sseState.source && sseState.watchPath === next) return;

  if (sseState.source) {
    // 自分で閉じるぶんには「切断中」を出さない
    sseState.reconnecting = true;
    try { sseState.source.close(); } catch { /* ignore */ }
    sseState.source = null;
    sseState.connected = false;
  }
  sseState.watchPath = next;
  updateSseIndicator();

  try {
    const url = next ? `/api/files/watch?watch=${encodePath(next)}` : '/api/files/watch';
    const es = new EventSource(url);
    sseState.source = es;
    es.addEventListener('open', () => {
      sseState.connected = true;
      sseState.reconnecting = false;
      updateSseIndicator();
    });
    es.addEventListener('error', () => {
      // EventSource は自動で再接続を試みる
      sseState.connected = false;
      sseState.reconnecting = false;
      updateSseIndicator();
    });
    es.addEventListener('change', (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (typeof payload.path !== 'string' || typeof payload.mtime !== 'number') return;
        handleExternalChange(payload.path, payload.mtime);
      } catch {
        // ignore malformed
      }
    });
  } catch {
    sseState.reconnecting = false;
    updateSseIndicator();
  }
}

function updateSseIndicator() {
  const el = document.getElementById('sse-indicator');
  if (!el) return;
  el.hidden = sseState.connected || sseState.reconnecting;
}

async function handleExternalChange(path, mtime) {
  // 自分の保存中の書き込みは無視
  if (saveInFlight) return;
  // 自分が書いた mtime は無視（SSE が PUT 応答より先に届いたケースも含む）
  if (selfWrittenMtimes.has(mtime)) return;
  // 現在開いていないファイルは何もしない（次に開くときに最新を取りに行く）
  // 通知は今開いているファイルについてのみ来る想定だが、張り替えの行き違いに備えて照合する
  if (!docState.path || docState.path !== path) return;
  // 既知の mtime と一致するなら無視（自分の保存直後に想定）
  if (docState.mtime === mtime) return;
  // 同じ競合 mtime を再通知された場合は UI 再構築を避ける
  if (docState.conflict && docState.conflict.mtime === mtime) return;

  if (docState.mode === 'preview') {
    await refetchPreviewForExternalChange();
    return;
  }

  if (!isDocDirty()) {
    // clean 編集: 内容と mtime を差し替え + 情報バー
    await reloadEditFromExternal({ notify: true });
    return;
  }

  // dirty 編集: 競合状態に遷移
  docState.conflict = { mtime, barVisible: true };
  updateConflictIndicators();
}

async function refetchPreviewForExternalChange() {
  try {
    await renderDocPreviewBody();
    flashExternalUpdateBadge();
  } catch {
    // ignore
  }
}

async function reloadEditFromExternal({ notify }) {
  try {
    const data = await fetchJson(sourceUrl(docState.path));
    docState.content = data.content || '';
    docState.savedContent = data.content || '';
    docState.mtime = data.mtime;
    docState.eol = data.eol || 'lf';
    docState.readOnly = !!data.readOnly;
    docState.readOnlyReason = data.readOnlyReason || null;
    docState.conflict = null;
    if (docState.mode === 'edit') renderDocEditBody();
    else await renderDocPreviewBody();
    updateConflictIndicators();
    if (notify) showCleanUpdateInfoBar();
  } catch {
    // ignore
  }
}

function flashExternalUpdateBadge() {
  const view = document.querySelector('.todo-view');
  if (!view) return;
  // 既存バッジがあれば取り替え
  const existing = view.querySelector('.todo-update-badge');
  if (existing) {
    clearTimeout(existing._timer);
    existing.remove();
  }
  const badge = document.createElement('div');
  badge.className = 'todo-update-badge';
  badge.textContent = '外部で更新されました';
  view.appendChild(badge);
  requestAnimationFrame(() => badge.classList.add('visible'));
  badge._timer = setTimeout(() => {
    badge.classList.remove('visible');
    setTimeout(() => badge.remove(), 300);
  }, 1500);
}

function showCleanUpdateInfoBar() {
  const view = document.querySelector('.todo-view');
  if (!view) return;
  const existing = view.querySelector('.todo-info-bar');
  if (existing) {
    clearTimeout(existing._timer);
    existing.remove();
  }
  const bar = document.createElement('div');
  bar.className = 'todo-info-bar';
  bar.textContent = '外部で更新されたため、最新内容に差し替えました';
  const toolbar = view.querySelector('.todo-toolbar');
  if (toolbar && toolbar.nextSibling) {
    view.insertBefore(bar, toolbar.nextSibling);
  } else if (toolbar) {
    view.appendChild(bar);
  } else {
    view.insertBefore(bar, view.firstChild);
  }
  bar._timer = setTimeout(() => {
    bar.classList.add('fade-out');
    setTimeout(() => bar.remove(), 300);
  }, 4000);
}

function updateConflictIndicators() {
  const active = !!docState.conflict;
  // タブタイトルの prepend
  document.title = active ? `(!) ${TITLE_BASE}` : TITLE_BASE;
  // 警告バー
  renderConflictBar();
  // サイドバー赤●バッジ
  refreshSidebarConflictBadge();
  // 再取得ボタンの tooltip / 強調
  updateRefreshButton();
}

function renderConflictBar() {
  const view = document.querySelector('.todo-view');
  if (!view) return;
  const existing = view.querySelector('.todo-conflict-bar');
  if (!docState.conflict || !docState.conflict.barVisible) {
    if (existing) existing.remove();
    return;
  }
  if (existing) existing.remove();

  const bar = document.createElement('div');
  bar.className = 'todo-conflict-bar';

  const msg = document.createElement('div');
  msg.className = 'todo-conflict-message';
  const fmt = formatMtime(docState.conflict.mtime);
  msg.textContent = `⚠ 競合: 外部で ${docState.path} が更新されています（${fmt}）。保存すると外部の変更を上書きします`;
  bar.appendChild(msg);

  const actions = document.createElement('div');
  actions.className = 'todo-conflict-actions';
  const makeBtn = (label, handler, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'todo-conflict-btn' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.addEventListener('click', handler);
    return b;
  };
  actions.appendChild(makeBtn('差分を見る', () => showDiffModal()));
  actions.appendChild(makeBtn('外部版を読み込む（手元の変更を破棄）', async () => {
    if (!confirm('手元の未保存変更を破棄して外部版を読み込みます。よろしいですか？')) return;
    await reloadEditFromExternal({ notify: false });
    showToast('外部版を読み込みました');
  }));
  actions.appendChild(makeBtn('このまま編集を続ける', () => {
    if (docState.conflict) docState.conflict.barVisible = false;
    updateConflictIndicators();
  }));
  bar.appendChild(actions);

  // toolbar の直下に挿入
  const toolbar = view.querySelector('.todo-toolbar');
  if (toolbar && toolbar.nextSibling) {
    view.insertBefore(bar, toolbar.nextSibling);
  } else if (toolbar) {
    view.appendChild(bar);
  } else {
    view.insertBefore(bar, view.firstChild);
  }
}

async function showDiffModal() {
  try {
    const data = await fetchJson(sourceUrl(docState.path));
    openDiffModal(docState.content, data.content || '');
  } catch (err) {
    alert(`外部内容の取得に失敗しました: ${err.message}`);
  }
}

function openDiffModal(local, remote) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal modal-wide';

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = `差分: ${docState.path}（手元 vs 外部）`;
  modal.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'diff-grid';

  const makeCol = (heading, text, cls) => {
    const col = document.createElement('div');
    col.className = 'diff-col' + (cls ? ' ' + cls : '');
    const h = document.createElement('div');
    h.className = 'diff-col-header';
    h.textContent = heading;
    col.appendChild(h);
    const pre = document.createElement('pre');
    pre.className = 'diff-pre';
    pre.textContent = text;
    col.appendChild(pre);
    return col;
  };
  grid.appendChild(makeCol('手元（未保存）', local, 'diff-col-local'));
  grid.appendChild(makeCol('外部（最新）', remote, 'diff-col-remote'));
  modal.appendChild(grid);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'modal-btn';
  closeBtn.textContent = '閉じる';
  closeBtn.addEventListener('click', () => overlay.remove());
  actions.appendChild(closeBtn);
  modal.appendChild(actions);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

function refreshSidebarConflictBadge() {
  if (!sidebarNav) return;
  const conflictKey = (docState.conflict && docState.tab === activeCategory) ? docState.key : null;
  sidebarNav.querySelectorAll('.nav-item').forEach(el => {
    // 表示中のタブのアイテムだけを対象にする
    if (el.dataset.category !== activeCategory) return;
    let badge = el.querySelector('.nav-item-badge');
    if (el.dataset.path === conflictKey) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-item-badge';
        badge.title = '外部で更新されました（競合中）';
        badge.textContent = '●';
        el.appendChild(badge);
      }
    } else if (badge) {
      badge.remove();
    }
  });
}

// === customTabs (vibeboard プラグイン) ===

// プラグイン側 /api/sidebar をフェッチしてキャッシュ。失敗は error として記録する。
async function fetchCustomTabSidebar(name) {
  const tab = CUSTOM_TAB_BY_NAME.get(name);
  if (!tab) return { items: [], error: 'unknown tab' };
  try {
    const res = await fetch(`${tab.baseUrl}/api/sidebar`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const items = Array.isArray(json && json.items) ? json.items : [];
    const state = { items, error: null };
    customTabState.cache.set(name, state);
    return state;
  } catch (err) {
    const state = { items: [], error: `${tab.label} に接続できません: ${err && err.message ? err.message : err}` };
    customTabState.cache.set(name, state);
    return state;
  }
}

async function renderCustomTabSidebar(name) {
  sidebarNav.innerHTML = '<div class="loading-text">読み込み中...</div>';
  const state = await fetchCustomTabSidebar(name);
  // 描画中にユーザーが他タブへ移っていたら中断
  if (activeCategory !== name) return;
  sidebarNav.innerHTML = '';

  if (state.error) {
    const empty = document.createElement('div');
    empty.className = 'error-text';
    empty.textContent = state.error;
    sidebarNav.appendChild(empty);
    return;
  }
  if (state.items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'loading-text';
    empty.textContent = '項目がありません';
    sidebarNav.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  let lastGroup = null;
  for (const it of state.items) {
    if (!it || typeof it.id !== 'string' || typeof it.label !== 'string') continue;
    const group = typeof it.group === 'string' ? it.group : null;
    if (group && group !== lastGroup) {
      const header = document.createElement('div');
      header.className = 'nav-group-header';
      header.textContent = group;
      frag.appendChild(header);
      lastGroup = group;
    } else if (!group) {
      lastGroup = null;
    }
    const a = document.createElement('a');
    a.className = 'nav-item';
    a.href = `#${name}/${encodeURIComponent(it.id)}`;
    a.dataset.category = name;
    a.dataset.path = it.id;
    const title = document.createElement('div');
    title.textContent = it.label;
    a.appendChild(title);
    if (typeof it.sub === 'string' && it.sub) {
      const sub = document.createElement('div');
      sub.className = 'nav-item-file';
      sub.textContent = it.sub;
      a.appendChild(sub);
    }
    if (typeof it.badge === 'string' && it.badge) {
      const badge = document.createElement('span');
      badge.className = 'nav-item-badge';
      badge.textContent = it.badge;
      a.appendChild(badge);
    }
    frag.appendChild(a);
  }
  sidebarNav.appendChild(frag);
  refreshActiveHighlight();

  // item 未指定で customTab を開いた場合は、サイドバー先頭の有効な項目に自動遷移する
  // (タブを開いた直後に空ペインではなく最初の項目を表示するため)
  const firstItem = state.items.find(
    it => it && typeof it.id === 'string' && typeof it.label === 'string'
  );
  if (firstItem) {
    const parsed = parseHash();
    const alreadySelected = !!(parsed && parsed.category === name && parsed.filePath);
    if (!alreadySelected) {
      location.replace(`#${name}/${encodeURIComponent(firstItem.id)}`);
    }
  }
}

function buildCustomTabSrc(tab, itemId, bust) {
  const t = bust ? `&_t=${Date.now()}` : '';
  return `${tab.baseUrl}/view?item=${encodeURIComponent(itemId)}${t}`;
}

function renderCustomTabView(name, itemId) {
  clearTocObserver();
  const tab = CUSTOM_TAB_BY_NAME.get(name);
  if (!tab) return;
  pageTitle.textContent = tab.label;
  topbarSub.textContent = itemId;

  // 同じタブ・同じ id で再描画される場合は iframe を作り直さない
  if (
    customTabState.iframe
    && customTabState.iframeName === name
    && customTabState.iframeItemId === itemId
    && customTabState.iframe.isConnected
  ) {
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'design-frame-wrap';

  const iframe = document.createElement('iframe');
  iframe.className = 'design-frame';
  iframe.src = buildCustomTabSrc(tab, itemId, false);
  iframe.title = `${tab.label}: ${itemId}`;
  wrap.appendChild(iframe);

  contentArea.innerHTML = '';
  contentArea.appendChild(wrap);

  customTabState.iframe = iframe;
  customTabState.iframeName = name;
  customTabState.iframeItemId = itemId;
}

function clearCustomTabIframe() {
  customTabState.iframe = null;
  customTabState.iframeName = null;
  customTabState.iframeItemId = null;
}

function ensureCustomTabSource(name) {
  if (customTabState.sourceName === name && customTabState.source) return;
  disconnectCustomTabSource();
  const tab = CUSTOM_TAB_BY_NAME.get(name);
  if (!tab || typeof EventSource === 'undefined') return;
  let es;
  try {
    es = new EventSource(`${tab.baseUrl}/api/watch`);
  } catch {
    return;
  }
  customTabState.source = es;
  customTabState.sourceName = name;

  es.addEventListener('sidebar', () => {
    if (activeCategory !== name) return;
    renderCustomTabSidebar(name);
  });
  es.addEventListener('item-changed', (e) => {
    if (activeCategory !== name) return;
    let payload;
    try { payload = JSON.parse(e.data); } catch { return; }
    if (!payload || typeof payload.id !== 'string') return;
    // reload === false は「プラグインが iframe 内で自己更新するので親はリロードするな」
    // の合図。iframe 内の inline script が自前で SSE を購読して DOM 差分パッチする場合に
    // 使う (毎回 iframe.src を触るとちらつき・アニメ/スクロール位置のリセットが起きるため)。
    // 省略時は true 扱いで、親が該当 iframe を再ロードする。
    if (payload.reload === false) return;
    // 表示中の item がこの id なら iframe を reload
    if (
      customTabState.iframe
      && customTabState.iframeName === name
      && customTabState.iframeItemId === payload.id
    ) {
      customTabState.iframe.src = buildCustomTabSrc(tab, payload.id, true);
    }
  });
  es.addEventListener('error', () => {
    // 再接続は EventSource 任せ
  });
}

function disconnectCustomTabSource() {
  if (customTabState.source) {
    try { customTabState.source.close(); } catch { /* ignore */ }
  }
  customTabState.source = null;
  customTabState.sourceName = null;
}

function setupSidebarToggle() {
  const toggle = document.getElementById('sidebar-toggle');
  const mainBody = document.querySelector('.main-body');
  if (!toggle || !mainBody) return;

  // 初期状態: <head> のインラインスクリプトが html.pre-sidebar-collapsed を付けているので
  // それを正規の .main-body.sidebar-collapsed に転写し、pre クラスは外す。
  const collapsedInitially = document.documentElement.classList.contains('pre-sidebar-collapsed');
  if (collapsedInitially) {
    mainBody.classList.add('sidebar-collapsed');
  }
  document.documentElement.classList.remove('pre-sidebar-collapsed');

  function applyAriaLabel(collapsed) {
    const label = collapsed ? 'サイドバーを展開' : 'サイドバーを折りたたむ';
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('title', label);
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }
  applyAriaLabel(collapsedInitially);

  toggle.addEventListener('click', () => {
    const collapsed = mainBody.classList.toggle('sidebar-collapsed');
    try {
      if (collapsed) localStorage.setItem(STORAGE_SIDEBAR_COLLAPSED, '1');
      else localStorage.removeItem(STORAGE_SIDEBAR_COLLAPSED);
    } catch (e) {}
    applyAriaLabel(collapsed);
  });
}

async function init() {
  loadPersisted();
  setupSidebarToggle();
  buildTabs();
  setupTabs();
  setupBeforeUnload();
  setupRefreshShortcut();
  setupDocLinkInterception();
  renderTabs();
  updateSseIndicator();
  setWatchTarget(null);

  try {
    docsTree = await fetchAllTrees();
    renderSidebar();
    handleRoute();
  } catch (err) {
    sidebarNav.innerHTML = '';
    showError(err.message);
  }
}

window.addEventListener('hashchange', handleRoute);

// customTab iframe からの遷移要求 (postMessage { type: 'vb-nav', hash }) を受け取る。
// iframe から直接 `target="_top"` でフラグメント遷移すると iframe のオリジンで
// URL が解決されてしまうため、postMessage 経由で vibeboard のハッシュを書き換える。
window.addEventListener('message', (ev) => {
  const data = ev && ev.data;
  if (!data || typeof data !== 'object') return;
  if (data.type !== 'vb-nav') return;
  if (typeof data.hash !== 'string' || !data.hash) return;
  const next = `#${data.hash}`;
  if (location.hash === next) {
    // 同一 hash なら hashchange が発火しないので明示的に呼ぶ
    handleRoute();
  } else {
    location.hash = data.hash;
  }
});

init();
