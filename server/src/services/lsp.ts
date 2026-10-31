import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dataDir } from '../config.js';
import { getAppConfig } from './appConfigStore.js';
import { needsShell, which } from './commandPath.js';
import { decodeBuffer } from './encoding.js';
import { norm } from './fsService.js';
import { errorDetail, logger } from './logger.js';
import { LSP_CONTENT_MODIFIED, LSP_REQUEST_CANCELLED, LspConnection, LspError } from './lspConnection.js';
import { LSP_PRESETS, type LspServerDef } from './lspPresets.js';

/**
 * コードマップ (参照元 / 参照先のマップ) のための言語サーバ (LSP) の管理と問い合わせ。
 * - 言語サーバは「定義 × プロジェクトのフォルダ」ごとに 1 つ起動し、使われないまま 30 分たったら止める
 * - 呼び出し階層 (callHierarchy)・参照 (references)・型階層 (typeHierarchy) を CodeItem / CodeLink に変換して返す
 * - 問い合わせるファイルは都度ディスクから読み (エディタで編集中の起点のファイルは受け取った内容で) didOpen / didChange する
 * 位置 (line / character) は LSP と同じく 0 始まり・UTF-16 単位 (Monaco・JS の文字列と同じ)。
 */

export interface Pos {
  line: number;
  character: number;
}

export interface Rng {
  start: Pos;
  end: Pos;
}

/** マップの 1 つのノード (クラス・メソッド・関数など) */
export interface CodeItem {
  name: string;
  /** LSP の SymbolKind */
  kind: number;
  detail?: string;
  /** ファイルのパス ("/" 区切り)。file: 以外の URI (jdt:// 等) はそのまま */
  path: string;
  range: Rng;
  selectionRange: Rng;
  /** 言語サーバの CallHierarchyItem / TypeHierarchyItem (展開するときにそのまま返す) */
  call?: unknown;
  type?: unknown;
  /** プロジェクトの外 (ライブラリ・標準ライブラリ等) */
  external?: boolean;
}

/** 展開の結果: 相手のノードと、呼び出し / 参照している箇所 (sitePath のファイル内の範囲) */
export interface CodeLink {
  item: CodeItem;
  sitePath: string;
  sites: Rng[];
}

export type Relation = 'callers' | 'callees' | 'references' | 'supertypes' | 'subtypes';
export const RELATIONS: readonly Relation[] = ['callers', 'callees', 'references', 'supertypes', 'subtypes'];

function httpError(status: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

// --- パスと URI ---

function toUri(p: string): string {
  return pathToFileURL(p).href;
}

/** URI → パス ("/" 区切り、Windows のドライブ文字は大文字)。file: 以外はそのまま */
function uriToPath(uri: string): string {
  if (!uri.startsWith('file:')) return uri;
  const p = norm(fileURLToPath(uri));
  return /^[a-z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p;
}

const fold = (p: string) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);

function isUnder(p: string, root: string): boolean {
  const r = fold(root.endsWith('/') ? root : `${root}/`);
  return fold(p).startsWith(r);
}

/** ライブラリの置き場所 (プロジェクトの中にあってもプロジェクトの外として扱う) */
const LIBRARY_DIR_RE = /\/(node_modules|site-packages|dist-packages|vendor|\.venv|venv|\.gradle|\.m2|\.cargo|pkg\/mod)\//i;

/** ファイルのパスか (jdt:// のような file: 以外の URI は除く) */
const isFilePath = (p: string) => p.startsWith('/') || /^[A-Za-z]:\//.test(p);

/** パス → URI (file: 以外の URI はそのまま) */
const uriOf = (p: string) => (isFilePath(p) ? toUri(p) : p);

function isExternal(p: string, root: string): boolean {
  return !isFilePath(p) || !isUnder(p, root) || LIBRARY_DIR_RE.test(p.slice(root.length));
}

/** 拡張子 → didOpen の languageId */
const LANGUAGE_IDS: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascriptreact',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  c: 'c',
  h: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  m: 'objective-c',
  mm: 'objective-cpp',
  cs: 'csharp',
  rb: 'ruby',
  kt: 'kotlin',
  kts: 'kotlin',
};

const extOf = (p: string) => path.extname(p).slice(1).toLowerCase();
const languageIdFor = (p: string) => LANGUAGE_IDS[extOf(p)] ?? extOf(p);

// --- 言語サーバの選択とプロジェクトのフォルダ ---

function enabledServers(): LspServerDef[] {
  return getAppConfig().lspServers.filter((s) => s.enabled);
}

