// `npm test` で走る（先に `npm run build` が要る。dist/todo.js を読む）。
// 見ているのはファイルもプロセスも要らない純粋な部分だけ。画面はブラウザで確かめる。
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { hasTaskLines, parseRelationLine, parseTodo, resolveDocPath } = require('../dist/todo.js');

const SAMPLE = [
  '# TODO',
  '',
  '## 機能開発',
  '',
  '- [ ] 親のタスク [plan](docs/plans/foo.md)',
  '  - [ ] 子のタスク',
  '    - [x] 済んだ孫',
  '    - [~] 進めている孫',
  '  → プラン: `docs/plans/foo.md`',
  '  - [ ] もう 1 つの子',
  '    依存: 「子のタスク」',
  '- [ ] 派生したタスク',
  '  派生元: 「親のタスク」',
  '  関連: [spec](docs/specs/api.md)',
  '',
  'ここは段落で、どのタスクにも属さない。',
  '',
  '## バグ',
  '',
  '- [ ] 落ちる',
  '  - これはメモ',
  '  依存: 見つからない相手',
  '',
  '```',
  '- [ ] コードブロックの中はタスクではない',
  '```',
].join('\n');

const exists = p => ['docs/plans/foo.md', 'docs/specs/api.md'].includes(p);

function flat(tree) {
  const out = [];
  const walk = nodes => {
    for (const n of nodes) {
      out.push(n);
      walk(n.children);
    }
  };
  for (const s of tree.sections) walk(s.tasks);
  return out;
}

test('字下げから親子の木になり、見出しごとに区切られる', () => {
  const tree = parseTodo(SAMPLE, { exists });
  assert.deepEqual(tree.sections.map(s => s.heading), ['機能開発', 'バグ']);
  const [a, b] = tree.sections[0].tasks;
  assert.equal(a.text, '親のタスク [plan](docs/plans/foo.md)');
  assert.equal(a.children.length, 2);
  assert.equal(a.children[0].children.length, 2);
  assert.equal(a.children[0].children[0].text, '済んだ孫');
  assert.equal(b.text, '派生したタスク');
  assert.equal(tree.count, 7);
});

test('状態は [ ] / [x] / [~] / [-] で決まる', () => {
  const tree = parseTodo('- [ ] a\n- [x] b\n- [X] c\n- [~] d\n- [-] e\n- [?] f\n');
  assert.deepEqual(
    flat(tree).map(n => n.state),
    ['open', 'done', 'done', 'active', 'cancelled', 'open'],
  );
  assert.equal(flat(tree)[5].mark, '?');
  assert.deepEqual(tree.states, { open: 2, done: 2, active: 1, cancelled: 1 });
});

test('メモは字下げで持ち主が決まり、箇条書きの記号は落ちる', () => {
  const tree = parseTodo(SAMPLE, { exists });
  const parent = tree.sections[0].tasks[0];
  // 孫より後ろに書かれた続きでも、字下げが子の幅なら子のもの
  assert.deepEqual(parent.children[0].notes, ['→ プラン: `docs/plans/foo.md`']);
  const bug = tree.sections[1].tasks[0];
  assert.deepEqual(bug.notes, ['これはメモ', '依存: 見つからない相手']);
});

test('空行のあとの字下げなしの段落はどのタスクにも付かない', () => {
  const tree = parseTodo(SAMPLE, { exists });
  for (const n of flat(tree)) {
    assert.ok(!n.notes.some(x => x.includes('段落')), n.text);
  }
});

test('コードブロックの中はタスクにしない', () => {
  const tree = parseTodo(SAMPLE, { exists });
  assert.ok(!flat(tree).some(n => n.text.includes('コードブロック')));
});

test('タスクの行のリンクはドキュメントへの関連になり、実在も分かる', () => {
  const tree = parseTodo(SAMPLE, { mdPath: 'TODO.md', exists });
  const parent = tree.sections[0].tasks[0];
  assert.deepEqual(
    parent.docs.map(d => [d.label, d.path, d.exists, d.source]),
    [['plan', 'docs/plans/foo.md', true, 'text']],
  );
  const derived = tree.sections[0].tasks[1];
  const spec = derived.docs.find(d => d.source === 'relation');
  assert.equal(spec.label, 'spec');
  assert.equal(spec.path, 'docs/specs/api.md');
  assert.equal(spec.kind, 'related');
  assert.equal(spec.exists, true);
});

test('無いファイルへのリンクは exists が false', () => {
  const tree = parseTodo('- [ ] a [plan](docs/plans/nope.md)', { exists });
  assert.equal(flat(tree)[0].docs[0].exists, false);
});

test('依存 / 派生元 の行は相手のタスクを文面で引き、逆方向も付く', () => {
  const tree = parseTodo(SAMPLE, { exists });
  const parent = tree.sections[0].tasks[0];
  const child = parent.children[0];
  const other = parent.children[1];
  assert.deepEqual(other.refs, [{ kind: 'depends', text: '子のタスク', taskId: child.id, ambiguous: false }]);
  assert.deepEqual(child.inbound, [{ kind: 'depends', taskId: other.id }]);

  const derived = tree.sections[0].tasks[1];
  assert.equal(derived.refs[0].kind, 'derived');
  assert.equal(derived.refs[0].taskId, parent.id);
  assert.deepEqual(parent.inbound, [{ kind: 'derived', taskId: derived.id }]);
});

