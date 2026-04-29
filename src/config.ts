import fs from 'fs';
import path from 'path';

export interface VibeboardConfig {
  root: string;
  port: number;
  host: string;
  title: string;
}

interface ParsedArgs {
  root?: string;
  port?: number;
  title?: string;
  rest: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' || a === '--port' || a === '--title') {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} の値が指定されていません`);
      if (a === '--root') out.root = v;
      else if (a === '--port') {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`--port の値が不正です: ${v}`);
        out.port = n;
      } else out.title = v;
      i++;
      continue;
    }
    const m = a.match(/^--(root|port|title)=(.*)$/);
    if (m) {
      if (m[1] === 'port') {
        const n = Number(m[2]);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`--port の値が不正です: ${m[2]}`);
        out.port = n;
      } else if (m[1] === 'root') out.root = m[2];
      else out.title = m[2];
      continue;
    }
    out.rest.push(a);
  }
  return out;
}

function deriveTitleFromRoot(root: string): string {
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: unknown };
      if (typeof pkg.name === 'string' && pkg.name.trim()) return pkg.name.trim();
    } catch {
      // 無視してフォールバック
    }
  }
  const base = path.basename(path.resolve(root));
  return base || 'vibeboard';
}

export function resolveConfig(argv: string[]): { config: VibeboardConfig; rest: string[] } {
  const parsed = parseArgs(argv);

  const root = path.resolve(
    parsed.root
      ?? process.env.VIBEBOARD_ROOT
      ?? process.cwd()
  );
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`--root に指定されたパスがディレクトリとして存在しません: ${root}`);
  }

  const portEnv = process.env.VIBEBOARD_PORT ?? process.env.DEV_ADMIN_PORT;
  const port = parsed.port
    ?? (portEnv ? Number(portEnv) : undefined)
    ?? 3010;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`port の値が不正です: ${port}`);
  }

  const title = (parsed.title ?? process.env.VIBEBOARD_TITLE ?? '').trim()
    || deriveTitleFromRoot(root);

  return {
    config: { root, port, host: '127.0.0.1', title },
    rest: parsed.rest,
  };
}
