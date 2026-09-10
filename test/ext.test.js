// `npm test` で走る（先に `npm run build` が要る。dist/ext.js を読む）。
// 純関数（ヘッダの除去・パスの検査・中継先 URL）と、実 HTTP サーバ 2 つを
// エフェメラルポートで立てた中継の通し（status / body / ヘッダ / 502）を見る。
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { DROP_HEADERS, buildTargetUrl, forwardHeaders, proxyToTab, validSuffix } = require('../dist/ext.js');

test('forwardHeaders: hop-by-hop と Host を落とし、それ以外は残す', () => {
  const out = forwardHeaders({
    host: '127.0.0.1:3010',
    connection: 'keep-alive',
    'transfer-encoding': 'chunked',
    accept: 'text/html',
    'x-custom': 'a',
  });
  assert.deepEqual(out, { accept: 'text/html', 'x-custom': 'a' });
});

test('DROP_HEADERS: RFC 9110 の hop-by-hop が入っている', () => {
  for (const h of ['connection', 'te', 'upgrade', 'transfer-encoding', 'host']) {
    assert.ok(DROP_HEADERS.has(h), h);
  }
});

test('validSuffix: 空と / と通常のパス（クエリ込み）は通す', () => {
  assert.equal(validSuffix(''), true);
  assert.equal(validSuffix('/'), true);
  assert.equal(validSuffix('/api/sidebar'), true);
  assert.equal(validSuffix('/view?item=a%2Fb&_t=1'), true);
});

test('validSuffix: 先頭が / でない・ドットセグメント・壊れた encode は弾く', () => {
  assert.equal(validSuffix('api/sidebar'), false);
  assert.equal(validSuffix('/a/../b'), false);
  assert.equal(validSuffix('/a/./b'), false);
  assert.equal(validSuffix('/%2e%2e/secret'), false);
  assert.equal(validSuffix('/%zz'), false);
});

test('buildTargetUrl: baseUrl のパス prefix に残りを繋ぐ', () => {
  assert.equal(
    buildTargetUrl('http://127.0.0.1:3015/experiments', '/api/sidebar?x=1').href,
    'http://127.0.0.1:3015/experiments/api/sidebar?x=1',
  );
  assert.equal(buildTargetUrl('http://127.0.0.1:8181', '').href, 'http://127.0.0.1:8181/');
});

/** handler で応える http サーバをエフェメラルポートで立てる */
function listen(handler) {
  return new Promise(resolve => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, res => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

test('proxyToTab: status / body / ヘッダ / パス / クエリが素通しになる', async () => {
  const seen = {};
  const backend = await listen((req, res) => {
    seen.url = req.url;
    seen.host = req.headers.host;
    seen.custom = req.headers['x-from-client'];
    res.writeHead(201, { 'Content-Type': 'application/json', 'X-From-Plugin': 'yes' });
    res.end('{"ok":true}');
  });
  const tab = { name: 'sample', label: 'Sample', baseUrl: `http://127.0.0.1:${backend.port}/pre`, command: null };
  const front = await listen((req, res) => proxyToTab(tab, req.url, req, res));
  try {
    const r = await get(`http://127.0.0.1:${front.port}/api/sidebar?q=1`, { 'X-From-Client': 'abc' });
    assert.equal(r.status, 201);
    assert.equal(r.body, '{"ok":true}');
    assert.equal(r.headers['x-from-plugin'], 'yes');
    assert.equal(seen.url, '/pre/api/sidebar?q=1');
    assert.equal(seen.custom, 'abc');
    // Host はプラグイン側のものになる（閲覧者のホスト名を写さない）
    assert.equal(seen.host, `127.0.0.1:${backend.port}`);
  } finally {
    front.srv.close();
    backend.srv.close();
  }
});

/** URL 正規化を通さず、path をそのまま送る GET（`..` を殺さないため） */
function rawGet(port, path) {
  return new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port, path }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    }).on('error', reject).end();
  });
}

test('proxyToTab: 上流が居なければ 502、ドットセグメントは 400', async () => {
  const tab = { name: 'dead', label: 'Dead', baseUrl: 'http://127.0.0.1:9', command: null };
  const front = await listen((req, res) => proxyToTab(tab, req.url, req, res));
  try {
    const r = await get(`http://127.0.0.1:${front.port}/api/sidebar`);
    assert.equal(r.status, 502);
    const bad = await rawGet(front.port, '/a/../b');
    assert.equal(bad.status, 400);
  } finally {
    front.srv.close();
  }
});
