import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { IPty } from 'node-pty';
import { norm } from './fsService.js';
import { errorDetail, logger } from './logger.js';

/**
 * アプリ内のターミナル。node-pty で疑似端末を作り、シェル (cmd / PowerShell / zsh 等) を起動する。
 * 入出力は WS (/ws/terminal) で中継する (ws/terminal.ts)。
 * セッションはサーバのメモリにだけ持ち、全タブで共有する (閉じるかシェルが終了するまで残る)。
 * 画面を開き直したときのために直近の出力を控えておき、接続時にまとめて送る。
 */

const require = createRequire(import.meta.url);

export interface TerminalShell {
  id: string;
  label: string;
  file: string;
  args: string[];
}

export interface TerminalInfo {
  id: number;
  /** 表示名 (空 = 作業フォルダ名) */
  name: string;
  shellId: string;
  shellLabel: string;
  cwd: string;
  createdAt: number;
}

/** 接続中のクライアントへの送信先 */
export interface TerminalClient {
  output: (data: string) => void;
  exit: (code: number) => void;
}

interface Session {
  info: TerminalInfo;
  pty: IPty;
  /** 直近の出力 (接続時に送り直す)。古いものから捨てる */
  scrollback: string;
  /** まとめて送る前の出力 */
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  clients: Set<TerminalClient>;
}

/** 控えておく出力の上限 (文字数) */
const SCROLLBACK_MAX = 512 * 1024;
/** 出力は細切れに届くので、少し溜めてから送る (ms) */
const FLUSH_DELAY = 8;

const sessions = new Map<number, Session>();
let nextId = 1;

/** 一覧 (作成・終了・名前の変更) が変わったときの通知先 (routes から WS へ流す) */
let onListChanged: (() => void) | null = null;

export function setTerminalListListener(fn: () => void): void {
  onListChanged = fn;
}

/** node-pty は起動時ではなく初めて使うときに読み込む (読み込めなくてもサーバ全体は動かす) */
let ptyModule: typeof import('node-pty') | null = null;

function loadPty(): typeof import('node-pty') {
  if (ptyModule) return ptyModule;
  if (process.platform !== 'win32') ensureSpawnHelper();
  try {
    ptyModule = require('node-pty') as typeof import('node-pty');
  } catch (e) {
    logger.error(`node-pty を読み込めません: ${e instanceof Error ? e.message : String(e)}`, {
      event: 'terminal',
      detail: errorDetail(e),
    });
    const err = new Error(
      'ターミナルの部品 (node-pty) を読み込めません。npm install をやり直してください',
    ) as Error & { status?: number };
    err.status = 500;
    throw err;
  }
  return ptyModule;
}

/**
 * Mac / Linux では node-pty がシェルの起動に spawn-helper を使う。
 * npm の tarball では実行権限が落ちていることがあり (node-pty 1.1.0)、
 * そのままだと posix_spawnp failed で起動できないので、権限を付け直す。
 */
function ensureSpawnHelper(): void {
  let root: string;
  try {
    root = path.dirname(require.resolve('node-pty/package.json'));
  } catch {
    return;
  }
  const candidates = [
    path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    path.join(root, 'build', 'Release', 'spawn-helper'),
  ];
  for (const p of candidates) {
    try {
      if ((fs.statSync(p).mode & 0o111) === 0) fs.chmodSync(p, 0o755);
    } catch {
      /* 無いものは飛ばす */
    }
  }
}

// --- シェルの検出 ---

function exists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** PATH から実行ファイルを探す */
function findInPath(name: string): string | null {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, name);
    if (exists(p)) return p;
  }
  return null;
}

