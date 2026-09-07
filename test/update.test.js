// `npm test` で走る（先に `npm run build` が要る。dist/update.js を読む）。
// 見ているのは同期の計画（純関数）と、tmp に作った 2 つのディレクトリの間の同期だけ。degit も npm も呼ばない。
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SYNC_KEEP, isVibeboardDir, listFiles, planSync, syncDir } = require('../dist/update.js');

function tree(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
}

test('planSync: 取り込み元に在るものは全部 copy、vendor 先にだけ在るものは remove', () => {
  const plan = planSync(['b.txt', 'a.txt', 'src/x.ts'], ['a.txt', 'src/old.ts', 'zzz']);
  assert.deepEqual(plan, { copy: ['a.txt', 'b.txt', 'src/x.ts'], remove: ['src/old.ts', 'zzz'] });
});

test('listFiles: 直下の node_modules / dist / .git は入らず、深い同名は入る', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-list-'));
  try {
    tree(dir, { 'a.txt': '', 'node_modules/x/index.js': '', 'dist/cli.js': '', '.git/HEAD': '', 'src/dist/keep.ts': '' });
    assert.deepEqual(listFiles(dir), ['a.txt', 'src/dist/keep.ts']);
    assert.deepEqual(SYNC_KEEP, ['node_modules', 'dist', '.git']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('syncDir: 上書き・追加・削除をし、node_modules / dist は残し、実行ビットを写し、空ディレクトリを畳む', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-sync-'));
  const src = path.join(base, 'src');
  const dest = path.join(base, 'dest');
  try {
    tree(src, { 'package.json': '{"name":"vibeboard"}', 'run.sh': '#!/bin/sh\n', 'src/new.ts': 'new', 'src/same.ts': 'v2' });
    fs.chmodSync(path.join(src, 'run.sh'), 0o755);
    tree(dest, {
      'package.json': '{"name":"vibeboard"}', 'src/same.ts': 'v1', 'src/gone/old.ts': 'old',
      'node_modules/dep/index.js': 'dep', 'dist/cli.js': 'built',
    });
    const dry = syncDir(src, dest, { dryRun: true });
    assert.deepEqual(dry.remove, ['src/gone/old.ts']);
    assert.equal(fs.readFileSync(path.join(dest, 'src/same.ts'), 'utf8'), 'v1'); // dry-run は触らない

    const plan = syncDir(src, dest);
    assert.deepEqual(plan.copy, ['package.json', 'run.sh', 'src/new.ts', 'src/same.ts']);
    assert.deepEqual(plan.remove, ['src/gone/old.ts']);
    assert.equal(fs.readFileSync(path.join(dest, 'src/same.ts'), 'utf8'), 'v2');
    assert.equal(fs.readFileSync(path.join(dest, 'src/new.ts'), 'utf8'), 'new');
    assert.ok(!fs.existsSync(path.join(dest, 'src/gone'))); // 空になったディレクトリは畳む
    assert.equal(fs.readFileSync(path.join(dest, 'node_modules/dep/index.js'), 'utf8'), 'dep');
    assert.equal(fs.readFileSync(path.join(dest, 'dist/cli.js'), 'utf8'), 'built');
    assert.ok(fs.statSync(path.join(dest, 'run.sh')).mode & 0o100);
    assert.ok(isVibeboardDir(dest));
    assert.ok(!isVibeboardDir(base));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
