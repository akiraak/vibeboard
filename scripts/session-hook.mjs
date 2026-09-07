#!/usr/bin/env node
// Claude Code の SessionStart / SessionEnd hook。
// セッション自身の受信口（Unix ソケット）を vibeboard に登録 / 解除する。Tasks タブはここへ投函する。
//
// - stdin: hook の JSON（session_id / cwd / hook_event_name）
// - env:   CLAUDE_CODE_MESSAGING_SOCKET / CLAUDE_CODE_MESSAGING_TOKEN（Claude Code が hook に渡す）
// - port:  VIBEBOARD_PORT → <cwd>/vibeboard.config.json の port → 3010
//
// 守ること:
// - vibeboard が落ちていても 1 秒で諦めて exit 0（セッションの起動を止めない）
// - stdout には何も出さない（SessionStart の stdout は Claude の文脈に足される）
// - 依存なし（Node 18 以上の標準モジュールだけ）
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TIMEOUT_MS = 1000;

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let buf = '';
    const timer = setTimeout(() => resolve(buf), 700);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { buf += d; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(buf); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(buf); });
  });
}

function readPort(cwd) {
  const env = process.env.VIBEBOARD_PORT || process.env.DEV_ADMIN_PORT;
  if (env && Number(env) > 0) return Number(env);
  try {
    const raw = fs.readFileSync(path.join(cwd, 'vibeboard.config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg.port === 'number' && cfg.port > 0) return cfg.port;
  } catch {
    // 設定が無い / 読めない → 既定
  }
  return 3010;
}

function post(port, route, body) {
  return new Promise(resolve => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: TIMEOUT_MS,
      },
      res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('error', () => resolve(0));
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
    req.end(data);
  });
}

async function main() {
  let hook = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) hook = JSON.parse(raw);
  } catch {
    hook = {};
  }
  const event = String(hook.hook_event_name || process.argv[2] || '');
  const sessionId = String(hook.session_id || process.env.CLAUDE_CODE_SESSION_ID || '');
  const cwd = String(hook.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!sessionId) return;

  const port = readPort(cwd);
  if (event === 'SessionEnd') {
    await post(port, '/api/tasks/unregister', { sessionId });
    return;
  }
  // SessionStart（startup / resume / clear / compact のどれでも登録し直す。冪等）
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET || '';
  if (!socket) return; // 受信口の無いセッション（bare など）は登録しない
  await post(port, '/api/tasks/register', {
    sessionId,
    cwd,
    socket,
    token: process.env.CLAUDE_CODE_MESSAGING_TOKEN || null,
    pid: null,
  });
}

// どんな失敗でもセッションを止めない
const guard = setTimeout(() => process.exit(0), TIMEOUT_MS + 1500);
main().catch(() => undefined).finally(() => {
  clearTimeout(guard);
  process.exit(0);
});