/** ファイルを担当する言語サーバの定義 (拡張子で選ぶ。無ければ null) */
export function serverForPath(p: string): LspServerDef | null {
  const ext = extOf(p);
  return enabledServers().find((s) => s.extensions.includes(ext)) ?? null;
}

function hasMarker(dir: string, markers: string[]): boolean {
  let names: string[] | null = null;
  for (const m of markers) {
    if (m.startsWith('*.')) {
      try {
        names ??= readdirSync(dir);
      } catch {
        return false;
      }
      const ext = m.slice(1).toLowerCase();
      if (names.some((n) => n.toLowerCase().endsWith(ext))) return true;
    } else if (existsSync(path.join(dir, m))) {
      return true;
    }
  }
  return false;
}

/** 近い親から探す: 定義の rootMarkers → .git → ファイルのフォルダ */
export function findRoot(filePath: string, def: LspServerDef): string {
  const start = norm(path.dirname(filePath));
  for (const markers of [def.rootMarkers, ['.git']]) {
    if (!markers.length) continue;
    let dir = start;
    for (;;) {
      if (hasMarker(dir, markers)) return dir;
      const parent = norm(path.dirname(dir));
      if (parent === dir) break;
      dir = parent;
    }
  }
  return start;
}

/** AI での生成に使う作業フォルダ: Git のリポジトリ (無ければファイルのフォルダ) */
export function findRepoRoot(filePath: string): string {
  let dir = norm(path.dirname(filePath));
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = norm(path.dirname(dir));
    if (parent === dir) return norm(path.dirname(filePath));
    dir = parent;
  }
}

// --- コマンドの解決 ---

const WIN_EXTS = ['.cmd', '.exe', '.bat'];

function existingFile(p: string): string | null {
  if (process.platform === 'win32' && !path.extname(p)) {
    for (const ext of WIN_EXTS) if (existsSync(p + ext)) return p + ext;
  }
  return existsSync(p) ? p : null;
}

const whichCache = new Map<string, { at: number; path: string | null }>();
const WHICH_TTL_MS = 30_000;

async function cachedWhich(cmd: string): Promise<string | null> {
  const hit = whichCache.get(cmd);
  if (hit && Date.now() - hit.at < WHICH_TTL_MS) return hit.path;
  const resolved = await which(cmd);
  const found = resolved && norm(resolved);
  whichCache.set(cmd, { at: Date.now(), path: found });
  return found;
}

/** 絶対パス → そのまま / プロジェクトの node_modules/.bin (近い親から) / PATH の順に探す */
export async function resolveCommand(command: string, root: string | null): Promise<string | null> {
  if (path.isAbsolute(command)) {
    const found = existingFile(command);
    return found && norm(found);
  }
  if (root && !/[\\/]/.test(command)) {
    let dir = root;
    for (;;) {
      const found = existingFile(path.join(dir, 'node_modules', '.bin', command));
      if (found) return norm(found);
      const parent = norm(path.dirname(dir));
      if (parent === dir) break;
      dir = parent;
    }
  }
  return cachedWhich(command);
}

/** cmd.exe 経由で起動するときの引数 (空白等を含むものは "" で囲む。cmd が展開する文字は通さない) */
function shellArg(a: string): string {
  if (/^[\w.\-:/\\=@+,]+$/.test(a)) return a;
  if (/["%\r\n]/.test(a)) throw httpError(400, `言語サーバの引数に使えない文字が含まれています: ${a}`);
  return `"${a}"`;
}

/** 言語サーバに渡す環境変数 (npm run・Claude Code・node --watch から引き継いだ印は外す) */
function serverEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^npm_/i.test(k) || k === 'INIT_CWD') continue;
    if (k === 'CLAUDECODE' || k === 'CLAUDE_CODE_ENTRYPOINT' || k === 'WATCH_REPORT_DEPENDENCIES') continue;
    env[k] = v;
  }
  return env;
}

// --- 起動中の言語サーバ ---

interface OpenDoc {
  version: number;
  text: string;
}

interface Instance {
  key: string;
  def: LspServerDef;
  root: string;
  command: string;
  child: ChildProcess;
  conn: LspConnection;
  ready: Promise<void>;
  state: 'starting' | 'ready' | 'exited';
  caps: Record<string, unknown>;
  /** client/registerCapability で後から登録された機能 (メソッド名) */
  registered: Set<string>;
  /** didOpen 済みの文書 (URI → 版と内容)。Map の順序を LRU に使う */
  docs: Map<string, OpenDoc>;
  /** 進行中の作業 ($/progress。インデックス作成など) */
  progress: Map<string, string>;
  startedAt: number;
  lastUsed: number;
}

