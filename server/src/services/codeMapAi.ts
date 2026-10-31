import fs from 'node:fs/promises';
import path from 'node:path';
import { runOneShot } from './aiRunner.js';
import type { AiAgent } from './aiStore.js';
import { decodeBuffer } from './encoding.js';
import { norm } from './fsService.js';
import type { CodeItem, CodeLink, Rng } from './lsp.js';

/**
 * コードマップを AI (claude / codex の CLI) に作らせる。言語サーバの無い言語のための代わり。
 * 読み取り専用で 1 回きりの依頼をし、決めた形の JSON で返させて CodeItem / CodeLink に変換する。
 * 行番号だけを返させるので、ノードの位置は行の先頭になる (列までは求めない)。
 */

export type AiRelation = 'callers' | 'callees';

/** AI に返させる種類の名前 → LSP の SymbolKind */
const KIND_NAMES: Record<string, number> = {
  file: 1,
  module: 2,
  namespace: 3,
  package: 4,
  class: 5,
  method: 6,
  property: 7,
  field: 8,
  constructor: 9,
  enum: 10,
  interface: 11,
  function: 12,
  variable: 13,
  constant: 14,
  struct: 23,
  trait: 11,
  type: 26,
};

const KIND_LIST = 'class / interface / struct / enum / method / constructor / function / property / field / variable / module';

function kindName(kind: number): string {
  return Object.entries(KIND_NAMES).find(([, k]) => k === kind)?.[0] ?? 'function';
}

const lineRange = (line: number): Rng => ({ start: { line, character: 0 }, end: { line, character: 0 } });

const FORMAT = `回答は次の形式の JSON だけを \`\`\`json のコードブロックで返してください (説明の文章は不要です)。
{
  "symbol": { "name": "名前", "kind": "種類", "path": "作業フォルダからの相対パス", "line": 定義の行番号 },
  "callers": [ { "name": "...", "kind": "...", "path": "...", "line": 定義の行番号, "sites": [呼び出している行番号, ...] } ],
  "callees": [ { "name": "...", "kind": "...", "path": "...", "line": 定義の行番号, "sites": [呼び出している行番号, ...] } ]
}
- 行番号は 1 始まり。kind は ${KIND_LIST} のどれか
- callers の sites は呼び出し元のファイル内の行、callees の sites は対象のシンボルのファイル内の行
- 作業フォルダ内で定義されているものだけを挙げ、標準ライブラリ・外部ライブラリは除く。各一覧は最大 40 件`;

function relationText(relations: AiRelation[]): string {
  return relations
    .map((r) =>
      r === 'callers'
        ? '- callers: このシンボルを呼び出している / 参照している関数・メソッド・クラス'
        : '- callees: このシンボルの中から呼び出している / 使っている関数・メソッド・クラス',
    )
    .join('\n');
}

function preamble(cwd: string): string {
  return `ソースコードの静的解析を手伝ってください。ファイルは変更せず、読み取り (ファイルの閲覧と検索) だけで調べてください。
作業フォルダ: ${cwd}`;
}

interface AiEntry {
  name?: unknown;
  kind?: unknown;
  path?: unknown;
  line?: unknown;
  sites?: unknown;
}

/** 応答から JSON を取り出す (最後の ```json ブロック、無ければ最初の { から最後の } まで) */
function extractJson(text: string): Record<string, unknown> {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = [...blocks.reverse(), text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object') return v as Record<string, unknown>;
    } catch {
      /* 次の候補へ */
    }
  }
  throw Object.assign(new Error(`AI の応答を読み取れません: ${text.slice(0, 300)}`), { status: 502 });
}

function toItem(e: AiEntry, cwd: string): CodeItem | null {
  if (typeof e.name !== 'string' || typeof e.path !== 'string' || !e.name || !e.path) return null;
  const line = Math.max(0, Math.floor(Number(e.line) || 1) - 1);
  const kind = KIND_NAMES[String(e.kind ?? '').toLowerCase()] ?? 12;
  const r = lineRange(line);
  return { name: e.name, kind, path: norm(path.resolve(cwd, e.path)), range: r, selectionRange: r };
}

function toLinks(list: unknown, cwd: string, siteOf: (item: CodeItem) => string): CodeLink[] {
  if (!Array.isArray(list)) return [];
  const out: CodeLink[] = [];
  for (const e of list as AiEntry[]) {
    const item = toItem(e, cwd);
    if (!item) continue;
    const sites = Array.isArray(e.sites)
      ? e.sites.map((n) => Math.floor(Number(n)) - 1).filter((n) => n >= 0).map(lineRange)
      : [];
    out.push({ item, sitePath: siteOf(item), sites });
  }
  return out;
}

async function lineText(p: string, line: number): Promise<string> {
  try {
    return decodeBuffer(await fs.readFile(p)).content.split(/\r?\n/)[line]?.trim().slice(0, 300) ?? '';
  } catch {
    return '';
  }
}

export interface AiMapResult {
  root: string;
  item: CodeItem;
  links: Record<AiRelation, CodeLink[]>;
}

/** カーソル位置のシンボルを起点に、呼び出し元と呼び出し先をまとめて調べる */
export async function aiPrepare(opts: {
  agent: AiAgent;
  cwd: string;
  path: string;
  line: number;
  word: string;
  signal?: AbortSignal;
}): Promise<AiMapResult> {
  const rel = norm(path.relative(opts.cwd, opts.path));
  const prompt = `${preamble(opts.cwd)}
対象: ${rel} の ${opts.line + 1} 行目にあるシンボル${opts.word ? `「${opts.word}」` : ''}
その行の内容: ${await lineText(opts.path, opts.line)}

このシンボル (クラス・メソッド・関数など) の定義を特定し、次を調べてください。
${relationText(['callers', 'callees'])}

${FORMAT}`;
  const json = extractJson(await runOneShot(opts.agent, { cwd: opts.cwd, prompt, signal: opts.signal }));
  const item =
    toItem((json.symbol ?? {}) as AiEntry, opts.cwd) ??
    ({ name: opts.word || path.basename(opts.path), kind: 12, path: norm(opts.path), range: lineRange(opts.line), selectionRange: lineRange(opts.line) } as CodeItem);
  return {
    root: opts.cwd,
    item,
    links: {
      callers: toLinks(json.callers, opts.cwd, (it) => it.path),
      callees: toLinks(json.callees, opts.cwd, () => item.path),
    },
  };
}

/** ノードを 1 段展開する (呼び出し元 / 呼び出し先) */
export async function aiExpand(opts: {
  agent: AiAgent;
  cwd: string;
  item: CodeItem;
  relation: AiRelation;
  signal?: AbortSignal;
}): Promise<CodeLink[]> {
  const { item } = opts;
  const rel = norm(path.relative(opts.cwd, item.path));
  const prompt = `${preamble(opts.cwd)}
対象: ${rel} の ${item.selectionRange.start.line + 1} 行目で定義されている ${kindName(item.kind)}「${item.name}」
その行の内容: ${await lineText(item.path, item.selectionRange.start.line)}

このシンボルについて次を調べてください (${opts.relation === 'callers' ? 'callees' : 'callers'} は空の配列にしてください)。
${relationText([opts.relation])}

${FORMAT}`;
  const json = extractJson(await runOneShot(opts.agent, { cwd: opts.cwd, prompt, signal: opts.signal }));
  return opts.relation === 'callers'
    ? toLinks(json.callers, opts.cwd, (it) => it.path)
    : toLinks(json.callees, opts.cwd, () => item.path);
}
