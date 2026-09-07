// `npm test` で走る（先に `npm run build` が要る。dist/tasks.js と dist/init.js を読む）。
// 見ているのは純関数と、テスト内で立てた Unix ソケットへの投函だけ。Claude Code の実物は使わない。
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {
  TaskQueue,
  WAIT_EXPIRED_ERROR,
  enqueue,
  expire,
  findInboxSocket,
  inboxSocketCandidates,
  isUnder,
  parseAgentsJson,
  postToInbox,
  queueFilePath,
  retry,
  transition,
} = require('../dist/tasks.js');
const { hookCommand, isOurHook, mergeHooks } = require('../dist/init.js');

// 2026-09-07 に実機で控えた `claude agents --json --all` の形（sessionId 等は架空の値に差し替え）
const AGENTS = JSON.stringify([
  { id: '624af320', cwd: '/tmp/scratch/agentproj', kind: 'background', startedAt: 1, sessionId: 'aaaa-1', name: 'todo-3b779fbe', state: 'stopped' },
  { pid: 3377, cwd: '/home/u/daily-note', kind: 'interactive', startedAt: 2, sessionId: 'bbbb-2', name: 'daily-note-0b', status: 'busy' },
  { id: '81a62886', cwd: '/home/u/daily-note', kind: 'background', startedAt: 3, sessionId: 'cccc-3', name: 'todo-725c90a4', state: 'blocked', waitingFor: 'permission prompt' },
  { pid: 351180, cwd: '/home/u/ai-income-lab', kind: 'interactive', startedAt: 4, sessionId: 'dddd-4', name: 'ai-income-lab-41', status: 'idle' },
  { pid: 1, cwd: '/home/u/ai-income-lab/sub/dir', kind: 'interactive', sessionId: 'eeee-5', status: 'idle' },
  { pid: 2, cwd: '/home/u/ai-income-lab', kind: 'interactive', name: 'no-session-id' },
  { pid: 3, cwd: '/home/u/ai-income-lab-2', kind: 'interactive', sessionId: 'ffff-6', name: 'prefix-trap', status: 'idle' },
]);

test('isUnder: root そのものと配下だけ（前方一致の罠を踏まない）', () => {
  assert.equal(isUnder('/a/b', '/a/b'), true);
  assert.equal(isUnder('/a/b', '/a/b/c'), true);
  assert.equal(isUnder('/a/b', '/a/bc'), false);
  assert.equal(isUnder('/a/b', '/a'), false);
});

test('parseAgentsJson: root 配下だけ、終わった background と sessionId 無しは落とす', () => {
  const list = parseAgentsJson(AGENTS, '/home/u/ai-income-lab');
  assert.deepEqual(list.map(s => s.sessionId), ['dddd-4', 'eeee-5']);
  assert.equal(list[0].name, 'ai-income-lab-41');
  assert.equal(list[0].status, 'idle');
  assert.equal(list[0].kind, 'interactive');
  assert.equal(list[0].pid, 351180);
  assert.equal(list[1].name, 'eeee-5'.slice(0, 8)); // 名前が無ければ sessionId の先頭
});

test('parseAgentsJson: background は state を status に、shortId と waitingFor を持つ', () => {
  const list = parseAgentsJson(AGENTS, '/home/u/daily-note');
  assert.deepEqual(list.map(s => s.sessionId), ['bbbb-2', 'cccc-3']);
  const bg = list[1];
  assert.equal(bg.kind, 'background');
  assert.equal(bg.status, 'blocked');
  assert.equal(bg.shortId, '81a62886');
  assert.equal(bg.waitingFor, 'permission prompt');
});

test('parseAgentsJson: 読めない入力は空', () => {
  assert.deepEqual(parseAgentsJson('not json', '/x'), []);
  assert.deepEqual(parseAgentsJson('{"a":1}', '/x'), []);
  assert.deepEqual(parseAgentsJson('[1, null, "s"]', '/x'), []);
});

const INPUT = { taskId: 't1', text: '親のタスク', kind: 'run', prompt: 'やって', sessionId: 'dddd-4' };

test('queue: 待ち → 投函済み / 失敗 → 再送、の遷移', () => {
  const t0 = 1_000_000;
  const { items, item } = enqueue([], INPUT, t0);
  assert.equal(item.state, 'waiting');
  assert.equal(item.at, t0);
  const posted = transition(items, item.id, 'posted', t0 + 10);
  assert.equal(posted[0].state, 'posted');
  assert.equal(posted[0].updatedAt, t0 + 10);
  assert.equal(posted[0].error, null);
  const failed = transition(items, item.id, 'failed', t0 + 20, 'ENOENT');
  assert.equal(failed[0].state, 'failed');
  assert.equal(failed[0].error, 'ENOENT');
  const again = retry(failed, item.id, t0 + 30);
  assert.equal(again[0].state, 'waiting');
  assert.equal(again[0].error, null);
  // 投函済みは再送しない
  assert.equal(retry(posted, item.id, t0 + 40)[0].state, 'posted');
});

