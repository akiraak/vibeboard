'use strict';

// 編集対象タブ（TODO 系）の URL スラッグ。表示ラベルは設定可能だがスラッグは固定。
const EDITABLE_TAB = 'todo';

// サーバから注入された設定。`__VIBEBOARD__` には categories / editable も含まれる。
const VB_CONFIG = (typeof window !== 'undefined' && window.__VIBEBOARD__) || {};
const CATEGORY_DEFS = Array.isArray(VB_CONFIG.categories) && VB_CONFIG.categories.length > 0
  ? VB_CONFIG.categories
  : [
      { name: 'plans', label: 'Plans', archive: true },
      { name: 'specs', label: 'Specs', archive: false },
    ];
const CATEGORY_BY_NAME = new Map(CATEGORY_DEFS.map(c => [c.name, c]));
const EDITABLE_LABEL = (VB_CONFIG.editable && VB_CONFIG.editable.label) || 'TODO';
const EDITABLE_FILES = (VB_CONFIG.editable && Array.isArray(VB_CONFIG.editable.files) && VB_CONFIG.editable.files.length > 0)
  ? VB_CONFIG.editable.files
  : [{ name: 'TODO.md', label: 'TODO' }, { name: 'DONE.md', label: 'DONE' }];
const EDITABLE_NAMES = EDITABLE_FILES.map(f => f.name);
const EDITABLE_BY_NAME = new Map(EDITABLE_FILES.map(f => [f.name, f]));
const CATEGORIES = [EDITABLE_TAB, ...CATEGORY_DEFS.map(c => c.name)];

const STORAGE_CATEGORY = 'vibeboard.activeCategory';
const STORAGE_EXPANDED = 'vibeboard.expanded';

const sidebarNav = document.getElementById('sidebar-nav');
const contentArea = document.getElementById('content-area');
const pageTitle = document.getElementById('page-title');
const topbarSub = document.getElementById('topbar-sub');
const topbarTabs = document.getElementById('topbar-tabs');

let docsTree = Object.fromEntries(CATEGORY_DEFS.map(c => [c.name, { files: [], dirs: [] }]));
// デフォルトは最初のドキュメントカテゴリ（無ければ編集タブ）
let activeCategory = CATEGORY_DEFS.length > 0 ? CATEGORY_DEFS[0].name : EDITABLE_TAB;
let expanded = {};

// TODO ビューの状態（renderTodoView で更新）
const todoState = {
  name: null,          // 'TODO.md' | 'DONE.md'
  mode: 'preview',     // 'preview' | 'edit'
  content: '',         // textarea 上の現在値
  savedContent: '',    // 直近に取得/保存した内容（isDirty 判定用）
  mtime: 0,            // 楽観ロック用 baseMtime
  conflict: null,      // { mtime: number, barVisible: boolean } | null
};

// SSE 接続状態
const sseState = {
  source: null,
  connected: false,
};

// 現在表示中ドキュメントの TOC アクティブ追従用 IntersectionObserver。
// renderMarkdown / 他カテゴリ表示への切替前に必ず disconnect する。
let activeTocObserver = null;

// 自分の保存による mtime を一時記録（SSE で戻ってきたとき外部変更として扱わないため）
const selfWrittenMtimes = new Set();
let saveInFlight = false;

const TITLE_BASE = (typeof VB_CONFIG.title === 'string' && VB_CONFIG.title) || 'vibeboard';

function isTodoDirty() {
  return todoState.content !== todoState.savedContent;
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
}

function saveActiveCategory() {
  localStorage.setItem(STORAGE_CATEGORY, activeCategory);
}

