'use strict';

// 旧 Root タブ（スラッグ 'todo'）は廃止した。#todo/<name> は #files/<name> へ読み替える（handleRoute）。
const LEGACY_ROOT_TAB = 'todo';
// プロジェクト内の全ファイルを開くタブ。こちらもスラッグは固定。
const FILES_TAB = 'files';
// TODO.md のタスクを、待ち受けている Claude Code へ渡すタブ。スラッグは固定。
const TASKS_TAB = 'tasks';
const TASKS_LABEL = 'Tasks';

// サーバから注入された設定。`__VIBEBOARD__` には categories / files / customTabs も含まれる。
const VB_CONFIG = (typeof window !== 'undefined' && window.__VIBEBOARD__) || {};
const CATEGORY_DEFS = Array.isArray(VB_CONFIG.categories) && VB_CONFIG.categories.length > 0
  ? VB_CONFIG.categories
  : [
      { name: 'plans', label: 'Plans', archive: true },
      { name: 'specs', label: 'Specs', archive: false },
    ];
const CATEGORY_BY_NAME = new Map(CATEGORY_DEFS.map(c => [c.name, c]));
// customTabs はサーバ側で正規化済み（name/label/base）。base は同一オリジンの
// `/ext/<name>`（サーバがプラグインの baseUrl へ中継する）。未指定なら空配列。
const CUSTOM_TABS = Array.isArray(VB_CONFIG.customTabs) ? VB_CONFIG.customTabs : [];
const CUSTOM_TAB_BY_NAME = new Map(CUSTOM_TABS.map(t => [t.name, t]));
const FILES_LABEL = (VB_CONFIG.files && VB_CONFIG.files.label) || 'Files';
const CATEGORIES = [
  FILES_TAB,
  TASKS_TAB,
  ...CATEGORY_DEFS.map(c => c.name),
  ...CUSTOM_TABS.map(t => t.name),
];

const STORAGE_CATEGORY = 'vibeboard.activeCategory';
const STORAGE_EXPANDED = 'vibeboard.expanded';
const STORAGE_SIDEBAR_COLLAPSED = 'vibeboard.sidebarCollapsed';
const STORAGE_SORT = 'vibeboard.sort';
// タスクを含む Markdown を開いたとき、ツリーとプレビューのどちらを出すか（前回の選択）
const STORAGE_TODO_MODE = 'vibeboard.todoMode';

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
// デフォルトは最初のドキュメントカテゴリ（無ければ Files タブ）
let activeCategory = CATEGORY_DEFS.length > 0 ? CATEGORY_DEFS[0].name : FILES_TAB;
let expanded = {};
// カテゴリごとのソート設定（'mtime-desc' | 'name-asc'）。loadPersisted で復元する
let sortByCategory = {};

// 現在開いている編集対象（openDoc で更新）。
// カテゴリ / Files タブを 1 つの状態で扱う。
// **API を引くのは path（root 相対）1 本**で、key は hash とサイドバー上の識別子。
const docState = {
  tab: null,           // FILES_TAB | カテゴリ名
  key: null,           // hash 上の識別子（Files: root 相対パス / カテゴリ: 'sub/foo.md'）
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
  const base = categoryBasePath(tab);
  if (base === null) return null;
  return base ? `${base}/${key}` : key;
}

// カテゴリのディレクトリ（root 相対）。カテゴリでなければ null。
function categoryBasePath(name) {
  const cat = CATEGORY_BY_NAME.get(name);
  if (!cat) return null;
  return typeof cat.path === 'string' ? cat.path : `docs/${name}`;
}

// root 相対パスをどのタブで開くか決める。
// preferTab に収まるならそのまま。そうでなければ他のカテゴリ → Files タブ の順で探す
// （カテゴリのツリーは .md / .html しか並べないので、他の場所・拡張子は Files へ）。
function docHashForPath(path, preferTab) {
  const names = [
    ...(preferTab && CATEGORY_BY_NAME.has(preferTab) ? [preferTab] : []),
    ...CATEGORY_DEFS.map(c => c.name).filter(n => n !== preferTab),
  ];
  if (/\.(md|html)$/i.test(path)) {
    for (const name of names) {
      const base = categoryBasePath(name);
      if (base && path.startsWith(`${base}/`)) {
        return `${name}/${encodePath(path.slice(base.length + 1))}`;
      }
    }
  }
  return `${FILES_TAB}/${encodePath(path)}`;
}

function sourceUrl(path) {
  return `/api/source/${encodePath(path)}`;
}

function renderUrl(path) {
  return `/api/render/${encodePath(path)}`;
}

function todoUrl(path) {
  return `/api/todo/${encodePath(path)}`;
}

// `- [ ]` の行が 1 つでもあれば「ツリー」サブタブを出す（判定はサーバの todo.ts と同じ）
function hasTaskLines(content) {
  return typeof content === 'string' && /^\s*(?:[-*+]|\d+[.)])\s+\[.\]/m.test(content);
}

function loadTodoModePref() {
  try {
    return localStorage.getItem(STORAGE_TODO_MODE) === 'preview' ? 'preview' : 'tree';
  } catch (e) {
    return 'tree';
  }
}

function saveTodoModePref(mode) {
  try {
    localStorage.setItem(STORAGE_TODO_MODE, mode);
  } catch (e) {}
}

// 開くファイルに合わせて表示モードを決める。
// タスクを含む Markdown は「ツリー」を出せる。前回ツリーとプレビューのどちらを選んだかを覚えていて、
// 編集中でなければそれに合わせる。タスクの無いファイルではツリーは出せないのでプレビューへ落とす
function resolveDocMode(mode, hasTasks) {
  if (mode === 'edit') return 'edit';
  if (!hasTasks) return 'preview';
  return loadTodoModePref();
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

// 本文 (.md-content / TODO ツリー) 内の相対リンクを SPA の hash 遷移へ変換する。
// 描画時に href 属性そのものを hash URL へ書き換える（rewriteRelativeDocLinks）。
// クリック委譲だけだと修飾キー付き（Ctrl+クリック / 中クリック）が素通しになり、
// ブラウザが相対 href のまま /rules.md を取りにいって Cannot GET になっていた（2026-09-11）。
// 元の Markdown は無編集のまま（GitHub / VSCode プレビューの相対リンクを壊さない）。
// 画像・音声等のメディアはサーバ側で /files に書き換え済み（先頭 /）なのでここでは扱わない。
// **今開いているファイルの場所からの相対**で解決する（Files タブの TODO.md なら root から。
// 以前は docs/<category>/ の中でしか解決せず、TODO.md の `[plan](docs/plans/x.md)` は
// ブラウザがそのまま開こうとして 404 になっていた）。
// 開く先のタブは docHashForPath が決める（カテゴリ → Files）。
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
  if (!pathPart || !docState.path) return null;
  try { pathPart = decodeURIComponent(pathPart); } catch (e) {}
  const resolved = resolveRelativeToDoc(pathPart);
  if (!resolved) return null;
  return `#${docHashForPath(resolved, docState.tab)}`;
}

// 今開いているファイルのディレクトリからの相対パスを root 相対にする。root の外なら null。
function resolveRelativeToDoc(rel) {
  const segs = docState.path.split('/').slice(0, -1);
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segs.length === 0) return null;
      segs.pop();
      continue;
    }
    segs.push(part);
  }
  return segs.length > 0 ? segs.join('/') : null;
}

// root 以下の相対リンクの href を hash URL へ書き換える（描画のたびに呼ぶ）。
// 書き換えたリンクには data-doc-link を印に付ける（クリック委譲が同一 hash の再描画に使う）。
function rewriteRelativeDocLinks(root) {
  if (!root) return;
  root.querySelectorAll('a[href]').forEach((a) => {
    const targetHash = resolveDocLinkHash(a.getAttribute('href'));
    if (!targetHash) return;
    a.setAttribute('href', targetHash);
    a.dataset.docLink = '1';
  });
}