test('引けない相手は null のまま残る（行は消えない）', () => {
  const tree = parseTodo(SAMPLE, { exists });
  const bug = tree.sections[1].tasks[0];
  assert.deepEqual(bug.refs, [{ kind: 'depends', text: '見つからない相手', taskId: null, ambiguous: false }]);
});

test('先頭一致・部分一致でも 1 件に絞れれば引ける。複数なら兄弟を優先し、絞れなければ ambiguous', () => {
  const md = [
    '- [ ] Phase 1: 土台',
    '- [ ] Phase 2: 本体',
    '  依存: Phase 1',
    '- [ ] 別の親',
    '  - [ ] Phase 1: 準備',
    '  - [ ] Phase 2: 実装',
    '    依存: Phase 1',
    '- [ ] どれか分からない',
    '  依存: Phase',
  ].join('\n');
  const tree = parseTodo(md);
  const nodes = flat(tree);
  const byText = t => nodes.find(n => n.text === t);
  assert.equal(byText('Phase 2: 本体').refs[0].taskId, byText('Phase 1: 土台').id);
  assert.equal(byText('Phase 2: 実装').refs[0].taskId, byText('Phase 1: 準備').id);
  const vague = byText('どれか分からない').refs[0];
  assert.equal(vague.taskId, null);
  assert.equal(vague.ambiguous, true);
});

test('関係行の分解: ラベル・リンク・「」・裸のパス', () => {
  assert.equal(parseRelationLine('ただのメモ: ではない'), null);
  assert.equal(parseRelationLine('関連ニュースを見る'), null);
  const r = parseRelationLine('依存: 「A」と「B」、[plan](docs/plans/x.md)、docs/specs/y.md');
  assert.equal(r.kind, 'depends');
  assert.deepEqual(r.targets, ['A', 'B']);
  assert.deepEqual(r.links, [{ label: 'plan', href: 'docs/plans/x.md' }]);
  assert.deepEqual(r.paths, ['docs/specs/y.md']);
  // 「」が無ければ全体が 1 つの相手
  assert.deepEqual(parseRelationLine('派生元： Phase 1: 土台').targets, ['Phase 1: 土台']);
  // 「」で示してあれば、つなぎの言葉は相手にしない
  assert.deepEqual(parseRelationLine('依存: 「A」の前に').targets, ['A']);
  assert.equal(parseRelationLine('depends on: Foo').kind, 'depends');
  assert.equal(parseRelationLine('related: Foo').kind, 'related');
});

test('リンクの解決は Markdown の場所からの相対で、root の外は null', () => {
  assert.equal(resolveDocPath('docs/plans/x.md', 'TODO.md'), 'docs/plans/x.md');
  assert.equal(resolveDocPath('../specs/y.md#sec', 'docs/plans/x.md'), 'docs/specs/y.md');
  assert.equal(resolveDocPath('./z.md?x=1', 'docs/plans/x.md'), 'docs/plans/z.md');
  assert.equal(resolveDocPath('../../etc/passwd', 'docs/x.md'), null);
  assert.equal(resolveDocPath('/abs.md', 'TODO.md'), null);
  assert.equal(resolveDocPath('https://example.com/a.md', 'TODO.md'), null);
  assert.equal(resolveDocPath('#anchor', 'TODO.md'), null);
});

test('子孫の数と完了の数', () => {
  const tree = parseTodo(SAMPLE, { exists });
  const parent = tree.sections[0].tasks[0];
  assert.equal(parent.total, 4);
  assert.equal(parent.done, 1);
  assert.equal(parent.children[0].total, 2);
});

test('id は本文から決まり、行が増えてもずれない', () => {
  const a = flat(parseTodo(SAMPLE)).map(n => n.id);
  const b = flat(parseTodo(`- [ ] 先頭に足した\n${SAMPLE}`)).map(n => n.id);
  assert.deepEqual(b.slice(1), a);
  assert.match(a[0], /^[0-9a-f]{8}$/);
});

test('同じ文面でも親が違えば別の id', () => {
  const tree = parseTodo(['- [ ] A', '  - [ ] 同じ', '- [ ] B', '  - [ ] 同じ'].join('\n'));
  const [a, b] = tree.sections[0].tasks;
  assert.notEqual(a.children[0].id, b.children[0].id);
});

test('inline の描画は差し込める（既定はエスケープだけ）', () => {
  const plain = parseTodo('- [ ] <b>x</b>');
  assert.equal(flat(plain)[0].html, '&lt;b&gt;x&lt;/b&gt;');
  const custom = parseTodo('- [ ] *x*\n  メモ', { inline: s => `<i>${s}</i>` });
  assert.equal(flat(custom)[0].html, '<i>*x*</i>');
  assert.deepEqual(flat(custom)[0].notesHtml, ['<i>メモ</i>']);
});

test('CRLF でも読める', () => {
  const tree = parseTodo('- [ ] A\r\n  - [ ] B\r\n');
  assert.equal(tree.sections[0].tasks[0].children[0].text, 'B');
});

test('タスク行があるかの判定', () => {
  assert.equal(hasTaskLines('# x\n\n- [ ] a'), true);
  assert.equal(hasTaskLines('1. [x] a'), true);
  assert.equal(hasTaskLines('- a\n- b'), false);
  assert.equal(hasTaskLines(''), false);
});
