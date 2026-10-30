import { execFile, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { broadcastEvent } from '../ws/watcher.js';
import { AI_CLAUDE_PERMISSIONS, AI_CODEX_SANDBOXES } from './appConfigStore.js';
import {
  recordSession,
  saveTurnProgress,
  type AiAgent,
  type AiItem,
  type AiTurn,
} from './aiStore.js';
import { errorDetail, logger } from './logger.js';

const execFileAsync = promisify(execFile);

/**
 * AI チャットの実行: codex / claude の CLI を非対話モードで起動し、JSONL の出力を表示用の項目 (AiItem) に変換する。
 * - codex: codex exec --json (続けるときは codex exec resume <thread_id>)
 * - claude: claude -p --output-format stream-json --verbose (続けるときは --resume <session_id>)
 * 依頼文は標準入力で渡す (引数にしない → 長文・改行・記号をそのまま渡せ、シェルの解釈も受けない)。
 * 途中経過は WS の ai:turn で全クライアントへ送り、DB にも保存する。
 */

export interface AiAgentInfo {
  available: boolean;
  /** 実行ファイルのフルパス (PATH から解決) */
  path: string | null;
  version: string | null;
}

/** effort の候補 (AI ごと)。空 = CLI の既定 */
export const AI_EFFORTS: Record<AiAgent, string[]> = {
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
};

/** 依頼ごとに選べる権限 (Codex はサンドボックス、Claude は権限モード) */
export const AI_PERMISSIONS: Record<AiAgent, readonly string[]> = {
  codex: AI_CODEX_SANDBOXES,
  claude: AI_CLAUDE_PERMISSIONS,
};

/** Windows で直接起動できる拡張子 (where は拡張子なしの sh スクリプトも返すので除く) */
const WIN_EXEC_EXT = ['.exe', '.cmd', '.bat', '.com'];

/** PATH からコマンドを探す。見つからなければ null */
async function which(cmd: string): Promise<string | null> {
  try {
    const finder = process.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await execFileAsync(finder, [cmd], { windowsHide: true, timeout: 10_000 });
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (process.platform !== 'win32') return lines[0] ?? null;
    return lines.find((l) => WIN_EXEC_EXT.includes(path.extname(l).toLowerCase())) ?? null;
  } catch {
    return null;
  }
}

/** .cmd / .bat は cmd.exe 経由でないと起動できない (Node は shell: true を要求する) */
function needsShell(file: string): boolean {
  return process.platform === 'win32' && ['.cmd', '.bat'].includes(path.extname(file).toLowerCase());
}

async function detect(cmd: AiAgent): Promise<AiAgentInfo> {
  const file = await which(cmd);
  if (!file) return { available: false, path: null, version: null };
  let version: string | null = null;
  try {
    const { stdout } = await execFileAsync(file, ['--version'], {
      windowsHide: true,
      timeout: 15_000,
      shell: needsShell(file),
    });
    version = stdout.trim().split(/\r?\n/)[0] || null;
  } catch {
    /* バージョンが取れなくても実行はできる */
  }
  return { available: true, path: file, version };
}

let detected: { at: number; agents: Record<AiAgent, AiAgentInfo> } | null = null;
const DETECT_TTL_MS = 30_000;

/** codex / claude の有無 (PATH が通っているか)。短時間はキャッシュする */
export async function detectAgents(force = false): Promise<Record<AiAgent, AiAgentInfo>> {
  if (!force && detected && Date.now() - detected.at < DETECT_TTL_MS) return detected.agents;
  const [codex, claude] = await Promise.all([detect('codex'), detect('claude')]);
  detected = { at: Date.now(), agents: { codex, claude } };
  return detected.agents;
}

export interface CodexModelInfo {
  slug: string;
  displayName: string;
  /** visibility が list 以外 (CLI のモデル選択に出ないもの) */
  hidden: boolean;
  efforts: string[];
}

/** codex debug models のモデル一覧 (設定画面の入力サポート用) */
export async function listCodexModels(): Promise<CodexModelInfo[]> {
  const info = (await detectAgents()).codex;
  if (!info.path) {
    const err = new Error('codex が PATH に見つかりません') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  const { stdout } = await execFileAsync(info.path, ['debug', 'models'], {
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    shell: needsShell(info.path),
  });
  const json = JSON.parse(stdout) as { models?: Record<string, unknown>[] };
  return (json.models ?? [])
    .filter((m) => typeof m.slug === 'string')
    .map((m) => ({
      slug: m.slug as string,
      displayName: typeof m.display_name === 'string' ? m.display_name : (m.slug as string),
      hidden: m.visibility !== 'list',
      efforts: Array.isArray(m.supported_reasoning_levels)
        ? (m.supported_reasoning_levels as { effort?: unknown }[])
            .map((l) => l.effort)
            .filter((e): e is string => typeof e === 'string')
        : [],
    }));
}

/** ツール出力として保持する上限 (長いコマンド出力で DB と WS が膨らまないように) */
const MAX_OUTPUT = 12_000;

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (${s.length - MAX_OUTPUT} 文字省略)` : s;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v, null, 2);
}

/** 実行中のターン (ターン ID → 状態) */
interface Running {
  turn: AiTurn;
  child: ChildProcess;
  /** 項目のキー → items の位置 (同じ項目の更新を差し替えるため) */
  index: Map<string, number>;
  canceled: boolean;
  stderr: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const running = new Map<number, Running>();

export function isBoxRunning(boxId: number): boolean {
  for (const r of running.values()) if (r.turn.boxId === boxId) return true;
  return false;
}

/** 項目を追加、または同じキーの項目を差し替える */
function upsert(r: Running, item: AiItem): void {
  const i = r.index.get(item.key);
  if (i === undefined) {
    r.index.set(item.key, r.turn.items.length);
    r.turn.items.push(item);
  } else {
    r.turn.items[i] = item;
  }
  scheduleFlush(r);
}

function addError(r: Running, text: string): void {
  upsert(r, { kind: 'error', key: `error-${r.turn.items.length}`, text });
}

/** 途中経過を保存して送る (細かい出力が続いても 200ms に 1 回にまとめる) */
function scheduleFlush(r: Running): void {
  if (r.flushTimer) return;
  r.flushTimer = setTimeout(() => {
    r.flushTimer = null;
    flush(r.turn);
  }, 200);
}

function flush(turn: AiTurn): void {
  saveTurnProgress(turn);
  broadcastEvent('ai:turn', turn);
}

function setSession(r: Running, sessionId: unknown): void {
  if (typeof sessionId !== 'string' || !sessionId || r.turn.sessionId === sessionId) return;
  r.turn.sessionId = sessionId;
  recordSession(r.turn.boxId, r.turn.agent, r.turn.thread, sessionId);
  broadcastEvent('ai:boxes', { boxId: r.turn.boxId });
}

// --- codex exec --json ---

/** シェル経由の実行 (powershell.exe -Command '…') は中身のコマンドだけ見せる */
function codexCommand(cmd: unknown): string {
  const s = str(cmd);
  const m = /-Command '([\s\S]*)'$/.exec(s) ?? /^\S*(?:bash|sh|zsh)"? -l?c '([\s\S]*)'$/.exec(s);
  return m ? m[1].replace(/''/g, "'") : s;
}

function codexItem(r: Running, item: Record<string, unknown>, completed: boolean): void {
  const key = `codex-${str(item.id)}`;
  switch (item.type) {
    case 'agent_message':
      upsert(r, { kind: 'text', key, text: str(item.text) });
      return;
    case 'reasoning':
      if (str(item.text)) upsert(r, { kind: 'reasoning', key, text: str(item.text) });
      return;
    case 'command_execution': {
      const exit = item.exit_code;
      upsert(r, {
        kind: 'tool',
        key,
        title: `$ ${codexCommand(item.command)}`,
        output: clip(str(item.aggregated_output)) || undefined,
        status: !completed && exit === null ? 'running' : exit === 0 || exit === undefined ? 'done' : 'error',
      });
      return;
    }
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? (item.changes as { kind?: unknown; path?: unknown }[]) : [];
      upsert(r, {
        kind: 'tool',
        key,
        title: `ファイルの変更 (${changes.length} 件)`,
        detail: changes.map((c) => `${str(c.kind)}  ${str(c.path)}`).join('\n'),
        status: item.status === 'failed' ? 'error' : completed ? 'done' : 'running',
      });
      return;
    }
    case 'mcp_tool_call':
      upsert(r, {
        kind: 'tool',
        key,
        title: `MCP ${str(item.server)}.${str(item.tool)}`,
        detail: item.arguments === undefined ? undefined : clip(str(item.arguments)),
        output: item.result === undefined && item.error === undefined ? undefined : clip(str(item.error ?? item.result)),
        status: item.status === 'failed' ? 'error' : completed ? 'done' : 'running',
      });
      return;
    case 'web_search':
      upsert(r, { kind: 'tool', key, title: `Web 検索: ${str(item.query)}`, status: completed ? 'done' : 'running' });
      return;
    case 'todo_list': {
      const todos = Array.isArray(item.items) ? (item.items as { text?: unknown; completed?: unknown }[]) : [];
      upsert(r, {
        kind: 'tool',
        key,
        title: `TODO (${todos.filter((t) => t.completed).length}/${todos.length})`,
        detail: todos.map((t) => `${t.completed ? '☑' : '☐'} ${str(t.text)}`).join('\n'),
        status: 'done',
      });
      return;
    }
    case 'error':
      upsert(r, { kind: 'error', key, text: str(item.message) });
      return;
    default:
      upsert(r, {
        kind: 'tool',
        key,
        title: str(item.type) || '(不明な項目)',
        detail: clip(str(item)),
        status: completed ? 'done' : 'running',
      });
  }
}

function codexEvent(r: Running, ev: Record<string, unknown>): void {
  switch (ev.type) {
    case 'thread.started':
      setSession(r, ev.thread_id);
      return;
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      if (ev.item && typeof ev.item === 'object') {
        codexItem(r, ev.item as Record<string, unknown>, ev.type === 'item.completed');
      }
      return;
    case 'turn.completed': {
      const u = (ev.usage ?? {}) as Record<string, unknown>;
      r.turn.usage = `入力 ${u.input_tokens ?? '?'} (キャッシュ ${u.cached_input_tokens ?? 0}) / 出力 ${u.output_tokens ?? '?'} トークン`;
      return;
    }
    case 'turn.failed': {
      const e = (ev.error ?? {}) as Record<string, unknown>;
      addError(r, str(e.message) || 'ターンが失敗しました');
      return;
    }
    case 'error':
      addError(r, str(ev.message));
      return;
  }
}

// --- claude -p --output-format stream-json ---

/** ツール呼び出しの 1 行要約 */
function claudeToolTitle(name: string, input: Record<string, unknown>): string {
  if ((name === 'Bash' || name === 'PowerShell') && input.command) return `$ ${str(input.command)}`;
  if (input.file_path) return `${name} ${str(input.file_path)}`;
  if (input.notebook_path) return `${name} ${str(input.notebook_path)}`;
  if (input.pattern) return `${name} ${str(input.pattern)}${input.path ? ` (${str(input.path)})` : ''}`;
  if (input.url) return `${name} ${str(input.url)}`;
  if (input.query) return `${name} ${str(input.query)}`;
  if (input.description) return `${name}: ${str(input.description)}`;
  return name;
}

/** tool_result の content (文字列 or ブロック配列) を文字列にする */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return str(content);
  return content
    .map((b: { type?: unknown; text?: unknown }) => (b.type === 'text' ? str(b.text) : `[${str(b.type)}]`))
    .join('\n');
}

function claudeEvent(r: Running, ev: Record<string, unknown>): void {
  // サブエージェント内のやり取りは出さない (親のツール呼び出しとしてまとめて見える)
  if (ev.parent_tool_use_id) return;
  if (ev.session_id) setSession(r, ev.session_id);
  const message = (ev.message ?? {}) as { id?: unknown; content?: unknown };
  const blocks = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
  switch (ev.type) {
    case 'assistant':
      blocks.forEach((b, i) => {
        const key = `claude-${str(message.id)}-${i}`;
        if (b.type === 'text' && str(b.text)) upsert(r, { kind: 'text', key, text: str(b.text) });
        else if (b.type === 'thinking' && str(b.thinking)) upsert(r, { kind: 'reasoning', key, text: str(b.thinking) });
        else if (b.type === 'tool_use') {
          const input = (b.input ?? {}) as Record<string, unknown>;
          upsert(r, {
            kind: 'tool',
            key: `claude-tool-${str(b.id)}`,
            title: claudeToolTitle(str(b.name), input),
            detail: clip(JSON.stringify(input, null, 2)),
            status: 'running',
          });
        }
      });
      return;
    case 'user':
      for (const b of blocks) {
        if (b.type !== 'tool_result') continue;
        const key = `claude-tool-${str(b.tool_use_id)}`;
        const i = r.index.get(key);
        const prev = i === undefined ? undefined : r.turn.items[i];
        if (prev?.kind !== 'tool') continue;
        upsert(r, { ...prev, output: clip(toolResultText(b.content)), status: b.is_error ? 'error' : 'done' });
      }
      return;
    case 'result': {
      const cost = typeof ev.total_cost_usd === 'number' ? ` / $${ev.total_cost_usd.toFixed(4)}` : '';
      const u = (ev.usage ?? {}) as Record<string, unknown>;
      r.turn.usage = `入力 ${u.input_tokens ?? '?'} (キャッシュ ${u.cache_read_input_tokens ?? 0}) / 出力 ${u.output_tokens ?? '?'} トークン${cost}`;
      if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) {
        addError(r, str(ev.result) || `失敗しました (${str(ev.subtype)})`);
      }
      return;
    }
  }
}

// --- 起動 ---

/** 引数に渡す値は CLI の引数として安全な文字だけ (.cmd 経由でシェルを通す場合もあるため) */
const SAFE_ARG = /^[\w.\-:/@=\[\]]+$/;

function buildArgs(turn: AiTurn, resumeId: string | null): string[] {
  for (const v of [turn.model, turn.effort, turn.permission, resumeId ?? '']) {
    if (v && !SAFE_ARG.test(v)) throw Object.assign(new Error(`不正な値です: ${v}`), { status: 400 });
  }
  if (turn.agent === 'codex') {
    const args = ['exec', ...(resumeId ? ['resume'] : []), '--json', '--skip-git-repo-check'];
    // サンドボックスは resume にはオプションが無いので設定値 (-c) で渡す
    args.push('-c', `sandbox_mode=${turn.permission}`);
    if (turn.model) args.push('-m', turn.model);
    if (turn.effort) args.push('-c', `model_reasoning_effort=${turn.effort}`);
    if (resumeId) args.push(resumeId);
    args.push('-'); // 依頼文は標準入力から
    return args;
  }
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', turn.permission];
  if (turn.model) args.push('--model', turn.model);
  if (turn.effort) args.push('--effort', turn.effort);
  if (resumeId) args.push('--resume', resumeId);
  return args;
}

/** 子の環境変数。このサーバ自身が Claude Code から起動されていても、入れ子の判定を受けないようにする */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

/** ターンを実行する (完了を待たずに戻る。進捗・完了は WS の ai:turn で通知) */
export async function runTurn(turn: AiTurn, resumeId: string | null): Promise<void> {
  const info = (await detectAgents())[turn.agent];
  const r: Running = {
    turn,
    child: null as unknown as ChildProcess,
    index: new Map(),
    canceled: false,
    stderr: '',
    flushTimer: null,
  };
  const fail = (message: string) => {
    turn.status = 'error';
    turn.error = message;
    turn.finishedAt = new Date().toISOString();
    flush(turn);
  };
  if (!info.path) {
    fail(`${turn.agent} が PATH に見つかりません`);
    return;
  }
  let args: string[];
  try {
    args = buildArgs(turn, resumeId);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
    return;
  }
  logger.info(`AI チャット: ${turn.agent} を実行します (box ${turn.boxId}, turn ${turn.id})`, {
    event: 'ai',
    detail: { cwd: turn.cwd, args },
  });
  const child = spawn(info.path, args, {
    cwd: turn.cwd,
    env: childEnv(),
    windowsHide: true,
    shell: needsShell(info.path),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  r.child = child;
  running.set(turn.id, r);
  flush(turn);

  child.stdin.on('error', () => {});
  child.stdin.end(turn.prompt);

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line);
      } catch {
        // JSON 以外 (警告の表示等) はそのまま出しておく
        upsert(r, { kind: 'tool', key: `raw-${r.turn.items.length}`, title: line.slice(0, 200), status: 'done' });
        continue;
      }
      try {
        if (turn.agent === 'codex') codexEvent(r, ev);
        else claudeEvent(r, ev);
      } catch (e) {
        logger.warn(`AI チャット: 出力の解析に失敗しました: ${e instanceof Error ? e.message : String(e)}`, {
          event: 'ai',
          detail: { line: line.slice(0, 2000), ...errorDetail(e) },
        });
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    r.stderr = (r.stderr + chunk).slice(-8000);
  });

  let finished = false;
  const finish = (code: number | null, spawnError?: Error) => {
    if (finished) return;
    finished = true;
    running.delete(turn.id);
    if (r.flushTimer) clearTimeout(r.flushTimer);
    turn.finishedAt = new Date().toISOString();
    if (r.canceled) {
      turn.status = 'canceled';
    } else if (spawnError) {
      turn.status = 'error';
      turn.error = `起動に失敗しました: ${spawnError.message}`;
    } else if (code !== 0 || turn.items.some((i) => i.kind === 'error')) {
      turn.status = 'error';
      if (code !== 0) turn.error = r.stderr.trim() || `終了コード ${code}`;
    } else {
      turn.status = 'done';
    }
    // 停止・失敗で終わったときに実行中のまま残ったツール呼び出しは、完了しなかった扱いにする
    for (const item of turn.items) {
      if (item.kind === 'tool' && item.status === 'running') item.status = turn.status === 'done' ? 'done' : 'error';
    }
    logger.info(`AI チャット: ${turn.agent} が終了しました (turn ${turn.id}, ${turn.status}, code ${code})`, {
      event: 'ai',
      detail: r.stderr ? { stderr: r.stderr.slice(-2000) } : undefined,
    });
    flush(turn);
  };
  child.on('error', (e) => finish(null, e));
  child.on('close', (code) => finish(code));
}

/** 実行中のターンを止める (子プロセスごと終了させる) */
export function cancelTurn(turnId: number): boolean {
  const r = running.get(turnId);
  if (!r) return false;
  r.canceled = true;
  const pid = r.child.pid;
  if (process.platform === 'win32' && pid) {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
  } else {
    r.child.kill();
  }
  return true;
}