function detectWindowsShells(): TerminalShell[] {
  const sys = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const shells: TerminalShell[] = [
    { id: 'cmd', label: 'コマンドプロンプト', file: process.env.ComSpec || path.join(sys, 'cmd.exe'), args: [] },
  ];
  const powershell = path.join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (exists(powershell)) shells.push({ id: 'powershell', label: 'PowerShell', file: powershell, args: ['-NoLogo'] });
  const pwsh = findInPath('pwsh.exe') ?? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')].find(exists);
  if (pwsh) shells.push({ id: 'pwsh', label: 'PowerShell 7', file: pwsh, args: ['-NoLogo'] });
  // Git Bash: git.exe (…\Git\cmd\git.exe) の 2 つ上に bin\bash.exe がある
  const git = findInPath('git.exe');
  const bash = [
    ...(git ? [path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe')] : []),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
  ].find(exists);
  if (bash) shells.push({ id: 'gitbash', label: 'Git Bash', file: bash, args: ['--login', '-i'] });
  const wsl = path.join(sys, 'wsl.exe');
  if (exists(wsl)) shells.push({ id: 'wsl', label: 'WSL', file: wsl, args: [] });
  return shells;
}

function detectUnixShells(): TerminalShell[] {
  const login = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  const shells: TerminalShell[] = [
    { id: 'login', label: `ログインシェル (${path.basename(login)})`, file: login, args: ['-l'] },
  ];
  // /etc/shells に載っているシェル (名前ごとに最初の 1 つ)
  let listed: string[] = [];
  try {
    listed = fs
      .readFileSync('/etc/shells', 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('/'));
  } catch {
    listed = ['/bin/zsh', '/bin/bash', '/bin/sh'];
  }
  const seen = new Set<string>();
  for (const file of listed) {
    const name = path.basename(file);
    if (seen.has(name) || !/^[\w.-]+$/.test(name) || !exists(file)) continue;
    seen.add(name);
    shells.push({ id: name, label: name, file, args: ['-l'] });
  }
  return shells;
}

let shellCache: TerminalShell[] | null = null;

export function listShells(): TerminalShell[] {
  shellCache ??= process.platform === 'win32' ? detectWindowsShells() : detectUnixShells();
  return shellCache;
}

/** 設定で既定のシェルを決めていないときのシェル (Windows はコマンドプロンプト、それ以外はログインシェル) */
export const DEFAULT_SHELL_ID = process.platform === 'win32' ? 'cmd' : 'login';

function findShell(id: string | undefined, fallbackId: string): TerminalShell {
  const shells = listShells();
  return shells.find((s) => s.id === id) ?? shells.find((s) => s.id === fallbackId) ?? shells[0];
}

/**
 * シェルに渡す環境変数。npm run 経由で起動したときの npm_* (npm の設定として読まれる)、
 * Claude Code から起動したときの印 (中で claude を動かすと入れ子と判定される)、
 * 開発時の node --watch の印は外す
 */
function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^npm_/i.test(k) || k === 'INIT_CWD') continue;
    if (k === 'CLAUDECODE' || k === 'CLAUDE_CODE_ENTRYPOINT' || k === 'WATCH_REPORT_DEPENDENCIES') continue;
    env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  // Mac のブラウザ / launchd から起動すると LANG が無く、日本語が化けるので補う
  if (process.platform !== 'win32' && !env.LANG && !env.LC_ALL) env.LANG = 'en_US.UTF-8';
  return env;
}

// --- セッション ---

export function listTerminals(): TerminalInfo[] {
  return [...sessions.values()].map((s) => s.info).sort((a, b) => a.id - b.id);
}

export function getTerminal(id: number): TerminalInfo | null {
  return sessions.get(id)?.info ?? null;
}

function clampSize(n: unknown, fallback: number): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 2 && v <= 1000 ? v : fallback;
}

/** 作業フォルダ: ファイルならその親のフォルダ。存在しなければホームフォルダ */
function resolveCwd(v: unknown): string {
  if (typeof v === 'string' && v.trim()) {
    const p = path.resolve(v.trim());
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) return p;
      if (st.isFile()) return path.dirname(p);
    } catch {
      /* 無ければホームへ */
    }
  }
  return os.homedir();
}

export function createTerminal(opts: {
  cwd?: unknown;
  shellId?: unknown;
  defaultShellId: string;
  cols?: unknown;
  rows?: unknown;
}): TerminalInfo {
  const pty = loadPty();
  const shell = findShell(typeof opts.shellId === 'string' ? opts.shellId : undefined, opts.defaultShellId);
  const cwd = resolveCwd(opts.cwd);
  const proc = withoutWatchMode(() =>
    pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: clampSize(opts.cols, 80),
      rows: clampSize(opts.rows, 24),
      cwd,
      env: shellEnv(),
    }),
  );
  const info: TerminalInfo = {
    id: nextId++,
    name: '',
    shellId: shell.id,
    shellLabel: shell.label,
    cwd: norm(cwd),
    createdAt: Date.now(),
  };
  const session: Session = { info, pty: proc, scrollback: '', pending: '', flushTimer: null, clients: new Set() };
  sessions.set(info.id, session);

  proc.onData((data) => {
    session.pending += data;
    session.flushTimer ??= setTimeout(() => flush(session), FLUSH_DELAY);
  });
  proc.onExit(({ exitCode }) => {
    flush(session);
    sessions.delete(info.id);
    for (const c of session.clients) c.exit(exitCode);
    session.clients.clear();
    logger.info(`ターミナルが終了しました (#${info.id} ${shell.label}, code ${exitCode})`, { event: 'terminal' });
    onListChanged?.();
  });

  logger.info(`ターミナルを起動しました (#${info.id} ${shell.label}: ${info.cwd})`, {
    event: 'terminal',
    detail: { id: info.id, shell: shell.file, cwd: info.cwd, pid: proc.pid },
  });
  onListChanged?.();
  return info;
}

