// `npm test` で走る（先に `npm run build` が要る。dist/init.js を読む）。
// CLAUDE.md に書く定型文の組み立て（planInit）だけを見る。ファイルは書かない（dryRun）。
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planInit } = require('../dist/init.js');

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeboard-init-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('planInit: 定型文のプランの置き場所は既定で docs/plans', (t) => {
  const { nextContent, action } = planInit({ root: tempRoot(t), dryRun: true });
  assert.equal(action, 'create');
  assert.match(nextContent, /`docs\/plans\/<task-name>\.md` に実装プラン/);
  assert.match(nextContent, /`docs\/plans\/archive\/` に移動する/);
  assert.doesNotMatch(nextContent, /\{\{/);
});

test('planInit: 渡したプランの置き場所を定型文のすべての箇所に差し込む', (t) => {
  const { nextContent } = planInit({ root: tempRoot(t), dryRun: true, plansDir: 'notes/plans' });
  assert.match(nextContent, /`notes\/plans\/<task-name>\.md` に実装プラン/);
  assert.match(nextContent, /\[plan\]\(notes\/plans\/foo\.md\)/);
  assert.match(nextContent, /`notes\/plans\/archive\/` に移動する/);
  assert.doesNotMatch(nextContent, /docs\/plans/);
  assert.doesNotMatch(nextContent, /\{\{/);
});