// contentArea（安定コンテナ。子は描画ごとに差し替え）に委譲クリックを 1 度だけ張る。
// href は描画時に書き換え済みなので通常はデフォルトの hash 遷移で足りるが、
// 今開いているファイルへのリンク（同一 hash。hashchange が発火しない）の再描画をここで拾う。
function setupDocLinkInterception() {
  contentArea.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a');
    if (!a || !contentArea.contains(a)) return;
    const targetHash = a.dataset.docLink === '1'
      ? a.getAttribute('href')
      : resolveDocLinkHash(a.getAttribute('href'));
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

// サイドバー上端の行。左にソート切替トグル、右に「+ 新規」。
// 通常カテゴリと Files のときだけ表示し、Tasks では hidden にする。
// ソートはアクティブキーに ↑/↓ を併記。アクティブを再クリックすると方向を反転、
// 非アクティブをクリックするとそのキーの記憶済み方向で切替。
function renderSidebarHeader() {
  if (!sidebarSort) return;
  // Tasks（タスク一覧）には並び替え・新規は要らない
  if (activeCategory === TASKS_TAB) {
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

  // Files タブとカテゴリでは新規作成できる。
  // customTab（中身はプラグイン側）と Tasks には出さない。
  if (activeCategory === FILES_TAB || CATEGORY_BY_NAME.has(activeCategory)) {
    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'sidebar-new-btn';
    newBtn.textContent = '+ 新規';
    newBtn.title = 'ファイルを新規作成';
    newBtn.addEventListener('click', createFile);
    sidebarSort.appendChild(newBtn);
  }
}

function renderSidebar() {
  renderSidebarHeader();

  if (activeCategory === TASKS_TAB) {
    renderTasksSidebar();
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

// === 新規作成 / リネーム / 削除 ===
//
// 対象はファイル 1 個だけ（ディレクトリは作らないし消さない）。パスの妥当性は
// サーバの resolveSource が最終判定なので、ここでは体裁だけ整えて投げる。

// 「+ 新規」の初期値。今いる場所に寄せる（Files タブは開いているファイルの
// ディレクトリ、カテゴリはそのカテゴリ直下）。
function newFileBasePath() {
  if (activeCategory === FILES_TAB) {
    const cur = docState.tab === FILES_TAB && docState.path ? docState.path : '';
    const slash = cur.lastIndexOf('/');
    return slash > 0 ? `${cur.slice(0, slash)}/` : '';
  }
  const base = categoryBasePath(activeCategory);
  return base ? `${base}/` : '';
}

// 入力されたパスを整える（前後の空白と先頭の / を落とすだけ。判定はサーバ側）
function normalizeInputPath(input) {
  return input.trim().replace(/^\/+/, '');
}

// .md だけ H1 を入れておく。カテゴリのツリーは H1 をタイトルとして並べるので、
// 空のままだと一覧で見分けがつかない。それ以外の拡張子は空で作る。
function initialContentFor(path) {
  if (!isMarkdownPath(path)) return '';
  const name = path.split('/').pop().replace(/\.md$/i, '');
  return `# ${name}\n\n`;
}

// 作成 / 移動のあと、そのファイルを開き直す。
// hash が変わらない場合は hashchange が飛ばないので自分で handleRoute を呼ぶ。
function goToPath(path, preferTab) {
  const hash = docHashForPath(path, preferTab);
  if (location.hash === `#${hash}`) {
    renderSidebar();
    handleRoute();
  } else {
    location.hash = hash;
  }
}

async function createFile() {
  const input = prompt('新しいファイルのパス（プロジェクトルートからの相対パス）', newFileBasePath());
  if (input === null) return;
  const target = normalizeInputPath(input);
  if (!target) return;
  // 作成後にどのタブで開くかは、押した時点のタブを基準にする
  const preferTab = activeCategory;
  try {
    const res = await fetch(sourceUrl(target), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: initialContentFor(target) }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || '作成に失敗しました');
    docsTree = await fetchAllTrees();
    // 作ったばかりのファイルはプレビューしても空なので、編集で開く
    docState.mode = 'edit';
    goToPath(json.data.path, preferTab);
    showToast('作成しました');
  } catch (err) {
    alert(`作成に失敗しました: ${err.message}`);
  }
}

async function renameDoc() {
  if (!docState.path) return;
  // 移動すると開き直しになるので、未保存のまま走らせない
  if (isDocDirty()) {
    alert('未保存の変更があります。保存するか破棄してから実行してください');
    return;
  }
  const input = prompt('新しいパス（プロジェクトルートからの相対パス）', docState.path);
  if (input === null) return;
  const target = normalizeInputPath(input);
  if (!target || target === docState.path) return;
  const preferTab = docState.tab;
  try {
    const res = await fetch(`/api/move/${encodePath(docState.path)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: target }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'リネームに失敗しました');
    docsTree = await fetchAllTrees();
    // 移動先が元のタブに収まらなければ Files タブで開き直す。
    // 開き直しの中で監視対象（SSE）と親ディレクトリの展開も張り替わる
    goToPath(json.data.path, preferTab);
    showToast('移動しました');
  } catch (err) {
    alert(`リネームに失敗しました: ${err.message}`);
  }
}

async function deleteDoc() {
  if (!docState.path) return;
  if (!confirm(`${docState.path} を削除します。取り消せません。よろしいですか？`)) return;
  try {
    const res = await fetch(sourceUrl(docState.path), { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || '削除に失敗しました');
    resetDocState();
    docsTree = await fetchAllTrees();
    renderSidebar();
    // 消したファイルの hash を残さない。履歴を増やさず、hashchange も起こさないので
    // handleRoute は自分で呼ぶ（未保存確認に引っかからないよう state は先に空にしてある）
    history.replaceState(null, '', location.pathname + location.search);
    handleRoute();
    updateConflictIndicators();
    showToast('削除しました');
  } catch (err) {
    alert(`削除に失敗しました: ${err.message}`);
  }
}

function resetDocState() {
  docState.tab = null;
  docState.key = null;
  docState.path = null;
  docState.content = '';
  docState.savedContent = '';
  docState.mtime = 0;
  docState.eol = 'lf';
  docState.readOnly = false;
  docState.readOnlyReason = null;
  docState.conflict = null;
}

// 文書を開く。Files もカテゴリも同じ経路を通る。
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
    else docState.mode = resolveDocMode(docState.mode, hasTaskLines(docState.content));
    // 畳んだ状態は同じファイルの描き直しでは保ち、別のファイルを開いたら捨てる
    if (todoTreeState.path !== path) {
      todoTreeState.path = path;
      todoTreeState.collapsed = new Set();
    }

    pageTitle.textContent = key.split('/').pop();
    topbarSub.textContent = path;
    topbarSub.title = path;
    contentArea.innerHTML = '';
    contentArea.appendChild(buildDocLayout());

    await renderDocBody();
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
    // タスク（- [ ]）を含むファイルだけ「ツリー」を出す
    const modes = hasTaskLines(docState.content) ? ['tree', 'preview', 'edit'] : ['preview', 'edit'];
    for (const m of modes) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'todo-subtab' + (docState.mode === m ? ' active' : '');
      btn.dataset.mode = m;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', docState.mode === m ? 'true' : 'false');
      btn.textContent = DOC_MODE_LABELS[m];
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

  // 読み取り専用（バイナリ等）でも移動と削除はできる（中身に触らないため）
  if (docState.path) {
    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'doc-action';
    renameBtn.textContent = 'リネーム';
    renameBtn.addEventListener('click', renameDoc);
    actions.appendChild(renameBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'doc-action doc-action-danger';
    deleteBtn.textContent = '削除';
    deleteBtn.addEventListener('click', deleteDoc);
    actions.appendChild(deleteBtn);
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
  // ツリー / プレビューの選択は次にタスクを含むファイルを開いたときにも効かせる
  if (mode !== 'edit' && hasTaskLines(docState.content)) saveTodoModePref(mode);
  clearTocObserver();
  contentArea.innerHTML = '';
  contentArea.appendChild(buildDocLayout());
  await renderDocBody();
  updateConflictIndicators();
}

const DOC_MODE_LABELS = { tree: 'ツリー', preview: 'プレビュー', edit: '編集' };

// 現在のモードに合わせて本文を描く
async function renderDocBody() {
  if (docState.mode === 'tree') await renderDocTreeBody();
  else if (docState.mode === 'preview') await renderDocPreviewBody();
  else renderDocEditBody();
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
    rewriteRelativeDocLinks(div);

    const withToc = true;
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


// === TODO ツリー ===
//
// GET /api/todo/<path> が返す木（字下げの親子・状態・メモ・関係）を描く。
// 解釈はすべてサーバ（todo.ts）で済んでいて、ここは DOM を組むだけ。

// 畳んだノードの id。同じファイルを描き直しても保ち、別のファイルを開いたら捨てる（openDoc）
const todoTreeState = { path: null, collapsed: new Set() };

const RELATION_LABELS = {
  depends: { out: '依存', in: '被依存' },
  derived: { out: '派生元', in: '派生先' },
  related: { out: '関連', in: '関連' },
};

const TODO_STATE_LABELS = { open: '未着手', done: '完了', active: '進行中', cancelled: '中止' };

// チップに載せる短い文面（リンクは文字列に、コードの記号は落とす）
function shortText(text, max = 28) {
  const t = String(text)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

async function renderDocTreeBody() {
  const body = document.getElementById('todo-body');
  if (!body) return;
  body.innerHTML = '<div class="loading-text">読み込み中...</div>';
  try {
    const data = await fetchJson(todoUrl(docState.path));
    if (typeof data.mtime === 'number') docState.mtime = data.mtime;
    body.innerHTML = '';
    body.appendChild(buildTodoTree(data));
    rewriteRelativeDocLinks(body);
  } catch (err) {
    body.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'error-text';
    div.textContent = err.message;
    body.appendChild(div);
  }
}

function buildTodoTree(data) {
  const byId = new Map();
  const index = (nodes) => {
    for (const n of nodes) {
      byId.set(n.id, n);
      index(n.children);
    }
  };
  for (const sec of data.sections) index(sec.tasks);

  const wrap = document.createElement('div');
  wrap.className = 'todo-tree';

  const summary = document.createElement('div');
  summary.className = 'todo-tree-summary';
  const states = data.states || {};
  const counts = [`タスク ${data.count}`];
  if (states.done) counts.push(`完了 ${states.done}`);
  if (states.active) counts.push(`進行中 ${states.active}`);
  if (states.cancelled) counts.push(`中止 ${states.cancelled}`);
  const countEl = document.createElement('span');
  countEl.textContent = counts.join(' / ');
  summary.appendChild(countEl);

  const expandAll = document.createElement('button');
  expandAll.type = 'button';
  expandAll.textContent = 'すべて開く';
  expandAll.addEventListener('click', () => {
    todoTreeState.collapsed.clear();
    wrap.querySelectorAll('.todo-node.collapsed').forEach(el => el.classList.remove('collapsed'));
  });
  summary.appendChild(expandAll);

  const collapseAll = document.createElement('button');
  collapseAll.type = 'button';
  collapseAll.textContent = 'すべて閉じる';
  collapseAll.addEventListener('click', () => {
    wrap.querySelectorAll('.todo-node[data-has-children="1"]').forEach(el => {
      el.classList.add('collapsed');
      todoTreeState.collapsed.add(el.dataset.taskId);
    });
  });
  summary.appendChild(collapseAll);
  wrap.appendChild(summary);

  if (!data.count) {
    const empty = document.createElement('div');
    empty.className = 'todo-tree-empty';
    empty.textContent = 'タスク（- [ ] の行）がありません';
    wrap.appendChild(empty);
    return wrap;
  }

  for (const sec of data.sections) {
    if (sec.heading) {
      const h = document.createElement('div');
      h.className = `todo-tree-heading level-${Math.min(sec.level || 2, 3)}`;
      const title = document.createElement('span');
      title.textContent = sec.heading;
      h.appendChild(title);
      let total = 0;
      let done = 0;
      for (const t of sec.tasks) {
        total += 1 + t.total;
        done += (t.state === 'done' ? 1 : 0) + t.done;
      }
      const c = document.createElement('span');
      c.className = 'todo-tree-count';
      c.textContent = `${done} / ${total}`;
      c.title = '完了 / 全体';
      h.appendChild(c);
      wrap.appendChild(h);
    }
    for (const t of sec.tasks) wrap.appendChild(buildTodoNode(t, byId));
  }
  return wrap;
}

function buildTodoNode(node, byId) {
  const el = document.createElement('div');
  el.className = `todo-node ${node.state}`;
  el.dataset.taskId = node.id;
  el.dataset.hasChildren = node.children.length > 0 ? '1' : '0';
  if (node.children.length > 0 && todoTreeState.collapsed.has(node.id)) el.classList.add('collapsed');

  const row = document.createElement('div');
  row.className = 'todo-node-row';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'todo-toggle' + (node.children.length > 0 ? '' : ' leaf');
  toggle.title = '子を畳む / 開く';
  toggle.setAttribute('aria-label', '子を畳む / 開く');
  toggle.addEventListener('click', () => {
    const collapsed = el.classList.toggle('collapsed');
    if (collapsed) todoTreeState.collapsed.add(node.id);
    else todoTreeState.collapsed.delete(node.id);
  });
  row.appendChild(toggle);

  const mark = document.createElement('span');
  mark.className = `todo-mark ${node.state}`;
  mark.title = TODO_STATE_LABELS[node.state] || node.state;
  // 知らない記号（`[?]` など）は未着手扱いだが、記号は見せる
  if (node.state === 'open' && node.mark !== ' ') mark.textContent = node.mark;
  row.appendChild(mark);

  const text = document.createElement('div');
  text.className = 'todo-text';
  const html = document.createElement('span');
  html.innerHTML = node.html;
  text.appendChild(html);
  if (node.children.length > 0) {
    const progress = document.createElement('span');
    progress.className = 'todo-progress';
    progress.textContent = `${node.done}/${node.total}`;
    progress.title = '子孫の 完了 / 全体';
    text.appendChild(progress);
  }
  const chips = buildTodoChips(node, byId);
  if (chips) text.appendChild(chips);
  row.appendChild(text);
  el.appendChild(row);

  if (node.notes.length > 0) {
    const details = document.createElement('details');
    details.className = 'todo-node-notes';
    const sum = document.createElement('summary');
    sum.textContent = `メモ ${node.notes.length} 件`;
    details.appendChild(sum);
    node.notesHtml.forEach((h) => {
      const line = document.createElement('div');
      line.className = 'todo-note';
      line.innerHTML = h;
      details.appendChild(line);
    });
    el.appendChild(details);
  }

  if (node.children.length > 0) {
    const kids = document.createElement('div');
    kids.className = 'todo-node-children';
    for (const c of node.children) kids.appendChild(buildTodoNode(c, byId));
    el.appendChild(kids);
  }
  return el;
}

// タスクの右に出す関係のチップ。
//   - 関係行（依存: / 派生元: / 関連:）に書かれた相手のタスク → クリックでそこへ
//   - 相手側に書かれている関係（逆方向）→ 点線のチップ
//   - 関係行やメモに書かれたドキュメント → そのドキュメントのタブへ
// タスクの行そのものにあるリンク（`[plan](…)`）は本文の中でリンクのまま出るので、二重には出さない
function buildTodoChips(node, byId) {
  const chips = document.createElement('span');
  chips.className = 'todo-chips';

  for (const ref of node.refs) {
    const label = RELATION_LABELS[ref.kind] ? RELATION_LABELS[ref.kind].out : ref.kind;
    const target = ref.taskId ? byId.get(ref.taskId) : null;
    chips.appendChild(taskChip(`${label}: ${shortText(target ? target.text : ref.text)}`, ref.kind, false, target, ref));
  }
  for (const inb of node.inbound) {
    const source = byId.get(inb.taskId);
    if (!source) continue;
    const label = RELATION_LABELS[inb.kind] ? RELATION_LABELS[inb.kind].in : inb.kind;
    chips.appendChild(taskChip(`${label}: ${shortText(source.text)}`, inb.kind, true, source, null));
  }
  for (const doc of node.docs) {
    if (doc.source === 'text') continue;
    const kindLabel = doc.kind && RELATION_LABELS[doc.kind] ? `${RELATION_LABELS[doc.kind].out}: ` : '';
    const chip = document.createElement('a');
    chip.className = 'todo-chip todo-chip-doc';
    chip.textContent = `${kindLabel}${doc.label}`;
    if (doc.path && doc.exists) {
      chip.href = `#${docHashForPath(doc.path, docState.tab)}`;
      chip.title = doc.path;
    } else {
      chip.classList.add('missing');
      chip.title = doc.path ? `見つかりません: ${doc.path}` : `root の外を指しています: ${doc.href}`;
    }
    chips.appendChild(chip);
  }
  return chips.childNodes.length > 0 ? chips : null;
}

function taskChip(text, kind, inbound, target, ref) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `todo-chip todo-chip-${kind}` + (inbound ? ' todo-chip-in' : '');
  chip.textContent = text;
  if (target) {
    chip.title = target.text;
    chip.addEventListener('click', () => focusTodoTask(target.id));
  } else {
    chip.classList.add('unresolved');
    chip.setAttribute('aria-disabled', 'true');
    chip.title = ref && ref.ambiguous
      ? `候補が複数あって決められません: ${ref.text}`
      : `このファイルの中に見つかりません: ${ref ? ref.text : ''}`;
  }
  return chip;
}

// 相手のタスクへスクロールして光らせる。畳まれた親は開く
function focusTodoTask(id) {
  const el = document.querySelector(`.todo-node[data-task-id="${CSS.escape(id)}"]`);
  if (!el) return;
  let p = el.parentElement;
  while (p) {
    if (p.classList && p.classList.contains('todo-node') && p.classList.contains('collapsed')) {
      p.classList.remove('collapsed');
      todoTreeState.collapsed.delete(p.dataset.taskId);
    }
    p = p.parentElement;
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  // 続けて同じ相手を押しても光るよう、一度外してから付け直す
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  clearTimeout(el._flashTimer);
  el._flashTimer = setTimeout(() => el.classList.remove('flash'), 1500);
}

const READ_ONLY_REASONS = {
  binary: 'バイナリのため編集できません（テキストとして読めない内容です）',
  'too-large': 'サイズが上限を超えているため編集できません',
  symlink: 'シンボリックリンクのため編集できません',
};

// 画像はバイナリでも中身を見せる（/files で配信しているものをそのまま表示。Markdown 内の画像と同じ経路）
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
function isImagePath(p) {
  return IMAGE_EXT_RE.test(String(p || ''));
}
function filesUrl(p) {
  return '/files/' + String(p || '').split('/').map(encodeURIComponent).join('/');
}
function renderImagePreview(body, p) {
  if (!isImagePath(p)) return false;
  const box = document.createElement('div');
  box.className = 'doc-image-box';
  const img = document.createElement('img');
  img.className = 'doc-image';
  img.src = filesUrl(p);
  img.alt = p;
  const cap = document.createElement('div');
  cap.className = 'doc-image-cap';
  cap.textContent = p;
  img.addEventListener('load', () => { cap.textContent = `${p} · ${img.naturalWidth} × ${img.naturalHeight}`; });
  img.addEventListener('error', () => { cap.textContent = `${p} · 読み込めませんでした`; });
  box.append(img, cap);
  body.appendChild(box);
  return true;
}

function renderDocEditBody() {
  const body = document.getElementById('todo-body');
  if (!body) return;
  body.innerHTML = '';

  if (docState.readOnly) {
    if (docState.readOnlyReason === 'binary' && renderImagePreview(body, docState.path)) return;
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
    await renderDocBody();
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
    refreshDocsTree();
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
  topbarSub.title = topbarSub.textContent;

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
  topbarSub.title = '';
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

  // 旧 Root タブ（#todo/<name>）は Files タブへ読み替える（Root は廃止。Files が同じ文書ビューアで開く）
  if (rawHash.startsWith(`${LEGACY_ROOT_TAB}/`)) {
    location.replace(`#${FILES_TAB}/${rawHash.slice(LEGACY_ROOT_TAB.length + 1)}`);
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

  if (category === TASKS_TAB) {
    // Tasks: filePath はタスク id。空なら一覧だけ描き、先頭のタスクへ自動遷移する
    setWatchTarget(TASKS_TODO_PATH);
    if (!filePath) {
      renderSidebar();
      showEmpty();
      return;
    }
    if (needSidebarRerender) renderSidebar();
    // 閉じた枝の中のタスクへ飛んだ（関係チップなど）ときは描き直して枝を開く
    else if (tasksState.tree && !sidebarNav.querySelector(`.tasks-item[data-path="${CSS.escape(filePath)}"]`)) paintTasksSidebar(tasksState);
    else refreshActiveHighlight();
    renderTaskView(filePath);
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

// 固定タブ（Tasks / Files）と設定された categories / customTabs から topbar の tab ボタンを動的に組み立てる
function buildTabs() {
  topbarTabs.innerHTML = '';
  const tabs = [
    ...CUSTOM_TABS.map(t => ({ name: t.name, label: t.label })),
    { name: TASKS_TAB, label: TASKS_LABEL },
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
        // Tasks タブを開いているときの TODO.md の変更は、一覧と詳細の描き直しに使う
        if (activeCategory === TASKS_TAB && payload.path === TASKS_TODO_PATH) {
          refreshTasksTab();
          return;
        }
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

  if (docState.mode === 'preview' || docState.mode === 'tree') {
    // 描き直すだけでなく生も取り直す。描き直しだけだと mtime だけ新しくなり、
    // 編集へ切り替えたとき古い本文に新しい mtime が付いて外部の変更を黙って上書きしてしまう
    await reloadEditFromExternal({ notify: false });
    flashExternalUpdateBadge();
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
    // 外部の変更でタスクの有無が変わることもあるので、サブタブごと組み直す
    contentArea.innerHTML = '';
    contentArea.appendChild(buildDocLayout());
    await renderDocBody();
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

// === Tasks タブ（TODO.md のタスクを、このプロジェクトで動いている Claude Code のセッションへ渡す） ===
//
// サイドバー = TODO.md のタスク一覧（GET /api/todo/TODO.md。ツリーと同じ解釈）。
// 詳細 = 部分木・送り先（セッション / listen）・実行 / 説明 / 削除・投函の状態。
// 実行・説明は POST /api/tasks/run。送り先がセッションならサーバがその受信口へ投函し（キューに積む）、
// listen なら待ち受け（inbox）へ渡す。削除は POST /api/tasks/delete で、サーバが TODO.md から部分木の行だけを外す。
// **文面はサーバが組む**。ここから送るのは id と決め打ちの種別、それに「追加の指示」の本文だけ。

const TASKS_TODO_PATH = 'TODO.md';
const tasksState = { tree: null, error: null };
// 「追加の指示」の打ちかけ。TODO.md が外で変わると画面を描き直すので、タスクの id ごとに覚えて戻す
const TASK_NOTE_MAX = 4000;
const taskNoteDrafts = new Map();

async function fetchTasksTree() {
  try {
    tasksState.tree = await fetchJson(`/api/todo/${encodePath(TASKS_TODO_PATH)}`);
    tasksState.error = null;
  } catch (err) {
    tasksState.tree = null;
    tasksState.error = err && err.message ? err.message : String(err);
  }
  return tasksState;
}

// 木を上から順に平らに（親の文面の列つき）
function flattenTasks(tree) {
  const out = [];
  const walk = (nodes, parents) => {
    for (const n of nodes) {
      out.push({ node: n, parents });
      walk(n.children, [...parents, n.text]);
    }
  };
  for (const s of (tree && tree.sections) || []) walk(s.tasks, []);
  return out;
}

function findTaskEntry(tree, id) {
  return flattenTasks(tree).find(e => e.node.id === id) || null;
}

function renderTaskSubtree(node) {
  const base = node.depth;
  const lines = [];
  const walk = n => {
    const pad = '  '.repeat(n.depth - base);
    lines.push(`${pad}- [${n.mark}] ${n.text}`);
    for (const note of n.notes) lines.push(`${pad}  ${note}`);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return lines.join('\n');
}

// 左ペインは折り畳みツリー。親だけ並べ、▸ で開く。開いた親 / 手で閉じた親を覚え、選択した枝は自動で開く。
// 文面は 1 行に切り詰め（全文は title）、親は濃い字、子は縦線で束ねる。済んだタスクは並べない（実行するものではない）。
const STORAGE_TASKS_TREE = 'vibeboard.tasksTree';
const tasksTreeState = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_TASKS_TREE) || 'null');
    return { expanded: new Set((raw && raw.expanded) || []), collapsed: new Set((raw && raw.collapsed) || []), lastSelected: null };
  } catch {
    return { expanded: new Set(), collapsed: new Set(), lastSelected: null };
  }
})();
function saveTasksTreeState() {
  try {
    localStorage.setItem(STORAGE_TASKS_TREE, JSON.stringify({
      expanded: [...tasksTreeState.expanded], collapsed: [...tasksTreeState.collapsed],
    }));
  } catch {
    // 保存できなくても動く
  }
}
// 済んだタスクは出さない。ただし済んでいない子孫を持つ親は、子を辿る足場として残す
const taskVisible = n => n.state !== 'done' || n.total - n.done > 0;
const taskGlyph = n => (n.state === 'active' ? '◐' : n.state === 'cancelled' ? '－' : n.state === 'done' ? '✓' : '○');
function taskAncestorIds(tree, id) {
  const walk = (nodes, trail) => {
    for (const n of nodes) {
      if (n.id === id) return trail;
      const found = walk(n.children, [...trail, n.id]);
      if (found) return found;
    }
    return null;
  };
  for (const s of (tree && tree.sections) || []) {
    const found = walk(s.tasks, []);
    if (found) return found;
  }
  return [];
}
function toggleTaskFold(id, expandedNow) {
  if (expandedNow) {
    tasksTreeState.expanded.delete(id);
    tasksTreeState.collapsed.add(id);
  } else {
    tasksTreeState.expanded.add(id);
    tasksTreeState.collapsed.delete(id);
  }
  saveTasksTreeState();
  paintTasksSidebar(tasksState);
}
// 左ペインの上の「プロジェクト全体」の操作。タスクには紐づかない（id を送らない）。
// 送り先は右の画面の選択（#task-window）を借りる。無ければサーバに任せる（今すぐ送れる先が 1 つならそこへ）
async function sendCommitAndPush(btn) {
  const sel = document.getElementById('task-window');
  const target = sel ? parseTargetValue(sel.value) : null;
  const targetName = sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : '';
  btn.disabled = true;
  try {
    const body = { kind: 'commit' };
    if (target && target.kind === 'listen') body.windowId = target.id;
    else if (target && target.kind === 'session') body.sessionId = target.id;
    const data = await postTasks('/api/tasks/run', body);
    const name = targetName || String(data.routedTo || '').slice(0, 8);
    if (data.item) {
      if (data.item.state === 'posted') showToast(`「${name}」に commit & push を頼みました。そのセッションの画面を見てください。`, 4000);
      else if (data.item.state === 'waiting') showToast(`「${name}」は未登録なので待ちに積みました（5 分で失敗にします）。`, 4000);
      else showToast(`「${name}」への投函に失敗しました: ${data.item.error || ''}`, 5000);
    } else if (data.routedTo) {
      showToast(data.connected ? `「${data.routedTo}」に commit & push を頼みました。` : `「${data.routedTo}」あてに溜めました（つながったら届きます）。`, 4000);
    } else if (Array.isArray(data.targets) && data.targets.length > 1) {
      showToast('送り先が複数あります。右の画面で送り先を選んでからにしてください。', 4000);
    } else {
      showToast('送り先がありません。このプロジェクトで Claude Code を起動してください。', 4000);
    }
  } catch (err) {
    showToast(`受け渡しに失敗しました: ${err.message}`, 5000);
  } finally {
    btn.disabled = false;
  }
}
function renderTasksGlobalBar() {
  const wrap = document.createElement('div');
  wrap.className = 'tasks-global-wrap';
  const bar = document.createElement('div');
  bar.className = 'tasks-global';
  const label = document.createElement('span');
  label.className = 'tasks-global-label';
  label.textContent = 'プロジェクト全体';
  const btns = document.createElement('span');
  btns.className = 'tasks-global-btns';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'tasks-global-btn';
  addBtn.textContent = 'タスク追加';
  addBtn.title = 'バックグラウンドの Claude Code に頼んで、TODO.md にタスクを 1 件追加する（このセッションには投函しない）';
  addBtn.hidden = addTaskAvailable === false;
  addBtn.addEventListener('click', () => showAddTaskDialog(null, () => refreshJobs()));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tasks-global-btn';
  btn.textContent = 'commit & push';
  btn.title = '作業ツリーの変更をまとめてコミットして push するよう、送り先のセッションに頼む（タスクとは無関係）';
  btn.addEventListener('click', () => sendCommitAndPush(btn));
  btns.append(addBtn, btn);
  bar.append(label, btns);
  wrap.appendChild(bar);

  // ジョブの状態。この欄が生きている間だけ 5 秒おきに取り直す（再描画で古い欄が消えたら止まる）
  const jobsBox = document.createElement('div');
  jobsBox.className = 'task-queue task-add-jobs';
  jobsBox.hidden = true;
  wrap.appendChild(jobsBox);
  const refreshJobs = async () => {
    let items;
    try {
      items = await fetchAddJobs();
    } catch {
      return;
    }
    addBtn.hidden = addTaskAvailable === false;
    renderAddJobs(jobsBox, items, refreshJobs);
  };
  refreshJobs();
  const timer = setInterval(() => {
    if (!document.body.contains(wrap)) {
      clearInterval(timer);
      return;
    }
    if (document.hidden) return;
    refreshJobs();
  }, 5000);
  return wrap;
}
function paintTasksSidebar(state) {
  sidebarNav.innerHTML = '';
  sidebarNav.appendChild(renderTasksGlobalBar());
  if (state.error) {
    const el = document.createElement('div');
    el.className = 'error-text';
    el.textContent = state.error;
    sidebarNav.appendChild(el);
    return null;
  }
  const entries = flattenTasks(state.tree).filter(e => e.node.state !== 'done');
  if (entries.length === 0) {
    const el = document.createElement('div');
    el.className = 'loading-text';
    el.textContent = 'タスク（- [ ] の行）がありません';
    sidebarNav.appendChild(el);
    return null;
  }
  const parsed = parseHash();
  const selectedId = parsed && parsed.category === TASKS_TAB ? parsed.filePath : null;
  const ancestors = new Set(selectedId ? taskAncestorIds(state.tree, selectedId) : []);
  // 選択が変わったときだけ、その枝を開く（同じ選択のまま手で閉じたものは閉じたままにする）
  if (selectedId !== tasksTreeState.lastSelected) {
    for (const id of ancestors) tasksTreeState.collapsed.delete(id);
    tasksTreeState.lastSelected = selectedId;
  }
  const isExpanded = id => (tasksTreeState.expanded.has(id) || ancestors.has(id)) && !tasksTreeState.collapsed.has(id);

  const renderList = (nodes, depth) => {
    const ul = document.createElement('ul');
    ul.className = depth === 0 ? 'tasks-tree' : 'tasks-branch';
    for (const node of nodes) {
      if (!taskVisible(node)) continue;
      const kids = node.children.filter(taskVisible);
      const expanded = kids.length > 0 && isExpanded(node.id);
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = 'nav-item tasks-item'
        + (depth === 0 ? ' tasks-top' : '')
        + (node.state === 'active' ? ' tasks-active' : node.state === 'cancelled' ? ' tasks-cancelled' : '')
        + (ancestors.has(node.id) ? ' tasks-has-active' : '');
      a.href = `#${TASKS_TAB}/${encodeURIComponent(node.id)}`;
      a.dataset.category = TASKS_TAB;
      a.dataset.path = node.id;
      a.title = node.text;
      const lead = document.createElement('span');
      if (kids.length > 0) {
        lead.className = 'tasks-chev';
        lead.textContent = expanded ? '▾' : '▸';
        lead.title = expanded ? '閉じる' : '開く';
        lead.setAttribute('role', 'button');
        lead.tabIndex = 0;
        const toggle = e => { e.preventDefault(); e.stopPropagation(); toggleTaskFold(node.id, expanded); };
        lead.addEventListener('click', toggle);
        lead.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') toggle(e); });
      } else {
        lead.className = 'tasks-st';
        lead.textContent = taskGlyph(node);
      }
      const text = document.createElement('span');
      text.className = 'tasks-text';
      text.textContent = (kids.length > 0 ? `${taskGlyph(node)} ` : '') + node.text;
      a.append(lead, text);
      if (kids.length > 0) {
        const chip = document.createElement('span');
        chip.className = 'tasks-chip';
        chip.textContent = `${node.done}/${node.total}`;
        chip.title = `子孫 ${node.total} 件のうち ${node.done} 件が済み`;
        a.appendChild(chip);
      }
      li.appendChild(a);
      if (expanded) li.appendChild(renderList(kids, depth + 1));
      ul.appendChild(li);
    }
    return ul;
  };

  const frag = document.createDocumentFragment();
  for (const s of state.tree.sections) {
    if (!s.tasks.some(taskVisible)) continue;
    if (s.heading) {
      const h = document.createElement('div');
      h.className = 'nav-group-header';
      h.textContent = s.heading;
      frag.appendChild(h);
    }
    frag.appendChild(renderList(s.tasks, 0));
  }
  sidebarNav.appendChild(frag);
  refreshActiveHighlight();
  return entries;
}
async function renderTasksSidebar() {
  sidebarNav.innerHTML = '<div class="loading-text">読み込み中...</div>';
  const state = await fetchTasksTree();
  if (activeCategory !== TASKS_TAB) return;
  const entries = paintTasksSidebar(state);
  if (!entries) return;

  // 未選択なら先頭のタスクへ（customTab と同じ振る舞い。空ペインを見せない）
  const parsed = parseHash();
  const selected = !!(parsed && parsed.category === TASKS_TAB && parsed.filePath);
  if (!selected) location.replace(`#${TASKS_TAB}/${encodeURIComponent(entries[0].node.id)}`);
}

// TODO.md が外で変わったら一覧と詳細を描き直す（SSE の change から呼ばれる）
function refreshTasksTab() {
  tasksState.tree = null;
  renderTasksSidebar();
  const parsed = parseHash();
  if (parsed && parsed.category === TASKS_TAB && parsed.filePath) renderTaskView(parsed.filePath);
}

async function postTasks(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error || '失敗しました');
  return json.data;
}

function mkEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const TASK_STATUS_LABEL = {
  busy: '実行中', working: '実行中', idle: '待機中', blocked: '承認待ち', listening: 'listen', unknown: '状態不明',
};
function describeTarget(t) {
  if (t.kind === 'listen') return `${t.name}（listen）`;
  const parts = [TASK_STATUS_LABEL[t.status] || t.status];
  if (t.sessionKind === 'background') parts.push('background');
  parts.push(t.registered ? '登録済み' : '未登録');
  if (t.cwd && t.cwd !== '.') parts.push(t.cwd);
  return `${t.name}（${parts.join('・')}）`;
}
function targetValue(t) { return `${t.kind}:${t.id}`; }
function parseTargetValue(v) {
  const m = /^(session|listen):(.+)$/.exec(v || '');
  return m ? { kind: m[1], id: m[2] } : null;
}

// 送り先の一覧（GET /api/tasks/windows = claude agents ＋ hook の登録 ＋ listen）。呼び出し側が 5 秒おきに取り直す
async function loadTaskTargets(sel, note) {
  const prev = sel.value;
  let data;
  try {
    data = await fetchJson('/api/tasks/windows');
  } catch {
    return null; // 取れなければ前の選択のまま
  }
  const targets = Array.isArray(data.targets) ? data.targets : [];
  sel.innerHTML = '';
  if (targets.length === 0) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '(このプロジェクトで動いている Claude Code のセッションがありません)';
    sel.appendChild(o);
  }
  for (const t of targets) {
    const o = document.createElement('option');
    o.value = targetValue(t);
    o.textContent = describeTarget(t);
    if (t.kind === 'session' && !t.registered) o.title = 'hook を入れる前に起動したセッション。起動し直すと登録されます';
    sel.appendChild(o);
  }
  const values = targets.map(targetValue);
  if (values.includes(prev)) {
    sel.value = prev;
  } else {
    // 既定は「登録済みで待機中のセッション」→ 登録済み → listen → 先頭
    const pick = targets.find(t => t.kind === 'session' && t.registered && t.status === 'idle')
      || targets.find(t => t.kind === 'session' && t.registered)
      || targets.find(t => t.kind === 'listen')
      || targets[0];
    if (pick) sel.value = targetValue(pick);
  }
  const msgs = [];
  if (data.hooksInstalled === false) {
    msgs.push('このプロジェクトに vibeboard の hook が入っていません。node vibeboard/dist/cli.js init --root . を流すと、以後に起動したセッションが自動で登録されます。');
  }
  if (targets.some(t => t.kind === 'session' && !t.registered)) {
    msgs.push('「未登録」は hook を入れる前に起動したセッションです。起動し直すか、その画面で vibeboard listen を回してください。');
  }
  if (data.agents && data.agents.ok === false && data.agents.error) {
    msgs.push(`claude agents が読めません（${data.agents.error}）。hook が登録したセッションだけを出しています。`);
  }
  note.textContent = msgs.join(' ');
  note.hidden = msgs.length === 0;
  return targets;
}

const QUEUE_STATE_LABEL = { waiting: '待ち', posted: '投函済み', failed: '失敗' };
const QUEUE_KIND_LABEL = { run: '実行', explain: '説明', plan: 'プラン作成', commit: 'commit & push' };
function fmtClock(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 投函の状態（GET /api/tasks/queue）。待ち / 投函済み / 失敗。失敗には再送、済んだものには消す
async function renderTaskQueue(box, targetsById, onChange) {
  let items;
  try {
    items = (await fetchJson('/api/tasks/queue')).items || [];
  } catch {
    return;
  }
  box.innerHTML = '';
  if (items.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.appendChild(mkEl('h2', null, '投函の状態'));
  for (const it of [...items].sort((a, b) => b.at - a.at)) {
    const row = mkEl('div', 'task-queue-item');
    row.appendChild(mkEl('span', `task-queue-state ${it.state}`, QUEUE_STATE_LABEL[it.state] || it.state));
    const t = targetsById.get(it.sessionId);
    const who = t ? t.name : String(it.sessionId || '').slice(0, 8);
    row.appendChild(mkEl('span', 'task-queue-text', `${QUEUE_KIND_LABEL[it.kind] || it.kind}: ${it.text} → ${who}`));
    row.appendChild(mkEl('span', 'task-queue-time', fmtClock(it.updatedAt)));
    if (it.state === 'failed') {
      const b = mkEl('button', null, '再送');
      b.type = 'button';
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await postTasks('/api/tasks/retry', { queueId: it.id });
        } catch (err) {
          showToast(`再送に失敗しました: ${err.message}`);
        }
        onChange();
      });
      row.appendChild(b);
    }
    if (it.state !== 'waiting') {
      const b = mkEl('button', null, '消す');
      b.type = 'button';
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await postTasks('/api/tasks/dismiss', { queueId: it.id });
        } catch {
          // 既に無ければそれでよい
        }
        onChange();
      });
      row.appendChild(b);
    }
    if (it.error) row.appendChild(mkEl('div', 'task-queue-err', it.error));
    box.appendChild(row);
  }
}