function saveExpanded() {
  localStorage.setItem(STORAGE_EXPANDED, JSON.stringify(expanded));
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

// ディレクトリとファイルを mtime 降順（新しい順）で 1 列に並べる
function mergeByMtime(dirs, files) {
  const items = [
    ...dirs.map(d => ({ kind: 'dir', data: d, mtime: d.mtime || 0 })),
    ...files.map(f => ({ kind: 'file', data: f, mtime: f.mtime || 0 })),
  ];
  items.sort((a, b) => b.mtime - a.mtime);
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

  const fileName = document.createElement('div');
  fileName.className = 'nav-item-file';
  fileName.textContent = file.name;
  a.appendChild(fileName);

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

  const name = document.createElement('span');
  name.className = 'nav-dir-name';
  name.textContent = dir.name;
  header.appendChild(name);

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
    for (const item of mergeByMtime(dir.dirs, dir.files)) {
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

function renderSidebar() {
  if (activeCategory === EDITABLE_TAB) {
    renderTodoSidebar();
    return;
  }

  const tree = docsTree[activeCategory] || { files: [], dirs: [] };
  sidebarNav.innerHTML = '';

  if (tree.files.length === 0 && tree.dirs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'loading-text';
    empty.textContent = 'ドキュメントがありません';
    sidebarNav.appendChild(empty);
    return;
  }

  // archive ディレクトリはツリーの一番下に出す（それ以外は mtime 降順で混ぜて並べる）
  const regularDirs = tree.dirs.filter(d => d.name !== 'archive');
  const archiveDirs = tree.dirs.filter(d => d.name === 'archive');

  const frag = document.createDocumentFragment();
  for (const item of mergeByMtime(regularDirs, tree.files)) {
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

async function renderMarkdown(category, filePath) {
  clearTocObserver();
  contentArea.innerHTML = '<div class="loading-text">読み込み中...</div>';
  const filename = filePath.split('/').pop();
  try {
    const data = await fetchJson(`/api/docs/${category}/${encodeURIComponent(filename)}`);
    pageTitle.textContent = data.title;
    topbarSub.textContent = `${category}/${filePath}`;
    contentArea.innerHTML = '';

    // archive=true のカテゴリ直下にある md のみアーカイブ可能
    const catDef = CATEGORY_BY_NAME.get(category);
    if (catDef && catDef.archive && !filePath.includes('/')) {
      const toolbar = document.createElement('div');
      toolbar.className = 'doc-toolbar';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'doc-action';
      btn.textContent = 'アーカイブする';
      btn.addEventListener('click', () => archiveFile(category, filename));
      toolbar.appendChild(btn);
      contentArea.appendChild(toolbar);
    }

    const div = document.createElement('div');
    div.className = 'md-content';
    div.innerHTML = data.html;

    const layout = document.createElement('div');
    layout.className = 'doc-pane-layout';

    const toc = document.createElement('nav');
    toc.className = 'doc-toc';
    toc.setAttribute('aria-label', 'ページ内目次');
    layout.appendChild(toc);

    const body = document.createElement('div');
    body.className = 'doc-body';
    body.appendChild(div);
    layout.appendChild(body);

    contentArea.appendChild(layout);
    buildDocToc(div, toc);
    renderMermaidIn(div);
  } catch (err) {
    showError(err.message);
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
    docsTree = await fetchJson('/api/docs');

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
    docsTree = await fetchJson('/api/docs');
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

async function renderTodoView(name) {
  clearTocObserver();
  contentArea.innerHTML = '<div class="loading-text">読み込み中...</div>';
  try {
    // 生 Markdown + mtime を先に取得（編集モードで必要）
    const data = await fetchJson(`/api/files/${encodeURIComponent(name)}`);
    todoState.name = name;
    todoState.content = data.content;
    todoState.savedContent = data.content;
    todoState.mtime = data.mtime;
    todoState.conflict = null;
    // 前回の mode を維持（初回は preview）
    if (todoState.mode !== 'preview' && todoState.mode !== 'edit') {
      todoState.mode = 'preview';
    }

    pageTitle.textContent = name.replace(/\.md$/, '');
    topbarSub.textContent = name;
    contentArea.innerHTML = '';
    contentArea.appendChild(buildTodoLayout());

    if (todoState.mode === 'preview') {
      await renderTodoPreviewBody();
    } else {
      renderTodoEditBody();
    }
    updateConflictIndicators();
  } catch (err) {
    showError(err.message);
  }
}

function buildTodoLayout() {
  const wrap = document.createElement('div');
  wrap.className = 'todo-view';

  const toolbar = document.createElement('div');
  toolbar.className = 'todo-toolbar';

  const subtabs = document.createElement('div');
  subtabs.className = 'todo-subtabs';
  subtabs.setAttribute('role', 'tablist');
  for (const m of ['preview', 'edit']) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'todo-subtab' + (todoState.mode === m ? ' active' : '');
    btn.dataset.mode = m;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', todoState.mode === m ? 'true' : 'false');
    btn.textContent = m === 'preview' ? 'プレビュー' : '編集';
    btn.addEventListener('click', () => switchTodoMode(m));
    subtabs.appendChild(btn);
  }
  toolbar.appendChild(subtabs);

  const actions = document.createElement('div');
  actions.className = 'todo-actions';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'doc-action doc-action-refresh';
  refreshBtn.dataset.role = 'refresh';
  refreshBtn.textContent = '↻ 再取得';
  refreshBtn.addEventListener('click', () => refetchTodoFile());
  actions.appendChild(refreshBtn);

  if (todoState.mode === 'edit') {
    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'doc-action';
    discardBtn.textContent = '変更を破棄';
    discardBtn.addEventListener('click', discardTodoChanges);
    actions.appendChild(discardBtn);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'doc-action doc-action-primary';
    saveBtn.textContent = '保存';
    saveBtn.dataset.role = 'save';
    saveBtn.addEventListener('click', () => saveTodoFile());
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

async function switchTodoMode(mode) {
  if (todoState.mode === mode) return;
  if (todoState.mode === 'edit' && isTodoDirty()) {
    if (!confirm('未保存の変更があります。破棄してプレビューに切り替えますか？')) return;
    // 破棄してから切り替え
    todoState.content = todoState.savedContent;
    todoState.conflict = null;
  }
  todoState.mode = mode;
  // レイアウト全体を描き直してサブタブと保存ボタンの表示を切り替える
  contentArea.innerHTML = '';
  contentArea.appendChild(buildTodoLayout());
  if (mode === 'preview') {
    await renderTodoPreviewBody();
  } else {
    renderTodoEditBody();
  }
  updateConflictIndicators();
}

async function renderTodoPreviewBody() {
  const body = document.getElementById('todo-body');
  if (!body) return;
  body.innerHTML = '<div class="loading-text">読み込み中...</div>';
  try {
    const data = await fetchJson(`/api/files/${encodeURIComponent(todoState.name)}/render`);
    body.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'md-content';
    div.innerHTML = data.html;
    body.appendChild(div);
    renderMermaidIn(div);
  } catch (err) {
    body.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'error-text';
    div.textContent = err.message;
    body.appendChild(div);
  }
}

function renderTodoEditBody() {
  const body = document.getElementById('todo-body');
  if (!body) return;
  body.innerHTML = '';
  const textarea = document.createElement('textarea');
  textarea.className = 'todo-editor';
  textarea.value = todoState.content;
  textarea.setAttribute('spellcheck', 'false');
  textarea.addEventListener('input', () => {
    todoState.content = textarea.value;
  });
  // Cmd/Ctrl+S で保存
  textarea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      saveTodoFile();
    }
  });
  body.appendChild(textarea);
  // フォーカスはユーザーの操作後にのみ当てる（タブ切替時に textarea にスクロールしないため）
  textarea.focus();
}

function discardTodoChanges() {
  if (!isTodoDirty()) return;
  if (!confirm('未保存の変更を破棄します。よろしいですか？')) return;
  todoState.content = todoState.savedContent;
  todoState.conflict = null;
  renderTodoEditBody();
  updateConflictIndicators();
}

async function refetchTodoFile() {
  if (!todoState.name) return;
  if (todoState.mode === 'edit' && isTodoDirty()) {
    if (!confirm('未保存の変更があります。再取得すると失われます。続行しますか？')) return;
  }
  try {
    if (todoState.mode === 'preview') {
      const data = await fetchJson(`/api/files/${encodeURIComponent(todoState.name)}/render`);
      const body = document.getElementById('todo-body');
      if (body) {
        body.innerHTML = '';
        const div = document.createElement('div');
        div.className = 'md-content';
        div.innerHTML = data.html;
        body.appendChild(div);
        renderMermaidIn(div);
      }
      if (typeof data.mtime === 'number') todoState.mtime = data.mtime;
    } else {
      const data = await fetchJson(`/api/files/${encodeURIComponent(todoState.name)}`);
      todoState.content = data.content;
      todoState.savedContent = data.content;
      todoState.mtime = data.mtime;
      renderTodoEditBody();
    }
    todoState.conflict = null;
    updateConflictIndicators();
    showToast('最新を読み込みました', 1500);
  } catch (err) {
    alert(`再取得に失敗しました: ${err.message}`);
  }
}

function updateRefreshButton() {
  const btn = document.querySelector('.todo-toolbar [data-role="refresh"]');
  if (!btn) return;
  const label = formatMtime(todoState.mtime);
  btn.title = label ? `最終取得: ${label}\nショートカット: R` : 'ショートカット: R';
  btn.classList.toggle('emphasized', !!todoState.conflict);
}

async function saveTodoFile(options = {}) {
  const { force = false } = options;
  if (!todoState.name) return;
  if (!force && !isTodoDirty()) {
    showToast('変更はありません');
    return;
  }
  saveInFlight = true;
  try {
    const res = await fetch(`/api/files/${encodeURIComponent(todoState.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: todoState.content, baseMtime: todoState.mtime }),
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
    todoState.mtime = json.data.mtime;
    todoState.savedContent = todoState.content;
    todoState.conflict = null;
    // 自分の書き込みによる SSE 通知を外部変更として扱わないための記録
    const savedMtime = json.data.mtime;
    selfWrittenMtimes.add(savedMtime);
    setTimeout(() => selfWrittenMtimes.delete(savedMtime), 5000);
    updateConflictIndicators();
    showToast('保存しました');
  } catch (err) {
    alert(`保存に失敗しました: ${err.message}`);
  } finally {
    saveInFlight = false;
  }
}

function handleSaveConflict(currentMtime) {
  return new Promise((resolve) => {
    showConflictDialog({
      onReload: async () => {
        // 外部の最新を取得して textarea を差し替え（編集内容は破棄）
        try {
          const data = await fetchJson(`/api/files/${encodeURIComponent(todoState.name)}`);
          todoState.content = data.content;
          todoState.savedContent = data.content;
          todoState.mtime = data.mtime;
          todoState.conflict = null;
          if (todoState.mode === 'edit') renderTodoEditBody();
          else await renderTodoPreviewBody();
          updateConflictIndicators();
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
          todoState.mtime = currentMtime;
        } else {
          // currentMtime が無ければ GET で取り直す
          try {
            const data = await fetchJson(`/api/files/${encodeURIComponent(todoState.name)}`);
            todoState.mtime = data.mtime;
          } catch (err) {
            alert(`mtime 取得に失敗しました: ${err.message}`);
            resolve();
            return;
          }
        }
        await saveTodoFile({ force: true });
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
  const designUrl = `/api/design/${encodeURIComponent(category)}/${encodeURIComponent(filename)}`;
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

function handleRoute() {
  const rawHash = location.hash.replace(/^#/, '');

  // 旧 #design/xxx.html → #specs/design/xxx.html （specs カテゴリがある場合のみ）
  if (rawHash.startsWith('design/') && CATEGORY_BY_NAME.has('specs')) {
    location.replace(`#specs/${rawHash}`);
    return;
  }

  const parsed = parseHash();
  if (!parsed) {
    refreshActiveHighlight();
    showEmpty();
    return;
  }

  const { category, filePath } = parsed;
  if (!CATEGORIES.includes(category)) {
    showError('不正なカテゴリです');
    return;
  }

  let needSidebarRerender = false;
  if (activeCategory !== category) {
    activeCategory = category;
    saveActiveCategory();
    renderTabs();
    needSidebarRerender = true;
  }

  if (category === EDITABLE_TAB) {
    if (!EDITABLE_NAMES.includes(filePath)) {
      if (needSidebarRerender) renderSidebar();
      else refreshActiveHighlight();
      showError('対応していないファイルです');
      return;
    }
    // ファイル切替時、未保存の変更があれば確認
    if (todoState.name && todoState.name !== filePath && isTodoDirty()) {
      if (!confirm('未保存の変更があります。破棄して別のファイルに移動しますか？')) {
        // 元のファイルに戻す（履歴を増やさないよう replace）
        location.replace(`#${EDITABLE_TAB}/${encodeURIComponent(todoState.name)}`);
        return;
      }
      // 破棄する（savedContent に戻すことで以降の isDirty を false にする）
      todoState.content = todoState.savedContent;
      todoState.conflict = null;
    }
    if (needSidebarRerender) renderSidebar();
    else refreshActiveHighlight();
    renderTodoView(filePath);
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
    renderDesign(category, filePath);
  } else if (ext === '.md') {
    renderMarkdown(category, filePath);
  } else {
    showError('対応していないファイル形式です');
  }
}

// 設定された editable / categories から topbar の tab ボタンを動的に組み立てる
function buildTabs() {
  topbarTabs.innerHTML = '';
  const tabs = [
    { name: EDITABLE_TAB, label: EDITABLE_LABEL },
    ...CATEGORY_DEFS.map(c => ({ name: c.name, label: c.label })),
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
      if (activeCategory === EDITABLE_TAB && isTodoDirty()) {
        if (!confirm('未保存の変更があります。破棄して他のタブに移動しますか？')) return;
        todoState.content = todoState.savedContent;
        todoState.conflict = null;
        updateConflictIndicators();
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
    });
  });
}

function setupBeforeUnload() {
  window.addEventListener('beforeunload', (e) => {
    if (isTodoDirty()) {
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
    if (activeCategory !== EDITABLE_TAB || !todoState.name) return;
    const target = e.target;
    if (target) {
      const tag = target.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
      if (target.isContentEditable) return;
    }
    e.preventDefault();
    refetchTodoFile();
  });
}

// === SSE: 外部変更のリアルタイム反映 ===

function connectEventSource() {
  if (typeof EventSource === 'undefined') return;
  try {
    const es = new EventSource('/api/files/watch');
    sseState.source = es;
    es.addEventListener('open', () => {
      sseState.connected = true;
      updateSseIndicator();
    });
    es.addEventListener('error', () => {
      // EventSource は自動で再接続を試みる
      sseState.connected = false;
      updateSseIndicator();
    });
    es.addEventListener('change', (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (typeof payload.name !== 'string' || typeof payload.mtime !== 'number') return;
        handleExternalChange(payload.name, payload.mtime);
      } catch {
        // ignore malformed
      }
    });
  } catch {
    // ignore
  }
}

function updateSseIndicator() {
  const el = document.getElementById('sse-indicator');
  if (!el) return;
  el.hidden = sseState.connected;
}

async function handleExternalChange(name, mtime) {
  // 自分の保存中の書き込みは無視
  if (saveInFlight) return;
  // 自分が書いた mtime は無視（SSE が PUT 応答より先に届いたケースも含む）
  if (selfWrittenMtimes.has(mtime)) return;
  // 現在開いていないファイルは何もしない（次に開くときに最新を取りに行く）
  if (activeCategory !== EDITABLE_TAB || todoState.name !== name) return;
  // 既知の mtime と一致するなら無視（自分の保存直後に想定）
  if (todoState.mtime === mtime) return;
  // 同じ競合 mtime を再通知された場合は UI 再構築を避ける
  if (todoState.conflict && todoState.conflict.mtime === mtime) return;

  if (todoState.mode === 'preview') {
    await refetchPreviewForExternalChange();
    return;
  }

  if (!isTodoDirty()) {
    // clean 編集: 内容と mtime を差し替え + 情報バー
    await reloadEditFromExternal({ notify: true });
    return;
  }

  // dirty 編集: 競合状態に遷移
  todoState.conflict = { mtime, barVisible: true };
  updateConflictIndicators();
}

async function refetchPreviewForExternalChange() {
  try {
    const data = await fetchJson(`/api/files/${encodeURIComponent(todoState.name)}/render`);
    const body = document.getElementById('todo-body');
    if (!body) return;
    if (typeof data.mtime === 'number') todoState.mtime = data.mtime;
    body.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'md-content';
    div.innerHTML = data.html;
    body.appendChild(div);
    renderMermaidIn(div);
    flashExternalUpdateBadge();
  } catch {
    // ignore
  }
}

async function reloadEditFromExternal({ notify }) {
  try {
    const data = await fetchJson(`/api/files/${encodeURIComponent(todoState.name)}`);
    todoState.content = data.content;
    todoState.savedContent = data.content;
    todoState.mtime = data.mtime;
    todoState.conflict = null;
    if (todoState.mode === 'edit') renderTodoEditBody();
    else await renderTodoPreviewBody();
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
  const active = !!todoState.conflict;
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
  if (!todoState.conflict || !todoState.conflict.barVisible) {
    if (existing) existing.remove();
    return;
  }
  if (existing) existing.remove();

  const bar = document.createElement('div');
  bar.className = 'todo-conflict-bar';

  const msg = document.createElement('div');
  msg.className = 'todo-conflict-message';
  const fmt = formatMtime(todoState.conflict.mtime);
  msg.textContent = `⚠ 競合: 外部で ${todoState.name} が更新されています（${fmt}）。保存すると外部の変更を上書きします`;
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
    if (todoState.conflict) todoState.conflict.barVisible = false;
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
    const data = await fetchJson(`/api/files/${encodeURIComponent(todoState.name)}`);
    openDiffModal(todoState.content, data.content);
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
  title.textContent = `差分: ${todoState.name}（手元 vs 外部）`;
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
  const conflictName = (activeCategory === EDITABLE_TAB && todoState.conflict) ? todoState.name : null;
  sidebarNav.querySelectorAll('.nav-item').forEach(el => {
    // TODO カテゴリ以外のアイテムは触らない
    if (el.dataset.category !== EDITABLE_TAB) return;
    let badge = el.querySelector('.nav-item-badge');
    if (el.dataset.path === conflictName) {
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

async function init() {
  loadPersisted();
  buildTabs();
  setupTabs();
  setupBeforeUnload();
  setupRefreshShortcut();
  renderTabs();
  updateSseIndicator();
  connectEventSource();

  try {
    docsTree = await fetchJson('/api/docs');
    renderSidebar();
    handleRoute();
  } catch (err) {
    sidebarNav.innerHTML = '';
    showError(err.message);
  }
}

window.addEventListener('hashchange', handleRoute);
init();
