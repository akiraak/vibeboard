// customTab の中継（/ext/<name>/* → その customTab の baseUrl）。
//
// customTab は当初「ブラウザが baseUrl（127.0.0.1 のプラグイン）へ直接つなぐ」作りだったが、
// それだと vibeboard をリモートから見るとき（tailscale serve / ssh -L / LAN）に
// **閲覧側の** ループバックを叩いてしまいタブだけが死ぬ。そこで本体が同一オリジンの
// `/ext/<name>/...` で受けて baseUrl へ中継し、ブラウザには baseUrl を配らない。
//
// 決めていること:
//   - 中継先は **設定済み customTab の baseUrl だけ**（任意 URL への open proxy にはしない）
//   - ⚠ baseUrl に「接続元で権限を分けるサーバ」を指定しない（中継後はループバック発に見える）
//   - SSE（/api/watch）を素通しする: 応答はパイプで流し、タイムアウトは掛けない
//   - hop-by-hop ヘッダ（RFC 9110 7.6.1）と Host は写さない
//   - パスに `..` セグメントは通さない（プラグイン側の実装に頼らない）
import http from 'http';
import https from 'https';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'http';
import type { CustomTabConfig } from './config';

/** 転送しないヘッダ（小文字）。Host は中継先のものを http.request が付け直す */
export const DROP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

/** hop-by-hop と Host を除いたヘッダの写し（純関数） */
export function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (DROP_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/**
 * `/ext/<name>` を落とした残り（クエリ込み）が中継してよい形か（純関数）。
 * 空は `/` とみなす。`..` / `.` のセグメントは decode 後にも見て弾く。
 */
export function validSuffix(suffix: string): boolean {
  if (suffix === '' || suffix === '/') return true;
  if (!suffix.startsWith('/')) return false;
  const pathname = suffix.split('?')[0] as string;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  return !decoded.split('/').some(seg => seg === '..' || seg === '.');
}

/** 中継先 URL（純関数）。suffix は validSuffix を通ったもの */
export function buildTargetUrl(baseUrl: string, suffix: string): URL {
  return new URL(baseUrl + (suffix === '' ? '/' : suffix));
}

/** req を tab.baseUrl + suffix へ中継し、応答をそのまま res へ流す */
export function proxyToTab(
  tab: CustomTabConfig,
  suffix: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (!validSuffix(suffix)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad path');
    return;
  }
  const target = buildTargetUrl(tab.baseUrl, suffix);
  const mod = target.protocol === 'https:' ? https : http;
  const upstream = mod.request(
    target,
    { method: req.method, headers: forwardHeaders(req.headers) },
    ur => {
      res.writeHead(ur.statusCode ?? 502, forwardHeaders(ur.headers));
      ur.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`customTab ${tab.name} (${tab.baseUrl}) に接続できません`);
    } else {
      res.destroy();
    }
  });
  // 閲覧側が閉じたら上流も切る（SSE の購読を残さない）
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}