// --- タスク追加（バックグラウンドの claude -p）。⚠ 投函（queue）とは別系統で、並行して動く ---
// サーバがヘッドレスの Claude Code を起こして TODO.md を編集させる。反映は TODO.md の
// 変更を既存の watch/SSE が拾うので、ここでは状態（待ち / 実行中 / 追加した / 失敗）だけ出す。
let addTaskAvailable = null; // null = 未確認（claude が PATH に居るか。サーバが 1 回だけ引く）
// 完了の通知用: 前回見た状態（ジョブ id → state）。待ち / 実行中だったものが done になったら 1 回だけトースト
const addJobsSeen = new Map();
function notifyAddJobDone(items) {
  for (const it of items) {
    const prev = addJobsSeen.get(it.id);
    if (it.state === 'done' && prev && prev !== 'done') {
      showToast(`追加しました: ${it.text}`, 3000);
    }
    addJobsSeen.set(it.id, it.state);
  }
}
async function fetchAddJobs() {
  const data = await fetchJson('/api/tasks/add-jobs');
  addTaskAvailable = !!data.available;
  const items = Array.isArray(data.items) ? data.items : [];
  notifyAddJobDone(items);
  return items;
}
// ⚠ 出すのは「動いているもの」と「失敗」だけ。成功は出さない（ツリーの更新が結果そのもので、
// 完了はトースト 1 回で知らせる）。何件実行しても欄が伸びていかないように、実行中 / 待ちは 1 行に集約する
function renderAddJobs(box, items, onChange) {
  box.innerHTML = '';
  const active = items.filter(j => j.state === 'waiting' || j.state === 'running');
  const failed = items.filter(j => j.state === 'failed');
  if (active.length === 0 && failed.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (active.length > 0) {
    const head = active.find(j => j.state === 'running') || active[0];
    const rest = active.length - 1;
    const row = mkEl('div', 'task-add-line');
    row.appendChild(mkEl('span', `task-queue-state ${head.state === 'running' ? 'running' : 'waiting'}`,
      head.state === 'running' ? '追加中' : '待ち'));
    row.appendChild(mkEl('span', 'task-add-line-text',
      `${head.text}${rest > 0 ? `（ほか ${rest} 件待ち）` : ''}`));
    row.title = head.parentText ? `「${head.parentText}」の子に追加` : 'トップレベルに追加';
    box.appendChild(row);
  }
  for (const it of failed) {
    const row = mkEl('div', 'task-add-line');
    row.appendChild(mkEl('span', 'task-queue-state failed', '失敗'));
    row.appendChild(mkEl('span', 'task-add-line-text', it.text));
    if (it.error) row.title = it.error; // 詳細はツールチップで
    const retry = mkEl('button', null, 'やり直す');
    const dism = mkEl('button', null, '消す');
    for (const b of [retry, dism]) b.type = 'button';
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      try {
        await postTasks('/api/tasks/add-retry', { jobId: it.id });
      } catch (err) {
        showToast(`やり直しに失敗しました: ${err.message}`);
      }
      onChange();
    });
    dism.addEventListener('click', async () => {
      dism.disabled = true;
      try {
        await postTasks('/api/tasks/add-dismiss', { jobId: it.id });
      } catch {
        // 既に無ければそれでよい
      }
      onChange();
    });
    row.append(retry, dism);
    box.appendChild(row);
  }
}
async function submitAddTask(text, parentId) {
  const body = { text };
  if (parentId) body.parentId = parentId;
  const data = await postTasks('/api/tasks/add', body);
  return data.item;
}