const instances = new Map<string, Instance>();
/** 同時に開いておく文書の上限 (超えたら古いものから didClose) */
const MAX_OPEN_DOCS = 200;
const IDLE_STOP_MS = 30 * 60_000;
const INIT_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 120_000;

export interface LspInstanceInfo {
  serverId: string;
  label: string;
  root: string;
  command: string;
  state: Instance['state'];
  progress: string[];
  startedAt: number;
  lastUsed: number;
}

function instanceInfo(inst: Instance): LspInstanceInfo {
  return {
    serverId: inst.def.id,
    label: inst.def.label,
    root: inst.root,
    command: inst.command,
    state: inst.state,
    progress: [...inst.progress.values()],
    startedAt: inst.startedAt,
    lastUsed: inst.lastUsed,
  };
}

export function listInstances(): LspInstanceInfo[] {
  return [...instances.values()].map(instanceInfo);
}

/** 言語サーバ用の作業フォルダ (${dataDir})。jdtls のように作業領域を求めるものに渡す */
function workDirFor(def: LspServerDef, root: string): string {
  const hash = createHash('sha1').update(fold(root)).digest('hex').slice(0, 12);
  const dir = path.join(dataDir, 'lsp', `${def.id}-${hash}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function onServerRequest(inst: Instance, method: string, params: unknown): unknown {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'workspace/configuration':
      return Array.isArray(p.items) ? p.items.map(() => null) : [];
    case 'workspace/workspaceFolders':
      return [{ uri: toUri(inst.root), name: path.basename(inst.root) || inst.root }];
    case 'client/registerCapability':
      for (const r of (p.registrations as { method?: unknown }[] | undefined) ?? []) {
        if (typeof r.method === 'string') inst.registered.add(r.method);
      }
      return null;
    case 'client/unregisterCapability':
    case 'window/workDoneProgress/create':
    case 'window/showMessageRequest':
      return null;
    case 'window/showDocument':
      return { success: false };
    case 'workspace/applyEdit':
      return { applied: false };
  }
  // 表示の更新の依頼 (semanticTokens / codeLens / inlayHint 等の refresh) は表示しないので応じるだけ
  if (method.endsWith('/refresh')) return null;
  throw new LspError(-32601, `未対応のメソッドです: ${method}`);
}

function onServerNotification(inst: Instance, method: string, params: unknown): void {
  const p = (params ?? {}) as Record<string, unknown>;
  if (method === '$/progress') {
    const token = String(p.token);
    const v = (p.value ?? {}) as { kind?: string; title?: string; message?: string; percentage?: number };
    if (v.kind === 'end') {
      inst.progress.delete(token);
    } else {
      const prev = inst.progress.get(token) ?? '';
      const title = v.title ?? prev.split(' — ')[0];
      const detail = [v.message, typeof v.percentage === 'number' ? `${v.percentage}%` : ''].filter(Boolean).join(' ');
      inst.progress.set(token, detail ? `${title} — ${detail}` : title || '処理中');
    }
  } else if (method === 'window/showMessage' && p.type === 1) {
    logger.warn(`言語サーバ (${inst.def.label}): ${String(p.message)}`, { event: 'lsp' });
  }
}

async function startInstance(def: LspServerDef, root: string): Promise<Instance> {
  const command = await resolveCommand(def.command, root);
  if (!command) {
    const preset = LSP_PRESETS.find((p) => p.id === def.id);
    throw httpError(
      422,
      `言語サーバ ${def.command} が見つかりません (${def.label})。${preset ? `インストール: ${preset.install}` : ''}`,
      'lsp_not_found',
    );
  }
  const vars: Record<string, string> = { root, dataDir: '' };
  const args = def.args.map((a) =>
    a.replace(/\$\{(root|dataDir)\}/g, (_, k: string) => {
      if (k === 'dataDir' && !vars.dataDir) vars.dataDir = workDirFor(def, root);
      return vars[k];
    }),
  );
  const shell = needsShell(command);
  const child = spawn(shell ? shellArg(command) : command, shell ? args.map(shellArg) : args, {
    cwd: root,
    env: serverEnv(),
    windowsHide: true,
    shell,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const key = instanceKey(def, root);
  const inst = {
    key,
    def,
    root,
    command,
    child,
    state: 'starting',
    caps: {},
    registered: new Set(),
    docs: new Map(),
    progress: new Map(),
    startedAt: Date.now(),
    lastUsed: Date.now(),
  } as Omit<Instance, 'conn' | 'ready'> as Instance;
  inst.conn = new LspConnection(child, {
    onRequest: (m, p) => onServerRequest(inst, m, p),
    onNotification: (m, p) => onServerNotification(inst, m, p),
    onClose: (code) => {
      inst.state = 'exited';
      if (instances.get(key) === inst) instances.delete(key);
      logger.info(`言語サーバが終了しました: ${def.label} (${root}, code ${code})`, {
        event: 'lsp',
        detail: inst.conn.stderr ? { stderr: inst.conn.stderr.slice(-2000) } : undefined,
      });
    },
  });
  logger.info(`言語サーバを起動します: ${def.label} (${root})`, { event: 'lsp', detail: { command, args } });

  inst.ready = (async () => {
    const rootUri = toUri(root);
    const result = await inst.conn.request<{ capabilities?: Record<string, unknown> }>(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'explorer-browser' },
        locale: 'ja',
        rootPath: root,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(root) || root }],
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          window: { workDoneProgress: true },
          workspace: { workspaceFolders: true, configuration: true },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            callHierarchy: { dynamicRegistration: false },
            typeHierarchy: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
            definition: { dynamicRegistration: false, linkSupport: true },
            documentSymbol: {
              dynamicRegistration: false,
              hierarchicalDocumentSymbolSupport: true,
              symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
            },
          },
        },
      },
      INIT_TIMEOUT_MS,
    );
    inst.caps = result?.capabilities ?? {};
    inst.conn.notify('initialized', {});
    inst.state = 'ready';
  })();
  instances.set(key, inst);
  try {
    await inst.ready;
  } catch (e) {
    stopInstance(inst);
    const stderr = inst.conn.stderr.trim().split(/\r?\n/).slice(-5).join('\n');
    logger.warn(`言語サーバを初期化できません: ${def.label} (${root})`, { event: 'lsp', detail: { ...errorDetail(e), stderr } });
    throw httpError(502, `${def.label} を初期化できません: ${e instanceof Error ? e.message : String(e)}${stderr ? `\n${stderr}` : ''}`);
  }
  return inst;
}

const instanceKey = (def: LspServerDef, root: string) => `${def.id}\0${fold(root)}`;
const starting = new Map<string, Promise<Instance>>();

async function getInstance(def: LspServerDef, root: string): Promise<Instance> {
  const key = instanceKey(def, root);
  const running = instances.get(key);
  if (running && running.state !== 'exited') {
    await running.ready;
    running.lastUsed = Date.now();
    return running;
  }
  let p = starting.get(key);
  if (!p) {
    p = startInstance(def, root).finally(() => starting.delete(key));
    starting.set(key, p);
  }
  return p;
}

function killChild(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
  } else {
    child.kill();
  }
}

/** shutdown → exit の順に終了を依頼し、応じなければ子プロセスごと終了させる */
function stopInstance(inst: Instance): void {
  if (instances.get(inst.key) === inst) instances.delete(inst.key);
  if (inst.conn.isClosed) return;
  const force = setTimeout(() => killChild(inst.child), 3000);
  force.unref();
  inst.conn
    .request('shutdown', null, 2000)
    .catch(() => {})
    .finally(() => inst.conn.notify('exit', null));
}

/** 起動中の言語サーバを止める (serverId / root を省くとすべて) */
export function stopInstances(filter: { serverId?: string; root?: string } = {}): number {
  let n = 0;
  for (const inst of [...instances.values()]) {
    if (filter.serverId && inst.def.id !== filter.serverId) continue;
    if (filter.root && fold(inst.root) !== fold(filter.root)) continue;
    stopInstance(inst);
    n++;
  }
  return n;
}

setInterval(() => {
  for (const inst of [...instances.values()]) {
    if (Date.now() - inst.lastUsed > IDLE_STOP_MS) {
      logger.info(`使われていない言語サーバを止めます: ${inst.def.label} (${inst.root})`, { event: 'lsp' });
      stopInstance(inst);
    }
  }
}, 60_000).unref();

// サーバの終了時に言語サーバを残さない (exit では非同期の処理ができないので同期で終了させる)
process.on('exit', () => {
  for (const inst of instances.values()) {
    if (inst.child.exitCode !== null) continue;
    try {
      if (process.platform === 'win32' && inst.child.pid) {
        spawnSync('taskkill', ['/pid', String(inst.child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        inst.child.kill();
      }
    } catch {
      /* 終了処理中なので無視 */
    }
  }
});

// --- 文書の同期と問い合わせ ---

async function readText(p: string): Promise<string> {
  return decodeBuffer(await fs.readFile(p)).content;
}

/** 文書を didOpen (内容が変わっていれば didChange) する。text を省くとディスクから読む */
async function ensureOpen(inst: Instance, p: string, text?: string): Promise<string> {
  const uri = toUri(p);
  const content = text ?? (await readText(p));
  const doc = inst.docs.get(uri);
  if (doc) {
    inst.docs.delete(uri);
    inst.docs.set(uri, doc);
    if (doc.text !== content) {
      doc.version++;
      doc.text = content;
      inst.conn.notify('textDocument/didChange', {
        textDocument: { uri, version: doc.version },
        contentChanges: [{ text: content }],
      });
    }
    return uri;
  }
  inst.conn.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: languageIdFor(p), version: 1, text: content },
  });
  inst.docs.set(uri, { version: 1, text: content });
  while (inst.docs.size > MAX_OPEN_DOCS) {
    const oldest = inst.docs.keys().next().value as string;
    inst.docs.delete(oldest);
    inst.conn.notify('textDocument/didClose', { textDocument: { uri: oldest } });
  }
  return uri;
}

/** 解析中で取り消された応答 (ContentModified 等) は少し待ってやり直す */
async function request<T>(inst: Instance, method: string, params: unknown): Promise<T> {
  inst.lastUsed = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await inst.conn.request<T>(method, params, REQUEST_TIMEOUT_MS);
    } catch (e) {
      const retry = e instanceof LspError && (e.code === LSP_CONTENT_MODIFIED || e.code === LSP_REQUEST_CANCELLED);
      if (!retry || attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

function supports(inst: Instance, provider: string, method: string): boolean {
  const v = inst.caps[provider];
  return (v !== undefined && v !== null && v !== false) || inst.registered.has(method);
}

interface LspHierarchyItem {
  name: string;
  kind: number;
  detail?: string;
  uri: string;
  range: Rng;
  selectionRange: Rng;
}

function fromHierarchyItem(raw: LspHierarchyItem, kind: 'call' | 'type', root: string): CodeItem {
  const p = uriToPath(raw.uri);
  return {
    name: raw.name,
    kind: raw.kind,
    ...(raw.detail ? { detail: raw.detail } : {}),
    path: p,
    range: raw.range,
    selectionRange: raw.selectionRange,
    [kind]: raw,
    ...(isExternal(p, root) ? { external: true } : {}),
  };
}

interface FlatSymbol {
  name: string;
  kind: number;
  detail?: string;
  range: Rng;
  selectionRange: Rng;
}

const contains = (r: Rng, p: Pos) =>
  (p.line > r.start.line || (p.line === r.start.line && p.character >= r.start.character)) &&
  (p.line < r.end.line || (p.line === r.end.line && p.character <= r.end.character));
const rangeSize = (r: Rng) => (r.end.line - r.start.line) * 100_000 + (r.end.character - r.start.character);

/** 文書のシンボル (DocumentSymbol の木 / SymbolInformation の平たい一覧) を平たくする */
async function documentSymbols(inst: Instance, p: string): Promise<FlatSymbol[]> {
  if (!supports(inst, 'documentSymbolProvider', 'textDocument/documentSymbol')) return [];
  const uri = await ensureOpen(inst, p);
  const res = await request<unknown[] | null>(inst, 'textDocument/documentSymbol', { textDocument: { uri } });
  const out: FlatSymbol[] = [];
  const walk = (list: unknown[]) => {
    for (const raw of list) {
      const s = raw as Record<string, unknown>;
      if (s.location) {
        const range = (s.location as { range: Rng }).range;
        out.push({ name: String(s.name), kind: Number(s.kind), range, selectionRange: range });
      } else {
        out.push({
          name: String(s.name),
          kind: Number(s.kind),
          ...(typeof s.detail === 'string' && s.detail ? { detail: s.detail } : {}),
          range: s.range as Rng,
          selectionRange: (s.selectionRange ?? s.range) as Rng,
        });
        if (Array.isArray(s.children)) walk(s.children);
      }
    }
  };
  walk(res ?? []);
  return out;
}

/** SymbolKind: Method / Constructor / Function */
const FUNCTION_KINDS = new Set([6, 9, 12]);

/** 無名の関数 (TS の "create() callback" や "<function>" 等) */
const ANONYMOUS_RE = /(^<.*>$)|( callback$)|(^anonymous)|(^\(anonymous)/i;

/**
 * 参照箇所を含むシンボル。名前のある最も内側の関数・メソッド (呼び出し階層の呼び出し元と同じ単位)。
 * 関数の中でなければ最も内側のシンボル (ローカル変数より外の、ファイル直下の定数・クラス等)
 */
function enclosingSymbol(symbols: FlatSymbol[], pos: Pos): FlatSymbol | null {
  const chain = symbols.filter((s) => contains(s.range, pos)).sort((a, b) => rangeSize(b.range) - rangeSize(a.range));
  const fn = chain.filter((s) => FUNCTION_KINDS.has(s.kind) && !ANONYMOUS_RE.test(s.name)).pop();
  return fn ?? chain.filter((s) => !ANONYMOUS_RE.test(s.name)).pop() ?? null;
}

/** import / using / #include 等の行の始まり */
const IMPORT_LINE_RE = /^\s*(import\b|export\s*(\{|\*)|from\s+\S+\s+import\b|use\s|using\s|#\s*include\b|require(_once)?\b|package\s)/;

/**
 * 参照箇所が import 文の中か (複数行の import { … } も上にたどって判定する)。
 * 参照元として意味が無い上に、ファイル直下のノードとして並んで邪魔になるので除く
 */
function inImport(lines: string[], line: number): boolean {
  for (let i = line; i >= 0 && i > line - 30; i--) {
    const text = lines[i] ?? '';
    if (IMPORT_LINE_RE.test(text)) return true;
    if (i !== line && (!text.trim() || /[;)}]\s*$/.test(text))) return false;
  }
  return false;
}

function symbolItem(s: FlatSymbol, p: string, root: string): CodeItem {
  return {
    name: s.name,
    kind: s.kind,
    ...(s.detail ? { detail: s.detail } : {}),
    path: p,
    range: s.range,
    selectionRange: s.selectionRange,
    ...(isExternal(p, root) ? { external: true } : {}),
  };
}

const position = (item: CodeItem) => ({
  textDocument: { uri: uriOf(item.path) },
  position: item.selectionRange.start,
});

async function prepareCall(inst: Instance, item: CodeItem): Promise<CodeItem | null> {
  if (!supports(inst, 'callHierarchyProvider', 'textDocument/prepareCallHierarchy')) return null;
  if (item.call) return item;
  if (isFilePath(item.path)) await ensureOpen(inst, item.path);
  const res = await request<LspHierarchyItem[] | null>(inst, 'textDocument/prepareCallHierarchy', position(item));
  return res?.[0] ? fromHierarchyItem(res[0], 'call', inst.root) : null;
}

async function prepareType(inst: Instance, item: CodeItem): Promise<CodeItem | null> {
  if (!supports(inst, 'typeHierarchyProvider', 'textDocument/prepareTypeHierarchy')) return null;
  if (item.type) return item;
  if (isFilePath(item.path)) await ensureOpen(inst, item.path);
  const res = await request<LspHierarchyItem[] | null>(inst, 'textDocument/prepareTypeHierarchy', position(item));
  return res?.[0] ? fromHierarchyItem(res[0], 'type', inst.root) : null;
}

// --- API から使う操作 ---

export interface LspSession {
  serverId: string;
  serverLabel: string;
  root: string;
}

export interface PrepareResult extends LspSession {
  items: CodeItem[];
  /** 結果が不完全かもしれない理由 (インデックス作成中など) */
  notices: string[];
}

function sessionFor(filePath: string, serverId?: string, root?: string): { def: LspServerDef; root: string } {
  const servers = getAppConfig().lspServers;
  const def = serverId ? servers.find((s) => s.id === serverId) : serverForPath(filePath);
  if (!def) {
    throw httpError(
      422,
      `${path.extname(filePath) || 'この種類'} のファイルを解析する言語サーバが設定されていません (設定 > コード解析)`,
      'lsp_not_configured',
    );
  }
  return { def, root: root ? norm(root) : findRoot(filePath, def) };
}

function progressNotices(inst: Instance): string[] {
  return [...inst.progress.values()].map((p) => `言語サーバが処理中のため、結果が足りない場合があります: ${p}`);
}

/** カーソル位置のシンボルをマップの起点にする */
export async function prepare(opts: { path: string; position: Pos; content?: string }): Promise<PrepareResult> {
  const filePath = norm(opts.path);
  const { def, root } = sessionFor(filePath);
  const inst = await getInstance(def, root);
  const uri = await ensureOpen(inst, filePath, opts.content);
  const at = { textDocument: { uri }, position: opts.position };
  const base = { serverId: def.id, serverLabel: def.label, root };

  if (supports(inst, 'callHierarchyProvider', 'textDocument/prepareCallHierarchy')) {
    const res = await request<LspHierarchyItem[] | null>(inst, 'textDocument/prepareCallHierarchy', at);
    if (res?.length) {
      return { ...base, items: res.map((r) => fromHierarchyItem(r, 'call', root)), notices: progressNotices(inst) };
    }
  }
  if (supports(inst, 'typeHierarchyProvider', 'textDocument/prepareTypeHierarchy')) {
    const res = await request<LspHierarchyItem[] | null>(inst, 'textDocument/prepareTypeHierarchy', at);
    if (res?.length) {
      return { ...base, items: res.map((r) => fromHierarchyItem(r, 'type', root)), notices: progressNotices(inst) };
    }
  }
  // 階層に対応していない (変数・フィールド等): 定義へ飛んだ先のシンボルを起点にする
  let target = { path: filePath, pos: opts.position };
  if (supports(inst, 'definitionProvider', 'textDocument/definition')) {
    const res = await request<unknown>(inst, 'textDocument/definition', at).catch(() => null);
    const first = (Array.isArray(res) ? res[0] : res) as Record<string, unknown> | null | undefined;
    const uri2 = (first?.targetUri ?? first?.uri) as string | undefined;
    const range = (first?.targetSelectionRange ?? first?.range) as Rng | undefined;
    if (uri2?.startsWith('file:') && range) target = { path: uriToPath(uri2), pos: range.start };
  }
  const symbols = await documentSymbols(inst, target.path);
  const exact = symbols
    .filter((s) => contains(s.selectionRange, target.pos))
    .sort((a, b) => rangeSize(a.range) - rangeSize(b.range))[0];
  const sym =
    exact ??
    symbols.filter((s) => contains(s.range, target.pos)).sort((a, b) => rangeSize(a.range) - rangeSize(b.range))[0];
  if (!sym) {
    throw httpError(
      404,
      inst.progress.size
        ? `カーソル位置のシンボルが見つかりません (言語サーバが処理中です: ${[...inst.progress.values()].join(', ')})`
        : 'カーソル位置のシンボルが見つかりません。クラス・メソッド・関数の名前の上にカーソルを置いて開いてください',
      'symbol_not_found',
    );
  }
  return { ...base, items: [symbolItem(sym, target.path, root)], notices: progressNotices(inst) };
}

export interface ExpandResult {
  links: CodeLink[];
  notices: string[];
}

/** 1 回の展開で返す相手の上限 */
const MAX_LINKS = 200;
/** 参照の展開で調べる参照箇所・ファイルの上限 */
const MAX_REFERENCES = 1000;
const MAX_REFERENCE_FILES = 150;

async function expandReferences(inst: Instance, item: CodeItem, notices: string[]): Promise<CodeLink[]> {
  if (!supports(inst, 'referencesProvider', 'textDocument/references')) {
    throw httpError(400, `${inst.def.label} は参照の検索に対応していません`);
  }
  if (isFilePath(item.path)) await ensureOpen(inst, item.path);
  const refs =
    (await request<{ uri: string; range: Rng }[] | null>(inst, 'textDocument/references', {
      ...position(item),
      context: { includeDeclaration: false },
    })) ?? [];
  if (refs.length > MAX_REFERENCES) notices.push(`参照が多いため、先頭の ${MAX_REFERENCES} 件だけを調べました (全 ${refs.length} 件)`);
  const byFile = new Map<string, Rng[]>();
  for (const r of refs.slice(0, MAX_REFERENCES)) {
    const p = uriToPath(r.uri);
    // 定義そのもの (宣言の名前の位置) は参照元にしない
    if (p === item.path && contains(item.selectionRange, r.range.start)) continue;
    byFile.set(p, [...(byFile.get(p) ?? []), r.range]);
  }
  if (byFile.size > MAX_REFERENCE_FILES) {
    notices.push(`参照しているファイルが多いため、${MAX_REFERENCE_FILES} 件だけを調べました (全 ${byFile.size} 件)`);
  }
  const links = new Map<string, CodeLink>();
  for (const [p, ranges] of [...byFile].slice(0, MAX_REFERENCE_FILES)) {
    const symbols = isFilePath(p) ? await documentSymbols(inst, p).catch(() => []) : [];
    const lines = inst.docs.get(uriOf(p))?.text.split(/\r?\n/) ?? [];
    for (const range of ranges) {
      if (inImport(lines, range.start.line)) continue;
      const sym = enclosingSymbol(symbols, range.start);
      const it: CodeItem = sym
        ? symbolItem(sym, p, inst.root)
        : {
            // シンボルの外 (ファイル直下の処理など) はファイルそのものをノードにする
            name: path.basename(p),
            kind: 1,
            path: p,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            ...(isExternal(p, inst.root) ? { external: true } : {}),
          };
      const key = `${p}#${it.selectionRange.start.line}:${it.selectionRange.start.character}`;
      const link = links.get(key);
      if (link) link.sites.push(range);
      else links.set(key, { item: it, sitePath: p, sites: [range] });
    }
  }
  return [...links.values()];
}

