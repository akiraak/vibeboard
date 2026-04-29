import fs from 'fs';
import path from 'path';

export interface InitOptions {
  root: string;
  dryRun: boolean;
}

export interface InitResult {
  action: 'create' | 'replace' | 'append' | 'unchanged';
  claudeMdPath: string;
  nextContent: string;
  prevContent: string;
}

const BEGIN_MARKER = '<!-- vibeboard:begin -->';
const END_MARKER = '<!-- vibeboard:end -->';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveTemplatePath(): string {
  // dist/init.js から見ると ../src/templates/...、src/init.ts (ts-node) から見ると ../templates/...
  const candidates = [
    path.join(__dirname, '..', 'src', 'templates', 'claude-md-snippet.md'),
    path.join(__dirname, 'templates', 'claude-md-snippet.md'),
    path.join(__dirname, '..', 'templates', 'claude-md-snippet.md'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`claude-md-snippet.md が見つかりませんでした (探索: ${candidates.join(', ')})`);
}

function buildBlock(snippet: string): string {
  return `${BEGIN_MARKER}\n${snippet.trimEnd()}\n${END_MARKER}`;
}

export function planInit(opts: InitOptions): InitResult {
  const claudeMdPath = path.join(opts.root, 'CLAUDE.md');
  const templatePath = resolveTemplatePath();
  const snippet = fs.readFileSync(templatePath, 'utf-8');
  const block = buildBlock(snippet);

  let prevContent = '';
  let action: InitResult['action'];
  let nextContent: string;

  if (fs.existsSync(claudeMdPath)) {
    prevContent = fs.readFileSync(claudeMdPath, 'utf-8');
    const re = new RegExp(`${escapeRegExp(BEGIN_MARKER)}[\\s\\S]*?${escapeRegExp(END_MARKER)}`);
    if (re.test(prevContent)) {
      nextContent = prevContent.replace(re, block);
      action = nextContent === prevContent ? 'unchanged' : 'replace';
    } else {
      const sep = prevContent.length === 0
        ? ''
        : prevContent.endsWith('\n\n') ? '' : prevContent.endsWith('\n') ? '\n' : '\n\n';
      nextContent = prevContent + sep + block + '\n';
      action = 'append';
    }
  } else {
    nextContent = block + '\n';
    action = 'create';
  }

  return { action, claudeMdPath, nextContent, prevContent };
}

export function runInit(opts: InitOptions): void {
  const result = planInit(opts);
  const label = actionLabel(result.action);

  if (opts.dryRun) {
    console.log(`[vibeboard init] dry-run: ${result.claudeMdPath} を ${label}します`);
    if (result.action === 'unchanged') {
      console.log('（変更はありません）');
      return;
    }
    console.log('--- 書き込み後の内容 ---');
    console.log(result.nextContent);
    console.log('--- ここまで ---');
    return;
  }

  if (result.action === 'unchanged') {
    console.log(`[vibeboard init] ${result.claudeMdPath} は既に最新です（変更なし）`);
    return;
  }

  fs.writeFileSync(result.claudeMdPath, result.nextContent, 'utf-8');
  console.log(`[vibeboard init] ${result.claudeMdPath} を${label}しました`);
}

function actionLabel(a: InitResult['action']): string {
  switch (a) {
    case 'create': return '新規作成';
    case 'replace': return 'マーカー間を置換';
    case 'append': return '末尾に追記';
    case 'unchanged': return '変更なしで保持';
  }
}