// タスク追加のダイアログ。⚠ トップレベル（parent = null）と子タスク追加（parent = { id, text }）で共通。
// 既存のモーダル（409 競合・差分と同じ .modal-overlay / .modal）に載せる。
// モーダルは body 直下なのでツリーの SSE 再描画の影響を受けない。下書きは誤って閉じたときのために親単位で残す
const addTaskDialogDrafts = new Map(); // parentId（トップレベルは ''）→ 文面
function showAddTaskDialog(parent, onDone) {
  const key = parent ? parent.id : '';
  const overlay = mkEl('div', 'modal-overlay');
  const modal = mkEl('div', 'modal');
  modal.appendChild(mkEl('div', 'modal-title', parent ? `子タスク追加: 「${parent.text}」` : 'タスク追加'));

  const body = mkEl('div', 'modal-body');
  const input = mkEl('textarea', 'task-compose-input modal-add-input');
  input.rows = 5;
  input.maxLength = TASK_NOTE_MAX;
  input.placeholder = parent
    ? '1 行目: 子タスクの文面（そのまま TODO.md に入る）\n2 行目以降: 付けるメモ（任意。Ctrl+Enter で追加）'
    : '1 行目: タスクの文面（そのまま TODO.md に入る）\n2 行目以降: タスクに付けるメモ（任意。Ctrl+Enter で追加）';
  input.value = addTaskDialogDrafts.get(key) || '';
  input.addEventListener('input', () => {
    if (input.value.trim()) addTaskDialogDrafts.set(key, input.value);
    else addTaskDialogDrafts.delete(key);
  });
  const note = mkEl('div', 'task-add-note', parent
    ? 'バックグラウンドの Claude Code が、このタスクの子の末尾に足します（反映されるとツリーが更新されます）'
    : 'バックグラウンドの Claude Code が置き場所を判断して TODO.md に足します（反映されるとツリーが更新されます）');
  body.append(input, note);
  modal.appendChild(body);

  const actions = mkEl('div', 'modal-actions');
  const cancel = mkEl('button', 'modal-btn', 'やめる');
  const submit = mkEl('button', 'modal-btn modal-btn-primary', '追加する');
  for (const b of [cancel, submit]) b.type = 'button';
  actions.append(cancel, submit);
  modal.appendChild(actions);
  overlay.appendChild(modal);

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  // Esc で閉じる。⚠ 外側クリックでは閉じない（入力途中の誤クリックで文面が消えるのを避ける）
  const onKey = ev => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  cancel.addEventListener('click', close);
  const doSubmit = async () => {
    const text = input.value.trim();
    if (!text) {
      showToast('タスクの文面を書いてください');
      return;
    }
    submit.disabled = true;
    try {
      await submitAddTask(text, parent ? parent.id : null);
      addTaskDialogDrafts.delete(key);
      close();
      showToast('バックグラウンドの Claude Code に頼みました（状態は「タスク追加の状態」に出ます）', 3000);
      if (onDone) onDone();
    } catch (err) {
      showToast(`頼めませんでした: ${err.message}`, 5000);
      submit.disabled = false;
    }
  };
  submit.addEventListener('click', doSubmit);
  input.addEventListener('keydown', ev => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      doSubmit();
    }
  });
  document.body.appendChild(overlay);
  input.focus();
}

