// `npm test` で走る（先に `npm run build` が要る。dist/search.js を読む）。
// 一時ディレクトリの中だけで試す。規則は docs/plans/vibeboard-search.md。
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { matchesAll, parseQuery, searchFiles, SEARCH_LIMIT } = require('../dist/search.js');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeboard-search-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

test('parseQuery: 空白で割り、小文字にし、空を落とす', () => {
  assert.deepEqual(parseQuery('  Trader  差1 '), ['trader', '差1']);
  assert.deepEqual(parseQuery(''), []);
});

test('matchesAll: 全部の語がどこかにある（AND）。大文字小文字は区別しない', () => {
  assert.equal(matchesAll(['halt', '停止'], ['docs/HALT.md', '停止ボタン']), true);
  assert.equal(matchesAll(['halt', '無い語'], ['docs/HALT.md', '停止ボタン']), false);
});

test('searchFiles: パスの一致が先、本文の一致は行数の多い順。一致した最初の行を添える', (t) => {
  const root = tempDir(t);
  put(root, 'a/trader-plan.md', '# 計画\n\n中身\n');
  put(root, 'b/notes.md', '# メモ\n\nトレーダー trader を 3 人\ntrader は執行の単位\n');
  put(root, 'c/other.md', '# 無関係\n');
  put(root, 'd/one.md', '# 1 行だけ\n\ntrader\n');
  const hits = searchFiles(root, 'trader');
  assert.deepEqual(hits.map(h => h.path), ['a/trader-plan.md', 'b/notes.md', 'd/one.md']);
  assert.equal(hits[0].pathMatch, true);
  assert.equal(hits[0].title, '計画');
  assert.equal(hits[1].lines, 2);
  assert.equal(hits[1].snippet, 'トレーダー trader を 3 人');
});

test('searchFiles: AND は パス ＋ 本文 をまたいで効く', (t) => {
  const root = tempDir(t);
  put(root, 'live/trading.md', '# 実売買\n\nHALT で止める\n');
  put(root, 'live/other.md', '# 別\n\nHALT\n');
  assert.deepEqual(searchFiles(root, 'trading halt').map(h => h.path), ['live/trading.md']);
});

test('searchFiles: カテゴリは拡張子で絞り dotfile を飛ばす。Files は除外名だけ見て dotfile も出す', (t) => {
  const root = tempDir(t);
  put(root, 'x.md', 'secret\n');
  put(root, 'x.txt', 'secret\n');
  put(root, '.env', 'SECRET=1\n');
  put(root, 'node_modules/m.md', 'secret\n');
  assert.deepEqual(searchFiles(root, 'secret').map(h => h.path).sort(), ['node_modules/m.md', 'x.md']);
  const files = searchFiles(root, 'secret', { exts: null, excludes: ['node_modules'], skipDotfiles: false });
  assert.deepEqual(files.map(h => h.path).sort(), ['.env', 'x.md', 'x.txt']);
});

test('searchFiles: 二進と 1MB 超は本文を見ない（パスの一致だけで拾う）', (t) => {
  const root = tempDir(t);
  put(root, 'img-needle.md', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
  put(root, 'big.md', 'needle\n'.repeat(200000));   // 1.4MB
  put(root, 'bin.md', Buffer.from([0x00, 0x01, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
  const hits = searchFiles(root, 'needle');
  assert.deepEqual(hits.map(h => h.path), ['img-needle.md']);
  assert.equal(hits[0].lines, 0);
  assert.equal(hits[0].snippet, null);
});

test('searchFiles: 上限と空の検索語', (t) => {
  const root = tempDir(t);
  for (let i = 0; i < SEARCH_LIMIT + 5; i++) put(root, `f${i}.md`, 'needle\n');
  assert.equal(searchFiles(root, 'needle').length, SEARCH_LIMIT);
  assert.equal(searchFiles(root, 'needle', { limit: 3 }).length, 3);
  assert.deepEqual(searchFiles(root, '   '), []);
});

test('searchFiles: 行数は「語が全部そろった行」だけ数える（短い語で大きいファイルが上に来ない）', (t) => {
  const root = tempDir(t);
  put(root, 'big.md', '# 大\n\n' + '1 行目に 1 がある\n'.repeat(300) + 'live\n差\n');   // 3 語が別々の行
  put(root, 'small.md', '# 小\n\n差 1 は live の画面で出す\n');
  const hits = searchFiles(root, '差 1 live');
  assert.deepEqual(hits.map(h => [h.path, h.lines]), [['small.md', 1], ['big.md', 0]]);
  assert.equal(hits[0].snippet, '差 1 は live の画面で出す');
  // パスで一致した語は本文で要らない
  put(root, 'live/a.md', '# a\n\n差 1\n');
  assert.equal(searchFiles(root, 'live 差').find(h => h.path === 'live/a.md').lines, 1);
});
