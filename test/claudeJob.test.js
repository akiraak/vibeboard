// `npm test` で走る（先に `npm run build` が要る。dist/claudeJob.js を読む）。
// 実物の claude は呼ばない。偽の実行ファイル（node スクリプト）に差し替えて、
// 直列化・タイムアウト・事後検査（文面の個数の増加）だけを見る。
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ALLOWED_TOOLS, DISALLOWED_TOOLS, ClaudeJobRunner, buildArgs, probeClaude } = require('../dist/claudeJob.js');
const { buildAddTaskPrompt, parseTodo } = require('../dist/todo.js');

function tmpProject(todo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-claudejob-'));
  fs.writeFileSync(path.join(dir, 'TODO.md'), todo, 'utf-8');
  return dir;
}

// 偽 claude。stdin を全部読んでから body を実行する（stdin を読まないと書き手が詰まりうる）
function fakeClaude(dir, name, body) {
  const p = path.join(dir, name);
  const script = [
    '#!/usr/bin/env node',
    "'use strict';",
    "const fs = require('node:fs');",
    "let stdin = '';",
    "process.stdin.on('data', d => { stdin += d; });",
    "process.stdin.on('end', () => { (async () => {",
    body,
    '  })(); });',
  ].join('\n');
  fs.writeFileSync(p, script, { mode: 0o755 });
  return p;
}

async function until(fn, timeoutMs = 10000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('until: 時間切れ');
    await new Promise(r => setTimeout(r, 25));
  }
}

function job(runner, text, extra = {}) {
  return runner.enqueue({
    text,
    needle: text.split('\n')[0].trim(),
    parentId: null,
    parentText: null,
    prompt: `add: ${text}`,
    ...extra,
  });
}

test('buildArgs: -p と許可・拒否のツールが入り、model は指定時だけ付く', () => {
  const base = buildArgs();
  assert.equal(base[0], '-p');
  assert.ok(base.includes(ALLOWED_TOOLS));
  assert.ok(base.includes(DISALLOWED_TOOLS));
  assert.equal(ALLOWED_TOOLS, 'Edit(TODO.md)');
  assert.ok(DISALLOWED_TOOLS.includes('Bash'));
  assert.ok(DISALLOWED_TOOLS.includes('Write'));
  assert.ok(!base.includes('--model'));
  const withModel = buildArgs('haiku');
  assert.ok(withModel.includes('--model'));
  assert.ok(withModel.includes('haiku'));
});

