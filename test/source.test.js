// `npm test` で走る（先に `npm run build` が要る。dist/source.js を読む）。
// 一時ディレクトリの中だけで試す。
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeSourceAtomic } = require('../dist/source.js');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeboard-source-'));
  t.after(() => {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const modeOf = (file) => fs.statSync(file).mode & 0o7777;

for (const mode of [0o600, 0o644, 0o755]) {
  test(`writeSourceAtomic: 元の権限（${mode.toString(8)}）のまま中身だけ置き換え、tmp を残さない`, (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'OLD=1\n');
    fs.chmodSync(file, mode);

    writeSourceAtomic(file, 'NEW=2\n');

    assert.equal(fs.readFileSync(file, 'utf-8'), 'NEW=2\n');
    assert.equal(modeOf(file), mode);
    assert.deepEqual(fs.readdirSync(dir), ['.env']);
  });
}

test('writeSourceAtomic: 保存先がまだ無くても書ける', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'new.md');

  writeSourceAtomic(file, '# new\n');

  assert.equal(fs.readFileSync(file, 'utf-8'), '# new\n');
  assert.deepEqual(fs.readdirSync(dir), ['new.md']);
});

// root はディレクトリの書き込み権限を無視して tmp を作れてしまうので、失敗を起こせない
test('writeSourceAtomic: 書き込みに失敗したら投げ、元のファイルと権限はそのまま', { skip: process.getuid?.() === 0 }, (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'OLD=1\n');
  fs.chmodSync(file, 0o600);
  // ディレクトリに書けなくして、tmp を作れないようにする
  fs.chmodSync(dir, 0o500);

  assert.throws(() => writeSourceAtomic(file, 'NEW=2\n'), { code: 'EACCES' });

  assert.equal(fs.readFileSync(file, 'utf-8'), 'OLD=1\n');
  assert.equal(modeOf(file), 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['.env']);
});