test('queue: 時間で「待ち」は失敗に、古い投函済み / 失敗は消える', () => {
  const t0 = 1_000_000;
  const { items } = enqueue([], INPUT, t0);
  const min = 60 * 1000;
  assert.equal(expire(items, t0 + 4 * min)[0].state, 'waiting');
  const late = expire(items, t0 + 5 * min);
  assert.equal(late[0].state, 'failed');
  assert.equal(late[0].error, WAIT_EXPIRED_ERROR);
  const posted = transition(items, items[0].id, 'posted', t0);
  assert.equal(expire(posted, t0 + 9 * min).length, 1);
  assert.equal(expire(posted, t0 + 10 * min).length, 0);
  const failed = transition(items, items[0].id, 'failed', t0, 'x');
  assert.equal(expire(failed, t0 + 59 * min).length, 1);
  assert.equal(expire(failed, t0 + 60 * min).length, 0);
});

test('TaskQueue: tmp の JSON に残り、読み直しても同じ。時計は注入できる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-tasks-'));
  const file = queueFilePath('/some/root', dir);
  assert.match(path.basename(file), /^vibeboard-tasks-[0-9a-f]{8}\.json$/);
  let now = 1_000_000;
  const q = new TaskQueue('/some/root', { file, now: () => now });
  const item = q.add(INPUT);
  assert.equal(q.list().length, 1);
  const q2 = new TaskQueue('/some/root', { file, now: () => now });
  assert.equal(q2.get(item.id).state, 'waiting');
  q2.update(item.id, 'failed', 'boom');
  assert.equal(q.get(item.id).error, 'boom');
  assert.equal(q.retry(item.id).state, 'waiting');
  now += 5 * 60 * 1000;
  assert.equal(q.get(item.id).state, 'failed'); // 待ちすぎ
  assert.equal(q.dismiss(item.id), true);
  assert.equal(q.dismiss(item.id), false);
  assert.deepEqual(q.list(), []);
  // 壊れたファイルは空として扱う（落ちない）
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(new TaskQueue('/some/root', { file }).list(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

function listenOnce(sockPath) {
  // 受信口の代わり: 届いた行を集めて、こちらから閉じる
  return new Promise(resolve => {
    const lines = [];
    const server = net.createServer(conn => {
      let buf = '';
      conn.on('data', d => { buf += d; });
      conn.on('end', () => {
        lines.push(...buf.split('\n').filter(Boolean));
        conn.end();
        server.close(() => resolve(lines));
      });
    });
    server.listen(sockPath);
  });
}

test('postToInbox: auth 行と user 行が 1 行ずつ届く', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-sock-'));
  const sock = path.join(dir, 'in.sock');
  const got = listenOnce(sock);
  await postToInbox(sock, 'こんにちは\n2 行目', { token: 'tok' });
  const lines = await got;
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { type: 'auth', token: 'tok' });
  assert.deepEqual(JSON.parse(lines[1]), { type: 'user', message: { role: 'user', content: 'こんにちは\n2 行目' } });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('postToInbox: token が無ければ user 行だけ（Linux では auth 行は省略可）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-sock-'));
  const sock = path.join(dir, 'in.sock');
  const got = listenOnce(sock);
  await postToInbox(sock, 'x');
  const lines = await got;
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).type, 'user');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('postToInbox: ソケットが無ければ ENOENT で reject', async () => {
  await assert.rejects(postToInbox(path.join(os.tmpdir(), 'vb-no-such.sock'), 'x'), err => err.code === 'ENOENT');
});