function flush(s: Session): void {
  if (s.flushTimer) clearTimeout(s.flushTimer);
  s.flushTimer = null;
  if (!s.pending) return;
  const data = s.pending;
  s.pending = '';
  s.scrollback += data;
  if (s.scrollback.length > SCROLLBACK_MAX) {
    // 行の途中 (エスケープシーケンスの途中) から始まらないよう、次の改行の後から残す
    const cut = s.scrollback.length - SCROLLBACK_MAX;
    const nl = s.scrollback.indexOf('\n', cut);
    s.scrollback = s.scrollback.slice(nl >= 0 ? nl + 1 : cut);
  }
  for (const c of s.clients) c.output(data);
}

/** 接続する。直近の出力を返す (null = セッションが無い)。戻り値の detach で切り離す */
export function attachTerminal(id: number, client: TerminalClient): { scrollback: string; detach: () => void } | null {
  const s = sessions.get(id);
  if (!s) return null;
  flush(s); // 控えの出力と、この後に届く出力が前後しないよう、溜めていた分を先に流す
  s.clients.add(client);
  return { scrollback: s.scrollback, detach: () => s.clients.delete(client) };
}

export function writeTerminal(id: number, data: string): void {
  sessions.get(id)?.pty.write(data);
}

/** 画面の大きさを変える (複数のタブで開いているときは、最後に送ってきたタブの大きさになる) */
export function resizeTerminal(id: number, cols: unknown, rows: unknown): void {
  const s = sessions.get(id);
  const c = clampSize(cols, 0);
  const r = clampSize(rows, 0);
  if (!s || !c || !r || (s.pty.cols === c && s.pty.rows === r)) return;
  try {
    s.pty.resize(c, r);
  } catch {
    /* 終了直後などは無視 */
  }
}

export function renameTerminal(id: number, name: string): TerminalInfo | null {
  const s = sessions.get(id);
  if (!s) return null;
  s.info = { ...s.info, name: name.trim().slice(0, 100) };
  onListChanged?.();
  return s.info;
}

/**
 * Windows の node-pty は、出力の読み取りにワーカースレッドを使い (起動時)、シェルを終了するときは
 * シェルから起動したプロセスもまとめて終了させるため子プロセスを fork して一覧を受け取る (終了時)。
 * どちらもこのプロセスの execArgv と環境変数を引き継ぐので、開発時 (node --watch --import tsx) は
 * --watch 向けの依存ファイルの通知が先に届き、警告がコンソールにあふれたり、一覧を受け取れずに
 * 子プロセスが残ったりする。ワーカーも fork も呼び出しの中で同期的に作られるので、
 * その間だけ tsx の読み込みと --watch の印を外す
 */
function withoutWatchMode<T>(fn: () => T): T {
  if (process.platform !== 'win32') return fn();
  const execArgv = process.execArgv;
  const watch = process.env.WATCH_REPORT_DEPENDENCIES;
  process.execArgv = [];
  delete process.env.WATCH_REPORT_DEPENDENCIES;
  try {
    return fn();
  } finally {
    process.execArgv = execArgv;
    if (watch !== undefined) process.env.WATCH_REPORT_DEPENDENCIES = watch;
  }
}

/** シェルを終了させる (終了の通知は onExit から流れる) */
export function killTerminal(id: number): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  try {
    withoutWatchMode(() => s.pty.kill());
  } catch (e) {
    logger.warn(`ターミナルを終了できません (#${id}): ${e instanceof Error ? e.message : String(e)}`, {
      event: 'terminal',
      detail: errorDetail(e),
    });
    return false;
  }
  return true;
}

// サーバの終了時にシェルを残さない
process.on('exit', () => {
  for (const s of sessions.values()) {
    try {
      withoutWatchMode(() => s.pty.kill());
    } catch {
      /* 終了処理中なので無視 */
    }
  }
});