async function renderTaskView(id) {
  clearTocObserver();
  const state = tasksState.tree ? tasksState : await fetchTasksTree();
  if (activeCategory !== TASKS_TAB) return;
  const entry = state.tree ? findTaskEntry(state.tree, id) : null;
  if (!entry) {
    showError(state.error || 'そのタスクは TODO.md にありません');
    return;
  }
  const { node, parents } = entry;
  pageTitle.textContent = TASKS_LABEL;
  // ⚠ タスクの文面は topbar に出さない（本文の h1 に出ている。長い文面が最上部を占領していた。
  //   利用者の指示 2026-09-11「この右上の部分は不要なので削除して」）
  topbarSub.textContent = '';
  topbarSub.title = '';

  const el = mkEl;
  const pane = el('div', 'task-pane');
  pane.appendChild(el('h1', 'task-title', node.text));
  pane.appendChild(el('div', 'task-meta', [
    node.heading || '',
    parents.length > 0 ? `親: ${parents.join(' › ')}` : '',
    node.id,
  ].filter(Boolean).join(' ／ ')));
  pane.appendChild(el('pre', 'task-subtree', renderTaskSubtree(node)));

  const rowWin = el('div', 'task-row');
  const lbl = el('label', null, '送り先');
  lbl.htmlFor = 'task-window';
  const sel = el('select');
  sel.id = 'task-window';
  const refresh = el('button', null, '更新');
  refresh.type = 'button';
  rowWin.append(lbl, sel, refresh);
  pane.appendChild(rowWin);
  const note = el('div', 'task-note task-targets-note', '');
  note.hidden = true;
  pane.appendChild(note);

  // 「追加の指示」。空欄なら今までと同じ文面が届く（サーバが note を見ない）
  const rowNote = el('div', 'task-compose');
  const noteLbl = el('label', null, '追加の指示（任意）');
  noteLbl.htmlFor = 'task-note-input';
  const noteBox = el('textarea', 'task-compose-input');
  noteBox.id = 'task-note-input';
  noteBox.title = '書いた文面は実行・プラン作成・説明の文面の末尾に足して送る（空欄なら今までどおり）。削除・子タスク追加には効かない';
  noteBox.rows = 3;
  noteBox.maxLength = TASK_NOTE_MAX;
  noteBox.placeholder = '例: Phase 6 だけやって。テストは走らせなくていい\n（空欄なら今までどおりの文面で送ります。Ctrl+Enter で実行）';
  noteBox.value = taskNoteDrafts.get(id) || '';
  noteBox.addEventListener('input', () => {
    if (noteBox.value.trim()) taskNoteDrafts.set(id, noteBox.value);
    else taskNoteDrafts.delete(id);
  });
  noteBox.addEventListener('keydown', ev => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      send('run');
    }
  });
  rowNote.append(noteLbl, noteBox);
  pane.appendChild(rowNote);

  const rowBtn = el('div', 'task-row');
  const btnRun = el('button', 'primary', '実行');
  btnRun.title = 'このタスクを送り先のセッションへ投函して実行させる（会話も承認もそのセッションの画面で進む）';
  const btnPlan = el('button', null, 'プラン作成');
  btnPlan.title = 'docs/plans/ のプランファイルと、TODO.md へのリンク・子タスクだけを作らせる（実装はしない）';
  const btnExplain = el('button', null, '説明');
  btnExplain.title = '何も変更せず、このタスクの意図・進め方・影響を説明させる';
  const btnAddChild = el('button', null, '子タスク追加');
  const btnDelete = el('button', 'danger', '削除');
  btnDelete.title = 'TODO.md からこのタスクを消す（DONE.md には移さない）';
  for (const b of [btnRun, btnPlan, btnExplain, btnAddChild, btnDelete]) b.type = 'button';
  rowBtn.append(btnRun, btnPlan, btnExplain, btnAddChild, btnDelete);
  pane.appendChild(rowBtn);

  // 子タスク追加。⚠ 投函ではなく、バックグラウンドの claude -p に TODO.md を編集させる。
  // 入力はトップレベルの「タスク追加」と共通のダイアログ（showAddTaskDialog）
  btnAddChild.title = 'バックグラウンドの Claude Code に頼んで、このタスクの子タスクを 1 件追加する（このタスクの実行とは無関係）';
  btnAddChild.hidden = addTaskAvailable === false;

  const status = el('div', 'task-note', '');
  // 説明は 3 か所に分ける: 常時見えるのは 1 行だけ、ボタンごとの説明は各ボタンの title、
  // 全文（従来の 6 文そのまま）は「?」で開いたときだけ。情報は捨てない
  const HINT_FULL =
    '実行・プラン作成・説明は送り先のセッションへ投函します（会話も承認もそのセッションの画面で進む。待機中なら新しいターンが始まり、実行中なら合間に読まれる）。'
    + 'プラン作成は docs/plans/ のプランファイルと、TODO.md へのリンク・子タスクだけを作らせます（実装はしない）。'
    + '説明は変更せず内容を説明するだけ。削除は TODO.md からこのタスクを消します（DONE.md には移しません）。'
    + '子タスク追加だけは投函せず、バックグラウンドの Claude Code に TODO.md を編集させます（送り先のセッションは使わない）。'
    + '「追加の指示」に書いた文面は、実行・プラン作成・説明の文面の末尾に足して送ります（空欄なら今までどおり）。削除・子タスク追加には効きません。'
    + '送り先は claude agents の一覧と、起動時の hook（vibeboard init が書く）で登録されたセッション。hook が使えないときは、その画面で vibeboard listen --name <名前> を回すと listen として出ます。';
  const hint = el('div', 'task-note task-hint');
  hint.appendChild(document.createTextNode(
    '実行・プラン作成・説明は選んだセッションへ投函し、子タスク追加はバックグラウンドの Claude Code が処理します。'));
  const hintToggle = el('button', 'task-hint-toggle', '?');
  hintToggle.type = 'button';
  hintToggle.title = '詳しい説明を開く';
  hint.appendChild(hintToggle);
  const hintFull = el('div', 'task-note task-hint-full', HINT_FULL);
  hintFull.hidden = true;
  hintToggle.addEventListener('click', () => {
    hintFull.hidden = !hintFull.hidden;
    hintToggle.title = hintFull.hidden ? '詳しい説明を開く' : '詳しい説明を閉じる';
  });
  const queueBox = el('div', 'task-queue');
  queueBox.hidden = true;
  const addJobsBox = el('div', 'task-queue task-add-jobs');
  addJobsBox.hidden = true;
  pane.append(status, hint, hintFull, queueBox, addJobsBox);

  contentArea.innerHTML = '';
  contentArea.appendChild(pane);

  let targetsById = new Map();
  const refreshAll = async () => {
    const targets = await loadTaskTargets(sel, note);
    if (targets) targetsById = new Map(targets.filter(t => t.kind === 'session').map(t => [t.id, t]));
    renderTaskQueue(queueBox, targetsById, refreshAll);
    // このタスクあての子タスク追加ジョブだけをここに出す（全体は左のプロジェクト全体の欄）
    try {
      const items = (await fetchAddJobs()).filter(j => j.parentId === id);
      btnAddChild.hidden = addTaskAvailable === false;
      renderAddJobs(addJobsBox, items, refreshAll);
    } catch {
      // 取れなければ次の 5 秒で
    }
  };
  refreshAll();
  btnAddChild.addEventListener('click', () => showAddTaskDialog({ id, text: node.text }, refreshAll));
  // この画面を出している間だけ 5 秒おきに取り直す（別のタブへ移ったら止める）
  const timer = setInterval(() => {
    if (!document.body.contains(pane)) {
      clearInterval(timer);
      return;
    }
    if (document.hidden) return;
    refreshAll();
  }, 5000);

  const setBusy = on => { for (const b of [btnRun, btnPlan, btnExplain, btnAddChild, btnDelete]) b.disabled = on; };
  const nameOf = sessionId => (targetsById.get(sessionId) || {}).name || String(sessionId || '').slice(0, 8);
  const send = async kind => {
    const verb = kind === 'explain' ? '説明を頼み' : kind === 'plan' ? 'プラン作成を頼み' : kind === 'commit' ? 'commit & push を頼み' : '渡し';
    const note = noteBox.value.trim();
    const noted = note ? '追加の指示つきで' : '';
    const target = parseTargetValue(sel.value);
    setBusy(true);
    status.textContent = '送っています...';
    try {
      const body = { id, kind };
      if (note) body.note = note;
      if (target && target.kind === 'listen') body.windowId = target.id;
      else if (target && target.kind === 'session') body.sessionId = target.id;
      const data = await postTasks('/api/tasks/run', body);
      if (data.item) {
        const name = nameOf(data.item.sessionId);
        if (data.item.state === 'posted') {
          status.textContent = `「${name}」へ${noted}${verb}ました。そのセッションの画面を見てください。`;
        } else if (data.item.state === 'waiting') {
          status.textContent = `「${name}」は未登録なので待ちに積みました。そのセッションを起動し直す（hook が登録する）と届きます。5 分で失敗にします。`;
        } else {
          status.textContent = `「${name}」への投函に失敗しました: ${data.item.error || ''}`;
        }
      } else if (data.routedTo) {
        status.textContent = data.connected
          ? `「${data.routedTo}」へ${noted}${verb}ました。その画面を見てください。`
          : `「${data.routedTo}」あてに送りました。今つながっていないので、その画面がつながったら届きます。`;
      } else if (Array.isArray(data.targets) && data.targets.length > 1) {
        status.textContent = '送り先を選んでからにしてください。';
      } else {
        status.textContent = '送り先がありません。このプロジェクトで Claude Code を起動してください（hook が無ければ vibeboard init を流すか、その画面で vibeboard listen を回す）。';
      }
    } catch (err) {
      status.textContent = `受け渡しに失敗しました: ${err.message}`;
    } finally {
      setBusy(false);
      refreshAll();
    }
  };
  refresh.addEventListener('click', refreshAll);
  btnRun.addEventListener('click', () => send('run'));
  btnPlan.addEventListener('click', () => send('plan'));
  btnExplain.addEventListener('click', () => send('explain'));
  btnDelete.addEventListener('click', async () => {
    if (!confirm('このタスクを TODO.md から削除します（DONE.md には移しません）。よろしいですか？')) return;
    setBusy(true);
    status.textContent = '削除しています...';
    try {
      await postTasks('/api/tasks/delete', { id });
      showToast('削除しました');
      tasksState.tree = null;
      // 一覧へ戻る（hashchange で一覧を描き直し、先頭のタスクへ自動遷移する）
      location.replace(`#${TASKS_TAB}/`);
    } catch (err) {
      setBusy(false);
      status.textContent = `削除に失敗しました: ${err.message}`;
    }
  });
}

// === customTabs (vibeboard プラグイン) ===

// プラグイン側 /api/sidebar をフェッチしてキャッシュ。失敗は error として記録する。
async function fetchCustomTabSidebar(name) {
  const tab = CUSTOM_TAB_BY_NAME.get(name);
  if (!tab) return { items: [], error: 'unknown tab' };
  try {
    const res = await fetch(`${tab.base}/api/sidebar`, { cache: 'no-store' });
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
  return `${tab.base}/view?item=${encodeURIComponent(itemId)}${t}`;
}

function renderCustomTabView(name, itemId) {
  clearTocObserver();
  const tab = CUSTOM_TAB_BY_NAME.get(name);
  if (!tab) return;
  pageTitle.textContent = tab.label;
  topbarSub.textContent = itemId;
  topbarSub.title = itemId;

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
    es = new EventSource(`${tab.base}/api/watch`);
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