/** ノードを 1 段展開する (呼び出し元 / 呼び出し先 / 参照元 / 親の型 / 子の型) */
export async function expand(opts: {
  item: CodeItem;
  relation: Relation;
  serverId?: string;
  root?: string;
}): Promise<ExpandResult> {
  const { def, root } = sessionFor(opts.item.path, opts.serverId, opts.root);
  const inst = await getInstance(def, root);
  const notices: string[] = [];
  let links: CodeLink[];
  switch (opts.relation) {
    case 'callers': {
      const call = await prepareCall(inst, opts.item);
      if (!call) {
        notices.push(
          supports(inst, 'callHierarchyProvider', 'textDocument/prepareCallHierarchy')
            ? '呼び出し階層の対象ではないため、参照元を表示しています'
            : `${def.label} は呼び出し階層に対応していないため、参照元を表示しています`,
        );
        links = await expandReferences(inst, opts.item, notices);
        break;
      }
      const res =
        (await request<{ from: LspHierarchyItem; fromRanges: Rng[] }[] | null>(inst, 'callHierarchy/incomingCalls', {
          item: call.call,
        })) ?? [];
      links = res.map((r) => {
        const item = fromHierarchyItem(r.from, 'call', root);
        return { item, sitePath: item.path, sites: r.fromRanges };
      });
      break;
    }
    case 'callees': {
      const call = await prepareCall(inst, opts.item);
      if (!call) {
        throw httpError(
          400,
          supports(inst, 'callHierarchyProvider', 'textDocument/prepareCallHierarchy')
            ? `${opts.item.name} は呼び出し階層の対象ではありません`
            : `${def.label} は呼び出し階層に対応していません`,
        );
      }
      const res =
        (await request<{ to: LspHierarchyItem; fromRanges: Rng[] }[] | null>(inst, 'callHierarchy/outgoingCalls', {
          item: call.call,
        })) ?? [];
      links = res.map((r) => ({ item: fromHierarchyItem(r.to, 'call', root), sitePath: call.path, sites: r.fromRanges }));
      break;
    }
    case 'references':
      links = await expandReferences(inst, opts.item, notices);
      break;
    case 'supertypes':
    case 'subtypes': {
      const type = await prepareType(inst, opts.item);
      if (!type) {
        throw httpError(
          400,
          supports(inst, 'typeHierarchyProvider', 'textDocument/prepareTypeHierarchy')
            ? `${opts.item.name} は型階層の対象ではありません`
            : `${def.label} は型階層に対応していません`,
        );
      }
      const res =
        (await request<LspHierarchyItem[] | null>(inst, `typeHierarchy/${opts.relation}`, { item: type.type })) ?? [];
      links = res.map((r) => ({ item: fromHierarchyItem(r, 'type', root), sitePath: '', sites: [] }));
      break;
    }
  }
  if (links.length > MAX_LINKS) {
    notices.push(`件数が多いため、先頭の ${MAX_LINKS} 件だけを表示しています (全 ${links.length} 件)`);
    links = links.slice(0, MAX_LINKS);
  }
  if (!links.length) notices.push(...progressNotices(inst));
  return { links, notices };
}

export interface LspServerStatus extends LspServerDef {
  /** 見つかったコマンドのパス (見つからなければ null) */
  resolved: string | null;
  install: string | null;
}

/** 設定画面用: 定義ごとにコマンドが見つかるか (プロジェクトの node_modules/.bin は root を渡したときだけ探す) */
export async function serverStatuses(root: string | null): Promise<LspServerStatus[]> {
  return Promise.all(
    getAppConfig().lspServers.map(async (def) => ({
      ...def,
      resolved: await resolveCommand(def.command, root),
      install: LSP_PRESETS.find((p) => p.id === def.id)?.install ?? null,
    })),
  );
}
