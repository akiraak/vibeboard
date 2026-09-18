// `npm test` で走る（先に `npm run build` が要る。dist/config.js を読む）。
// 一時ディレクトリに vibeboard.config.json を書いて resolveConfig を呼ぶ。
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveConfig } = require('../dist/config.js');

function tempRoot(t, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeboard-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (config !== undefined) {
    fs.writeFileSync(path.join(dir, 'vibeboard.config.json'), JSON.stringify(config));
  }
  return dir;
}

function categoriesOf(root) {
  return resolveConfig(['--root', root]).config.categories.map(c => ({
    ...c,
    path: path.relative(root, c.path),
  }));
}

const PLANS = { name: 'plans', label: 'Plans', path: 'docs/plans', archive: true };
const SPECS = { name: 'specs', label: 'Specs', path: 'docs/specs', archive: false };

test('categories: 設定ファイルが無ければ既定の Plans / Specs', (t) => {
  assert.deepEqual(categoriesOf(tempRoot(t)), [PLANS, SPECS]);
});

test('categories: 書かない / 空配列は既定と同じ', (t) => {
  assert.deepEqual(categoriesOf(tempRoot(t, { title: 'x' })), [PLANS, SPECS]);
  assert.deepEqual(categoriesOf(tempRoot(t, { categories: [] })), [PLANS, SPECS]);
});

test('categories: タブを 1 つ足しても既定は消えず、既定のあとに並ぶ', (t) => {
  const root = tempRoot(t, { categories: [{ name: 'design' }] });
  assert.deepEqual(categoriesOf(root), [
    PLANS,
    SPECS,
    { name: 'design', label: 'design', path: 'docs/design', archive: false },
  ]);
});

test('categories: 書いた順に並び、書かれていない既定は 1 つ前の既定の直後に入る', (t) => {
  const names = (config) => categoriesOf(tempRoot(t, config)).map(c => c.name);
  assert.deepEqual(names({ categories: [{ name: 'design' }, { name: 'specs' }] }), ['plans', 'design', 'specs']);
  assert.deepEqual(names({ categories: [{ name: 'specs' }, { name: 'design' }] }), ['plans', 'specs', 'design']);
  assert.deepEqual(names({ categories: [{ name: 'workflows' }, { name: 'plans' }] }), ['workflows', 'plans', 'specs']);
  assert.deepEqual(
    names({ categories: [{ name: 'workflows' }, { name: 'plans' }, { name: 'specs' }] }),
    ['workflows', 'plans', 'specs'],
  );
});

test('categories: 既定と同じ name は書いたフィールドだけ上書きする', (t) => {
  const root = tempRoot(t, {
    categories: [{ name: 'plans', path: 'plans' }, { name: 'specs', label: '仕様' }],
  });
  assert.deepEqual(categoriesOf(root), [
    { ...PLANS, path: 'plans' },
    { ...SPECS, label: '仕様' },
  ]);
});

test('categories: archive を書けば既定を上書きできる', (t) => {
  const root = tempRoot(t, { categories: [{ name: 'plans', archive: false }] });
  assert.deepEqual(categoriesOf(root), [{ ...PLANS, archive: false }, SPECS]);
});

test('categories: hidden: true のタブは出さない（既定にも足したタブにも効く）', (t) => {
  assert.deepEqual(categoriesOf(tempRoot(t, { categories: [{ name: 'specs', hidden: true }] })), [PLANS]);
  assert.deepEqual(
    categoriesOf(tempRoot(t, { categories: [{ name: 'design', hidden: true }] })),
    [PLANS, SPECS],
  );
  assert.deepEqual(
    categoriesOf(tempRoot(t, { categories: [{ name: 'design' }, { name: 'design2', hidden: false }] })).map(c => c.name),
    ['plans', 'specs', 'design', 'design2'],
  );
});

test('categories: 全部 hidden ならカテゴリのタブは 0 本', (t) => {
  const root = tempRoot(t, {
    categories: [{ name: 'plans', hidden: true }, { name: 'specs', hidden: true }],
  });
  assert.deepEqual(categoriesOf(root), []);
});

test('categories: hidden が真偽値でなければ弾く', (t) => {
  const root = tempRoot(t, { categories: [{ name: 'specs', hidden: 'yes' }] });
  assert.throws(() => resolveConfig(['--root', root]), /categories\[0\]\.hidden/);
});

test('categories: hidden の要素にも name の検証をかける', (t) => {
  const dup = tempRoot(t, { categories: [{ name: 'specs' }, { name: 'specs', hidden: true }] });
  assert.throws(() => resolveConfig(['--root', dup]), /categories\[1\]\.name が重複/);
  const reserved = tempRoot(t, { categories: [{ name: 'tasks', hidden: true }] });
  assert.throws(() => resolveConfig(['--root', reserved]), /予約語/);
});

test('categories: 表示するタブの path が root の外なら弾き、hidden なら見ない', (t) => {
  const outside = tempRoot(t, { categories: [{ name: 'plans', path: '../elsewhere' }] });
  assert.throws(() => resolveConfig(['--root', outside]), /categories\[0\]\.path/);
  const hidden = tempRoot(t, { categories: [{ name: 'plans', path: '../elsewhere', hidden: true }] });
  assert.deepEqual(categoriesOf(hidden), [SPECS]);
});

test('categories: 配列でなければ弾く', (t) => {
  const root = tempRoot(t, { categories: { name: 'plans' } });
  assert.throws(() => resolveConfig(['--root', root]), /categories は配列/);
});
