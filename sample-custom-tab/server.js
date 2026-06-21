#!/usr/bin/env node
// vibeboard customTabs 用の最小ダミーサーバ。
//   GET /api/sidebar    : 固定 items を返す
//   GET /view?item=<id> : item に応じた HTML を返す
//   GET /api/watch      : SSE。15 秒ごとに item-changed を投げる
//
// 起動例:
//   node vibeboard/sample-custom-tab/server.js --port 8181
'use strict';

const http = require('http');

const PORT = (() => {
  const i = process.argv.indexOf('--port');
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return 8181;
})();

const ITEMS = [
  { id: 'overview', label: 'Overview', sub: 'プラグインサンプル', group: 'dashboard' },
  { id: 'alpha',    label: 'alpha',    sub: '/tmp/alpha',         group: 'processes' },
  { id: 'beta',     label: 'beta',     sub: '/tmp/beta',          group: 'processes', badge: '●' },
];

function corsHeaders(extra = {}) {
  return Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  }, extra);
}

function viewHtml(itemId) {
  const now = new Date().toISOString();
  const safe = String(itemId).replace(/</g, '&lt;');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${safe}</title>
<style>
 body { font: 14px/1.6 system-ui, sans-serif; padding: 16px; color: #111; }
 .meta { color: #666; font-size: 12px; }
</style></head>
<body>
 <h1>${safe}</h1>
 <div class="meta">最終生成: ${now}</div>
 <p>これは vibeboard customTabs の動作確認用ダミーページです。</p>
</body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/sidebar') {
    res.writeHead(200, corsHeaders({ 'Content-Type': 'application/json' }));
    res.end(JSON.stringify({ items: ITEMS }));
    return;
  }

  if (url.pathname === '/view') {
    const id = url.searchParams.get('item') || '';
    res.writeHead(200, corsHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "frame-ancestors http://127.0.0.1:*",
    }));
    res.end(viewHtml(id));
    return;
  }

  if (url.pathname === '/api/watch') {
    res.writeHead(200, corsHeaders({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Connection': 'keep-alive',
    }));
    let i = 0;
    const tick = setInterval(() => {
      const target = ITEMS[i % ITEMS.length];
      i++;
      res.write(`event: item-changed\ndata: ${JSON.stringify({ id: target.id })}\n\n`);
    }, 15000);
    const ping = setInterval(() => res.write(`: ping\n\n`), 30000);
    req.on('close', () => { clearInterval(tick); clearInterval(ping); });
    return;
  }

  res.writeHead(404, corsHeaders({ 'Content-Type': 'text/plain' }));
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[sample-custom-tab] listening on http://127.0.0.1:${PORT}`);
});