test('直列: 2 件入れると 1 本ずつ順に走る', async () => {
  const dir = tmpProject('# TODO\n\n- [ ] 既存\n');
  const bin = fakeClaude(dir, 'fake-append.js', [
    "  await new Promise(r => setTimeout(r, 150));",
    "  const needle = stdin.replace(/^add: /, '').split('\\n')[0].trim();",
    "  fs.appendFileSync('TODO.md', `- [ ] ${needle}\\n`);",
    "  fs.appendFileSync('order.log', `${needle}\\n`);",
  ].join('\n'));
  const runner = new ClaudeJobRunner({ cwd: dir, todoAbsPath: path.join(dir, 'TODO.md'), bin });
  const j1 = job(runner, 'ジョブ A');
  const j2 = job(runner, 'ジョブ B');
  await until(() => j1.state === 'done' && j2.state === 'done');
  const order = fs.readFileSync(path.join(dir, 'order.log'), 'utf-8').trim().split('\n');
  assert.deepEqual(order, ['ジョブ A', 'ジョブ B']);
  assert.ok(j2.startedAt >= j1.endedAt, '2 本目は 1 本目が終わってから始まる');
  const todo = fs.readFileSync(path.join(dir, 'TODO.md'), 'utf-8');
  assert.ok(todo.includes('ジョブ A') && todo.includes('ジョブ B'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('タイムアウト: 書かずに居座る実行は止めて失敗にする', async () => {
  const dir = tmpProject('# TODO\n');
  const bin = fakeClaude(dir, 'fake-sleep.js', "  await new Promise(r => setTimeout(r, 60000));");
  const runner = new ClaudeJobRunner({
    cwd: dir, todoAbsPath: path.join(dir, 'TODO.md'), bin, timeoutMs: 300,
  });
  const j = job(runner, '終わらないジョブ');
  await until(() => j.state === 'failed');
  assert.match(j.error, /時間切れ/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('事後検査: 正常終了でも TODO.md に文面が増えていなければ失敗', async () => {
  const dir = tmpProject('# TODO\n');
  const bin = fakeClaude(dir, 'fake-noop.js', "  process.stdout.write('やったつもり');");
  const runner = new ClaudeJobRunner({ cwd: dir, todoAbsPath: path.join(dir, 'TODO.md'), bin });
  const j = job(runner, '書かれないジョブ');
  await until(() => j.state === 'failed');
  assert.match(j.error, /TODO\.md に文面が入りませんでした/);
  assert.match(j.output, /やったつもり/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('事後検査: 同じ文面が元からあっても「個数の増加」で見る', async () => {
  // Phase 0: のような、他のタスクにも同じ文面がある場合の誤判定を防ぐ
  const seeded = '# TODO\n\n- [ ] 親 1\n  - [ ] Phase 0: 設計\n';
  {
    const dir = tmpProject(seeded);
    const bin = fakeClaude(dir, 'fake-noop.js', "  ;");
    const runner = new ClaudeJobRunner({ cwd: dir, todoAbsPath: path.join(dir, 'TODO.md'), bin });
    const j = job(runner, 'Phase 0: 設計');
    await until(() => j.state === 'failed');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const dir = tmpProject(seeded);
    const bin = fakeClaude(dir, 'fake-append.js', [
      "  const needle = stdin.replace(/^add: /, '').split('\\n')[0].trim();",
      "  fs.appendFileSync('TODO.md', `  - [ ] ${needle}\\n`);",
    ].join('\n'));
    const runner = new ClaudeJobRunner({ cwd: dir, todoAbsPath: path.join(dir, 'TODO.md'), bin });
    const j = job(runner, 'Phase 0: 設計');
    await until(() => j.state === 'done');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('起動できない実行ファイルは失敗として出る', async () => {
  const dir = tmpProject('# TODO\n');
  const runner = new ClaudeJobRunner({
    cwd: dir, todoAbsPath: path.join(dir, 'TODO.md'), bin: path.join(dir, 'no-such-bin'),
  });
  const j = job(runner, '起動しないジョブ');
  await until(() => j.state === 'failed');
  assert.match(j.error, /起動に失敗しました/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('probeClaude: 動く実行ファイルは true、無いものは false', async () => {
  assert.equal(await probeClaude(process.execPath), true);
  assert.equal(await probeClaude('/no/such/claude-binary'), false);
});

const SAMPLE = [
  '# TODO',
  '',
  '- [ ] 親のタスク',
  '  - [ ] 子のタスク',
  '',
].join('\n');

test('buildAddTaskPrompt: 文面・メモ・禁止事項が入る（トップレベル）', () => {
  const tree = parseTodo(SAMPLE);
  const p = buildAddTaskPrompt(tree, null, '新しいタスク\n付けるメモの行');
  assert.ok(p.includes('新しいタスク'));
  assert.ok(p.includes('付けるメモの行'));
  assert.ok(p.includes('一字一句そのまま'));
  assert.ok(p.includes('TODO.md 以外のファイルは変更しない'));
  assert.ok(p.includes('トップレベル'));
});

test('buildAddTaskPrompt: 親があれば部分木が入り、親が無ければ null', () => {
  const tree = parseTodo(SAMPLE);
  const parent = tree.sections.flatMap(s => s.tasks).find(t => t.text === '親のタスク');
  const p = buildAddTaskPrompt(tree, parent.id, '孫のタスク');
  assert.ok(p.includes('親タスクの子'));
  assert.ok(p.includes('- [ ] 親のタスク'));
  assert.ok(p.includes('- [ ] 子のタスク'), '部分木ごと prompt に入る');
  assert.equal(buildAddTaskPrompt(tree, 'no-such-id', '孫のタスク'), null);
  assert.equal(buildAddTaskPrompt(tree, null, '   '), null, '空の文面は null');
});