test('postToInbox: peer が閉じなくても、書き終えていれば時間切れで成功', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-sock-'));
  const sock = path.join(dir, 'in.sock');
  const conns = [];
  const server = net.createServer(c => { conns.push(c); c.on('data', () => undefined); });
  await new Promise(r => server.listen(sock, r));
  await postToInbox(sock, 'x', { timeoutMs: 200 });
  for (const c of conns) c.destroy();
  await new Promise(r => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

// === vibeboard init の hooks ===

test('inboxSocketCandidates: XDG_RUNTIME_DIR → /run/user/<uid> → tmp の順。重複なし', () => {
  const c = inboxSocketCandidates(4242, { XDG_RUNTIME_DIR: '/run/user/1000' }, 1000, '/tmp');
  assert.equal(c[0], '/run/user/1000/cc-socks/4242.sock');
  assert.ok(c.includes('/tmp/cc-socks-1000/4242.sock'));
  assert.ok(c.includes('/tmp/cc-socks/4242.sock'));
  assert.equal(new Set(c).size, c.length);
  // XDG_RUNTIME_DIR が無く uid も取れない（POSIX 以外）なら tmp だけ
  assert.deepEqual(inboxSocketCandidates(7, {}, null, '/var/tmp'), ['/var/tmp/cc-socks/7.sock', '/tmp/cc-socks/7.sock']);
});

test('findInboxSocket: 実在するソケットだけを返し、普通のファイルや無い場所は飛ばす', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-socks-'));
  const sockPath = path.join(dir, '4242.sock');
  const filePath = path.join(dir, '4243.sock');
  fs.writeFileSync(filePath, 'not a socket');
  const server = net.createServer(() => undefined);
  await new Promise(resolve => server.listen(sockPath, resolve));
  try {
    assert.equal(findInboxSocket(4242, [path.join(dir, 'missing', '4242.sock'), sockPath]), sockPath);
    assert.equal(findInboxSocket(4243, [filePath]), null);
    assert.equal(findInboxSocket(1, [path.join(dir, '1.sock')]), null);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hookCommand: vibeboard が root の中なら root 相対、外なら絶対', () => {
  assert.equal(
    hookCommand('/p', '/p/vibeboard'),
    'node "${CLAUDE_PROJECT_DIR:-.}/vibeboard/scripts/session-hook.mjs"',
  );
  assert.equal(hookCommand('/p', '/p/tools/vb'), 'node "${CLAUDE_PROJECT_DIR:-.}/tools/vb/scripts/session-hook.mjs"');
  assert.equal(hookCommand('/p', '/elsewhere/vibeboard'), 'node "/elsewhere/vibeboard/scripts/session-hook.mjs"');
  assert.equal(isOurHook({ type: 'command', command: hookCommand('/p', '/p/vibeboard') }), true);
  assert.equal(isOurHook({ type: 'command', command: 'echo hi' }), false);
});

const CMD = 'node "${CLAUDE_PROJECT_DIR:-.}/vibeboard/scripts/session-hook.mjs"';

test('mergeHooks: 空の設定に SessionStart / SessionEnd を足す。2 回目は変わらない', () => {
  const first = mergeHooks({}, CMD);
  assert.equal(first.changed, true);
  const h = first.next.hooks;
  assert.equal(h.SessionStart.length, 1);
  assert.deepEqual(h.SessionStart[0], { hooks: [{ type: 'command', command: `${CMD} SessionStart`, async: true }] });
  assert.deepEqual(h.SessionEnd[0], { hooks: [{ type: 'command', command: `${CMD} SessionEnd`, timeout: 3 }] });
  const second = mergeHooks(first.next, CMD);
  assert.equal(second.changed, false);
  assert.deepEqual(second.next, first.next);
});

test('mergeHooks: 他の hooks は残し、自分の古い項目だけ置き換える（混在グループは自分のぶんだけ抜く）', () => {
  const old = 'node "/old/place/vibeboard/scripts/session-hook.mjs"';
  const settings = {
    model: 'x',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }],
      SessionStart: [
        { matcher: 'startup', hooks: [{ type: 'command', command: 'echo other' }, { type: 'command', command: old }] },
        { hooks: [{ type: 'command', command: old, async: true }] },
      ],
    },
  };
  const { next, changed } = mergeHooks(settings, CMD);
  assert.equal(changed, true);
  assert.equal(next.model, 'x');
  assert.deepEqual(next.hooks.Stop, settings.hooks.Stop);
  const starts = next.hooks.SessionStart;
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[0], { matcher: 'startup', hooks: [{ type: 'command', command: 'echo other' }] });
  assert.deepEqual(starts[1].hooks, [{ type: 'command', command: `${CMD} SessionStart`, async: true }]);
  const ours = starts.flatMap(g => g.hooks).filter(isOurHook);
  assert.equal(ours.length, 1);
  assert.equal(next.hooks.SessionEnd.length, 1);
  // 元のオブジェクトは変えない
  assert.equal(settings.hooks.SessionStart.length, 2);
  assert.equal(settings.hooks.SessionStart[0].hooks.length, 2);
});
