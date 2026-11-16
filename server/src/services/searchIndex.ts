import Database from 'better-sqlite3';
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from '../config.js';
import { db as appDb } from './stateStore.js';
import { decodeBuffer, isProbablyBinary } from './encoding.js';
import { compileGlobs, compileGlobsSelf, splitGlobList } from './searchGlob.js';
import { fuzzyMatchPath } from './fuzzyPath.js';
import { errorDetail, logger } from './logger.js';
import { broadcastEvent } from '../ws/watcher.js';

/**
 * Git リポジトリのファイル (パス + 内容) のインデックス。
 *
 * - 利用者が有効にしたリポジトリ (ルート) だけを対象にする。登録は app.db の search_index_repos、
 *   インデックス本体はリポジトリごとの SQLite (data/search-index/<hash>.db)。
 * - 内容は FTS5 (trigram) に入れ、3 文字以上の文字列検索は候補のファイルを索引で絞ってから行ごとに照合する。
 *   正規表現・2 文字以下はインデックスに入れた内容を順に照合する (ファイルは読み直さない)。
 * - パスはメモリにも持ち、クイックオープン (Ctrl+P) のあいまい一致に使う。
 * - 有効にしたとき・サーバの起動時に全体を照合 (サイズ・更新日時が変わったファイルだけ読み直す) し、
 *   その後は fs.watch (recursive) の通知で差分を反映する。
 * - 除外: 設定の除外パターン (フォルダ名・パス・glob) と .git (常に除外)。
 *   useGitignore なら .gitignore 等で無視されるファイルも除く (git ls-files / git check-ignore)。
 * - サイズが上限 (maxFileKB) を超えるファイル・バイナリはパスだけを入れる (内容検索の対象外)。
 */

export interface IndexSettings {
  /** 除外するフォルダ / ファイル (glob。/ を含まなければどの階層の名前にも一致) */
  excludes: string[];
  /** .gitignore 等で無視されるファイルを除く */
  useGitignore: boolean;
  /** 内容を入れるファイルサイズの上限 (KB)。超えるものはパスのみ */
  maxFileKB: number;
}

export const DEFAULT_INDEX_SETTINGS: IndexSettings = {
  excludes: ['.git', 'node_modules'],
  useGitignore: true,
  maxFileKB: 1024,
};

export type IndexState = 'off' | 'building' | 'ready' | 'error';

export interface IndexStatus {
  repo: string;
  enabled: boolean;
  state: IndexState;
  /** インデックスにあるファイル数 (パス) */
  files: number;
  /** 内容も入れたファイル数 */
  contentFiles: number;
  /** 全体の照合中の進み具合 */
  progress: { done: number; total: number } | null;
  /** 最後に全体の照合を終えた日時 (ms) */
  updatedAt: number | null;
  error: string | null;
  settings: IndexSettings;
  /** インデックスのファイルサイズ (byte) */
  dbBytes: number;
}

export interface ContentSearchOptions {
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** 含めるファイル (カンマ区切りの glob) */
  include: string;
  /** 除外するファイル (カンマ区切りの glob) */
  exclude: string;
  maxResults: number;
}

export interface ContentMatchLine {
  /** 1 始まりの行番号 */
  line: number;
  /** 最初の一致の桁 (1 始まり) と終わり (エディタで選択する範囲) */
  column: number;
  endColumn: number;
  /** 表示用の行 (先頭の空白を除き、長い行は一致の周りだけに切り詰める) */
  text: string;
  /** text の中の一致の範囲 [start, end) */
  ranges: [number, number][];
}

export interface ContentFileResult {
  /** リポジトリルートからの相対パス */
  path: string;
  matches: ContentMatchLine[];
}

export interface ContentSearchResult {
  files: ContentFileResult[];
  matchCount: number;
  /** 上限 (maxResults) で打ち切ったか */
  truncated: boolean;
  /** 内容を照合したファイル数 */
  searchedFiles: number;
  elapsedMs: number;
  /** インデックスの作成中 (結果が揃っていない可能性がある) */
  building: boolean;
}

export interface FileSearchItem {
  path: string;
  score: number;
  indices: number[];
}

export class SearchIndexError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

appDb.exec(`
CREATE TABLE IF NOT EXISTS search_index_repos (
  repo TEXT PRIMARY KEY,
  settings TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

const INDEX_DIR = path.join(dataDir, 'search-index');
const SCHEMA_VERSION = '1';
/** 照合中に一度にまとめて書き込む件数 */
const BATCH_FILES = 200;
/** ファイルの stat / 読み込みの並列数 */
const IO_CONCURRENCY = 16;
/** 通知をまとめてから反映するまでの待ち時間 */
const WATCH_DEBOUNCE_MS = 400;
/** 一度に届いた変更がこれより多ければ、個別に見ずに全体を照合し直す */
const WATCH_FULL_RESCAN = 3000;
/** 表示用の行の最大長 */
const PREVIEW_MAX = 240;

const isWin = process.platform === 'win32';

function repoKey(repo: string): string {
  return isWin ? repo.toLowerCase() : repo;
}

function normalizeSettings(raw: unknown): IndexSettings {
  const s = (raw ?? {}) as Partial<IndexSettings>;
  const excludes = Array.isArray(s.excludes)
    ? [...new Set(s.excludes.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))]
    : DEFAULT_INDEX_SETTINGS.excludes;
  const kb = Number(s.maxFileKB);
  return {
    excludes,
    useGitignore: typeof s.useGitignore === 'boolean' ? s.useGitignore : DEFAULT_INDEX_SETTINGS.useGitignore,
    maxFileKB: Number.isFinite(kb) && kb >= 1 ? Math.min(Math.round(kb), 100 * 1024) : DEFAULT_INDEX_SETTINGS.maxFileKB,
  };
}

/** パスの途中に .git があるか (.git は設定に関係なく常に除外する) */
function hasGitSegment(rel: string): boolean {
  return rel === '.git' || rel.startsWith('.git/') || rel.includes('/.git/') || rel.endsWith('/.git');
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** 内容を文字列にする。UTF-8 として読めなければ文字コードを推定する (Shift_JIS 等) */
function decodeText(buf: Buffer): string {
  const utf16 = buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
  if (!utf16) {
    try {
      const s = utf8.decode(buf);
      return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
    } catch {
      /* UTF-8 ではない */
    }
  }
  return decodeBuffer(buf).content;
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      { cwd, maxBuffer: 1024 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/** paths のうち .gitignore 等で無視されるものを返す (追跡中のファイルは無視扱いにならない) */
function gitCheckIgnore(cwd: string, paths: string[]): Promise<Set<string>> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'core.quotepath=off', 'check-ignore', '-z', '--stdin'], {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.on('error', () => resolve(new Set()));
    // 終了コード 1 は「無視されるものが無い」、128 はエラー (どちらも空として扱う)
    child.on('close', () => resolve(new Set(out.split('\0').filter(Boolean))));
    child.stdin.on('error', () => {});
    child.stdin.end(paths.map((p) => `${p}\0`).join(''));
  });
}

/** 正規表現の特殊文字をエスケープ */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 検索語から照合用の正規表現を作る。正規表現が不正なら 400 */
function buildMatcher(opts: ContentSearchOptions): RegExp {
  let src = opts.regex ? opts.query : escapeRegExp(opts.query);
  const flags = `gm${opts.matchCase ? '' : 'i'}`;
  if (opts.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(src, `${flags}u`);
  } catch (e) {
    // u フラグで書けない書き方 (\- 等) の正規表現も受け付ける
    if (!opts.wholeWord) {
      try {
        return new RegExp(src, flags);
      } catch {
        /* 下で報告 */
      }
    }
    throw new SearchIndexError(400, `正規表現が正しくありません: ${e instanceof Error ? e.message : String(e)}`);
  }
}

interface RawLine {
  line: number;
  start: number;
  end: number;
  ranges: [number, number][];
}

/** body (改行は \n に統一済み) の中の一致を行ごとに集める。limit 件で打ち切る */
function scanBody(body: string, re: RegExp, limit: number): { lines: RawLine[]; count: number } {
  const lines: RawLine[] = [];
  let count = 0;
  let lineNo = 1;
  let lineStart = 0;
  let cur: RawLine | null = null;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (count < limit && (m = re.exec(body)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const idx = m.index;
    // 一致の位置までの改行を数える
    for (;;) {
      const nl = body.indexOf('\n', lineStart);
      if (nl < 0 || nl >= idx) break;
      lineNo++;
      lineStart = nl + 1;
    }
    let lineEnd = body.indexOf('\n', idx);
    if (lineEnd < 0) lineEnd = body.length;
    const s = idx - lineStart;
    const e = Math.min(idx + m[0].length, lineEnd) - lineStart;
    if (cur && cur.line === lineNo) {
      cur.ranges.push([s, e]);
    } else {
      cur = { line: lineNo, start: lineStart, end: lineEnd, ranges: [[s, e]] };
      lines.push(cur);
    }
    count++;
  }
  return { lines, count };
}

/** 表示用の行にする: 先頭の空白を除き、長い行は最初の一致の周りに切り詰める */
function toPreview(body: string, raw: RawLine): ContentMatchLine {
  const full = body.slice(raw.start, raw.end);
  const first = raw.ranges[0];
  const indent = full.length - full.trimStart().length;
  let from = Math.min(indent, first[0]);
  let prefix = '';
  if (first[0] - from > 60) {
    from = first[0] - 40;
    prefix = '…';
  }
  let to = full.length;
  let suffix = '';
  if (to - from > PREVIEW_MAX) {
    to = Math.max(from + PREVIEW_MAX, Math.min(first[1], from + PREVIEW_MAX * 2));
    suffix = '…';
  }
  const text = prefix + full.slice(from, to).replace(/\s+$/, '') + suffix;
  const shift = prefix.length - from;
  const ranges: [number, number][] = [];
  for (const [s, e] of raw.ranges) {
    if (s >= to) break;
    ranges.push([Math.max(s, from) + shift, Math.min(e, to) + shift]);
  }
  return { line: raw.line, column: first[0] + 1, endColumn: first[1] + 1, text, ranges };
}

interface FileRow {
  id: number;
  size: number;
  mtime: number;
  hasContent: boolean;
  lower: string;
}

interface Loaded {
  rel: string;
  size: number;
  mtime: number;
  body: string | null;
}

type Task = () => Promise<void>;

/** 全体の照合は同時に 1 リポジトリずつにする (起動直後に全部が一斉に読み込まないよう) */
let buildSlot: Promise<void> = Promise.resolve();
function withBuildSlot(fn: () => Promise<void>): Promise<void> {
  const run = buildSlot.then(fn, fn);
  buildSlot = run.catch(() => {});
  return run;
}

class RepoIndex {
  readonly repo: string;
  settings: IndexSettings;
  state: IndexState = 'building';
  progress: { done: number; total: number } | null = null;
  updatedAt: number | null = null;
  error: string | null = null;
  private readonly dbPath: string;
  private db: Database.Database;
  private rows = new Map<string, FileRow>();
  private contentCount = 0;
  private chain: Promise<void> = Promise.resolve();
  /** 破棄・設定変更で増やす。古い世代の処理は途中でやめる */
  private gen = 0;
  private watcher: fs.FSWatcher | null = null;
  private pending = new Set<string>();
  private pendingFull = false;
  private watchTimer: NodeJS.Timeout | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  private lastEmit = 0;
  private excluded: (rel: string) => boolean = () => false;
  private excludedSelf: (rel: string) => boolean = () => false;
  private stmts!: ReturnType<RepoIndex['prepare']>;

  constructor(repo: string, settings: IndexSettings) {
    this.repo = repo;
    this.settings = settings;
    fs.mkdirSync(INDEX_DIR, { recursive: true });
    const hash = crypto.createHash('sha1').update(repoKey(repo)).digest('hex').slice(0, 16);
    this.dbPath = path.join(INDEX_DIR, `${hash}.db`);
    this.db = this.openDb();
    this.applySettings();
  }

  private openDb(): Database.Database {
    const db = new Database(this.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const ver = (db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() as { value: string } | undefined)?.value;
    if (ver !== SCHEMA_VERSION) {
      db.exec(`DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS content;`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        has_content INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS content USING fts5(body, tokenize = 'trigram');
    `);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
      SCHEMA_VERSION,
    );
    db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('repo', ?)`).run(this.repo);
    return db;
  }

  private prepare() {
    const db = this.db;
    return {
      insertFile: db.prepare('INSERT INTO files (path, size, mtime, has_content) VALUES (?, ?, ?, ?)'),
      updateFile: db.prepare('UPDATE files SET size = ?, mtime = ?, has_content = ? WHERE id = ?'),
      deleteFile: db.prepare('DELETE FROM files WHERE id = ?'),
      insertContent: db.prepare('INSERT INTO content (rowid, body) VALUES (?, ?)'),
      deleteContent: db.prepare('DELETE FROM content WHERE rowid = ?'),
      getBody: db.prepare('SELECT body FROM content WHERE rowid = ?').pluck(),
      allContentFiles: db.prepare('SELECT id, path FROM files WHERE has_content = 1 ORDER BY path COLLATE NOCASE'),
      matchFiles: db.prepare(
        'SELECT f.id AS id, f.path AS path FROM content JOIN files f ON f.id = content.rowid WHERE content MATCH ? ORDER BY f.path COLLATE NOCASE',
      ),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?').pluck(),
      setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    };
  }

  /** 設定を反映する。前回の設定と違えば中身を作り直す */
  private applySettings(): void {
    const ex = compileGlobs(this.settings.excludes);
    const exSelf = compileGlobsSelf(this.settings.excludes);
    this.excluded = (rel) => hasGitSegment(rel) || (ex ? ex(rel) : false);
    this.excludedSelf = (rel) => hasGitSegment(rel) || (exSelf ? exSelf(rel) : false);
    this.stmts = this.prepare();
    const json = JSON.stringify(this.settings);
    if (this.stmts.getMeta.get('settings') !== json) {
      this.db.exec('DELETE FROM files; DELETE FROM content;');
      this.stmts.setMeta.run('settings', json);
      this.stmts.setMeta.run('updatedAt', '');
    }
    this.rows.clear();
    this.contentCount = 0;
    for (const r of this.db.prepare('SELECT id, path, size, mtime, has_content FROM files').iterate() as Iterable<{
      id: number;
      path: string;
      size: number;
      mtime: number;
      has_content: number;
    }>) {
      this.rows.set(r.path, { id: r.id, size: r.size, mtime: r.mtime, hasContent: r.has_content === 1, lower: r.path.toLowerCase() });
      if (r.has_content === 1) this.contentCount++;
    }
    const updated = Number(this.stmts.getMeta.get('updatedAt'));
    this.updatedAt = Number.isFinite(updated) && updated > 0 ? updated : null;
  }

  // ---- 状態の通知 ----

  status(): IndexStatus {
    let dbBytes = 0;
    for (const suffix of ['', '-wal']) {
      try {
        dbBytes += fs.statSync(this.dbPath + suffix).size;
      } catch {
        /* 無い */
      }
    }
    return {
      repo: this.repo,
      enabled: true,
      state: this.state,
      files: this.rows.size,
      contentFiles: this.contentCount,
      progress: this.progress,
      updatedAt: this.updatedAt,
      error: this.error,
      settings: this.settings,
      dbBytes,
    };
  }

  /** 状態をクライアントへ通知する。immediate でなければ 300ms に 1 回までにまとめる */
  emit(immediate = false): void {
    const now = Date.now();
    if (immediate || now - this.lastEmit >= 300) {
      if (this.emitTimer) {
        clearTimeout(this.emitTimer);
        this.emitTimer = null;
      }
      this.lastEmit = now;
      broadcastEvent('search-index:status', this.status());
      return;
    }
    if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        this.emit(true);
      }, 300 - (now - this.lastEmit));
    }
  }

  // ---- 直列実行 ----

  private enqueue(task: Task): Promise<void> {
    const run = this.chain.then(task, task);
    this.chain = run.catch((err) => {
      logger.error(`検索インデックスの更新に失敗しました (${this.repo}): ${err instanceof Error ? err.message : String(err)}`, {
        event: 'search-index',
        detail: errorDetail(err),
      });
    });
    return this.chain;
  }

  // ---- 起動・停止 ----

  start(): void {
    this.scheduleReconcile(this.gen);
    this.startWatch();
  }

  /**
   * 全体の照合を予約する。他のリポジトリの照合が終わるのを待ってから、このリポジトリの直列の処理に積む
   * (待っている間も監視の変更の反映や無効化は先に進められる)
   */
  private scheduleReconcile(gen: number): void {
    void withBuildSlot(() => (gen === this.gen ? this.enqueue(() => this.reconcile(gen)) : Promise.resolve()));
  }

  /** 設定を変えて作り直す */
  async reconfigure(settings: IndexSettings): Promise<void> {
    this.gen++;
    this.settings = settings;
    await this.enqueue(async () => {
      this.applySettings();
      this.emit(true);
    });
    this.stopWatch();
    this.start();
  }

  /** 全体を照合し直す (rebuild=true は中身を捨てて作り直す) */
  rescan(rebuild: boolean): void {
    this.gen++;
    const gen = this.gen;
    void this.enqueue(async () => {
      if (rebuild) {
        this.db.exec('DELETE FROM files; DELETE FROM content;');
        this.rows.clear();
        this.contentCount = 0;
      }
    });
    this.scheduleReconcile(gen);
  }

  /** 監視を止めて DB を閉じる。removeFiles なら DB ファイルも消す */
  async dispose(removeFiles: boolean): Promise<void> {
    this.gen++;
    this.stopWatch();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    await this.chain;
    try {
      this.db.close();
    } catch {
      /* 閉じ済み */
    }
    if (removeFiles) {
      for (const suffix of ['', '-wal', '-shm']) await fsp.rm(this.dbPath + suffix, { force: true }).catch(() => {});
    }
  }

  // ---- 監視 ----

  private startWatch(): void {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.repo, { recursive: true }, (_ev, filename) => {
        if (filename === null) {
          this.pendingFull = true;
        } else {
          const rel = String(filename).replace(/\\/g, '/');
          if (hasGitSegment(rel)) return;
          // .gitignore が変われば対象のファイルが入れ替わるので全体を照合し直す
          if (this.settings.useGitignore && (rel === '.gitignore' || rel.endsWith('/.gitignore'))) this.pendingFull = true;
          this.pending.add(rel);
        }
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => this.flushWatch(), WATCH_DEBOUNCE_MS);
      });
      this.watcher.on('error', (err) => {
        logger.warn(`検索インデックスの監視でエラー (${this.repo}): ${err.message}`, { event: 'search-index', detail: errorDetail(err) });
        this.stopWatch();
        // リポジトリのフォルダが消えた等。少し待って張り直す
        setTimeout(() => {
          if (!this.watcher && fs.existsSync(this.repo)) {
            this.startWatch();
            this.rescan(false);
          }
        }, 5000).unref();
      });
    } catch (err) {
      this.error = `変更の監視を開始できませんでした: ${err instanceof Error ? err.message : String(err)}`;
      this.emit(true);
    }
  }

  private stopWatch(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    this.pending.clear();
    this.pendingFull = false;
    try {
      this.watcher?.close();
    } catch {
      /* ignore */
    }
    this.watcher = null;
  }

  private flushWatch(): void {
    this.watchTimer = null;
    const paths = [...this.pending];
    const full = this.pendingFull || paths.length > WATCH_FULL_RESCAN;
    this.pending.clear();
    this.pendingFull = false;
    const gen = this.gen;
    if (full) void this.enqueue(() => this.reconcile(gen));
    else if (paths.length > 0) void this.enqueue(() => this.applyChanges(paths, gen));
  }

  // ---- 対象ファイルの列挙 ----

  private abs(rel: string): string {
    return path.join(this.repo, rel);
  }

  /** フォルダ以下のファイルを辿る (除外に一致するフォルダには入らない。シンボリックリンクは辿らない) */
  private async walk(relDir: string, out: string[], gen: number): Promise<void> {
    let dirents: fs.Dirent[];
    try {
      dirents = await fsp.readdir(relDir ? this.abs(relDir) : this.repo, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs: string[] = [];
    for (const d of dirents) {
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      if (this.excludedSelf(rel)) continue;
      if (d.isDirectory()) subdirs.push(rel);
      else if (d.isFile()) out.push(rel);
    }
    for (const sub of subdirs) {
      if (gen !== this.gen) return;
      await this.walk(sub, out, gen);
    }
  }

  /** インデックスに入れるファイルの一覧 (相対パス) */
  private async listFiles(gen: number): Promise<string[]> {
    if (this.settings.useGitignore) {
      try {
        const out = await runGit(this.repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
        const set = new Set<string>();
        for (const p of out.split('\0')) if (p && !this.excluded(p)) set.add(p);
        return [...set];
      } catch (err) {
        logger.warn(`git ls-files に失敗したため、フォルダを辿って一覧にします (${this.repo})`, {
          event: 'search-index',
          detail: errorDetail(err),
        });
      }
    }
    const out: string[] = [];
    await this.walk('', out, gen);
    return out;
  }

  // ---- 読み込みと書き込み ----

  /** ファイルを読んでインデックスに入れる形にする。消えた・ファイルでなければ null */
  private async load(rel: string, st?: fs.Stats): Promise<Loaded | null> {
    try {
      const s = st ?? (await fsp.lstat(this.abs(rel)));
      if (!s.isFile()) return null;
      const size = s.size;
      const mtime = Math.floor(s.mtimeMs);
      if (size > this.settings.maxFileKB * 1024) return { rel, size, mtime, body: null };
      const buf = await fsp.readFile(this.abs(rel));
      const utf16 = buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
      if (!utf16 && isProbablyBinary(buf)) return { rel, size, mtime, body: null };
      const body = decodeText(buf).replace(/\r\n?/g, '\n');
      return { rel, size, mtime, body };
    } catch {
      return null;
    }
  }

  private writeBatch(items: Loaded[], removes: string[]): void {
    if (items.length === 0 && removes.length === 0) return;
    const s = this.stmts;
    const tx = this.db.transaction(() => {
      for (const rel of removes) {
        const row = this.rows.get(rel);
        if (!row) continue;
        s.deleteFile.run(row.id);
        if (row.hasContent) {
          s.deleteContent.run(row.id);
          this.contentCount--;
        }
        this.rows.delete(rel);
      }
      for (const it of items) {
        const row = this.rows.get(it.rel);
        const has = it.body !== null;
        if (row) {
          s.updateFile.run(it.size, it.mtime, has ? 1 : 0, row.id);
          if (row.hasContent) {
            s.deleteContent.run(row.id);
            this.contentCount--;
          }
          if (has) {
            s.insertContent.run(row.id, it.body);
            this.contentCount++;
          }
          row.size = it.size;
          row.mtime = it.mtime;
          row.hasContent = has;
        } else {
          const id = Number(s.insertFile.run(it.rel, it.size, it.mtime, has ? 1 : 0).lastInsertRowid);
          if (has) {
            s.insertContent.run(id, it.body);
            this.contentCount++;
          }
          this.rows.set(it.rel, { id, size: it.size, mtime: it.mtime, hasContent: has, lower: it.rel.toLowerCase() });
        }
      }
    });
    tx();
  }

  /** 変わっていれば読み込む (stat 済みの値と比べる) */
  private async loadIfChanged(rel: string): Promise<Loaded | 'missing' | null> {
    let st: fs.Stats;
    try {
      st = await fsp.lstat(this.abs(rel));
    } catch {
      return 'missing';
    }
    if (!st.isFile()) return 'missing';
    const row = this.rows.get(rel);
    if (row && row.size === st.size && row.mtime === Math.floor(st.mtimeMs)) return null;
    return (await this.load(rel, st)) ?? 'missing';
  }

  /** 全体の照合: 一覧に無くなったものを消し、新しい・変わったものを読み込む */
  private async reconcile(gen: number): Promise<void> {
    if (gen !== this.gen) return;
    if (!fs.existsSync(this.repo)) {
      this.state = 'error';
      this.error = 'リポジトリのフォルダが見つかりません';
      this.emit(true);
      return;
    }
    this.state = 'building';
    this.error = null;
    this.progress = { done: 0, total: 0 };
    this.emit(true);
    const started = Date.now();
    const list = await this.listFiles(gen);
    if (gen !== this.gen) return;
    this.progress = { done: 0, total: list.length };
    this.emit();

    const listed = new Set(list);
    const gone = [...this.rows.keys()].filter((p) => !listed.has(p));
    let batch: Loaded[] = [];
    let removes: string[] = gone;
    let loadedBytes = 0;
    for (let i = 0; i < list.length; i += IO_CONCURRENCY) {
      if (gen !== this.gen) return;
      const slice = list.slice(i, i + IO_CONCURRENCY);
      const results = await Promise.all(slice.map((rel) => this.loadIfChanged(rel)));
      if (gen !== this.gen) return;
      results.forEach((r, k) => {
        if (r === 'missing') {
          if (this.rows.has(slice[k])) removes.push(slice[k]);
        } else if (r) {
          batch.push(r);
          loadedBytes += r.body?.length ?? 0;
        }
      });
      if (batch.length >= BATCH_FILES || loadedBytes > 8 * 1024 * 1024 || removes.length >= BATCH_FILES) {
        this.writeBatch(batch, removes);
        batch = [];
        removes = [];
        loadedBytes = 0;
      }
      this.progress = { done: Math.min(i + IO_CONCURRENCY, list.length), total: list.length };
      this.emit();
    }
    this.writeBatch(batch, removes);
    this.updatedAt = Date.now();
    this.stmts.setMeta.run('updatedAt', String(this.updatedAt));
    this.state = 'ready';
    this.progress = null;
    this.emit(true);
    logger.info(
      `検索インデックスを更新しました (${this.repo}: ${this.rows.size} ファイル, ${((Date.now() - started) / 1000).toFixed(1)} 秒)`,
      { event: 'search-index' },
    );
  }

  /**
   * 変更の通知が来たフォルダの中で、確かめるファイル。
   * 新しいフォルダ (名前を変えた・移してきた) は中をすべて辿り、既知のフォルダは直下だけを見る
   * (中のファイルの変更は、そのファイル自身の通知で反映する)
   */
  private async changedDirFiles(rel: string, gen: number): Promise<string[]> {
    const prefix = `${rel}/`;
    let known = false;
    for (const p of this.rows.keys()) {
      if (p.startsWith(prefix)) {
        known = true;
        break;
      }
    }
    const found: string[] = [];
    if (!known) {
      await this.walk(rel, found, gen);
      return found;
    }
    let dirents: fs.Dirent[];
    try {
      dirents = await fsp.readdir(this.abs(rel), { withFileTypes: true });
    } catch {
      return found;
    }
    for (const d of dirents) {
      const child = `${rel}/${d.name}`;
      if (this.excludedSelf(child)) continue;
      if (d.isFile()) found.push(child);
      else if (d.isDirectory()) {
        const childPrefix = `${child}/`;
        let childKnown = false;
        for (const p of this.rows.keys()) {
          if (p.startsWith(childPrefix)) {
            childKnown = true;
            break;
          }
        }
        if (!childKnown) await this.walk(child, found, gen);
      }
    }
    return found;
  }

  /** 監視で届いた変更を反映する */
  private async applyChanges(paths: string[], gen: number): Promise<void> {
    if (gen !== this.gen) return;
    const removes = new Set<string>();
    const candidates: string[] = [];
    for (const rel of paths) {
      if (this.excluded(rel)) {
        if (this.rows.has(rel)) removes.add(rel);
        continue;
      }
      let st: fs.Stats;
      try {
        st = await fsp.lstat(this.abs(rel));
      } catch {
        // 消えた (フォルダなら中身も消す)
        if (this.rows.has(rel)) removes.add(rel);
        const prefix = `${rel}/`;
        for (const p of this.rows.keys()) if (p.startsWith(prefix)) removes.add(p);
        continue;
      }
      if (st.isDirectory()) {
        candidates.push(...(await this.changedDirFiles(rel, gen)));
      } else if (st.isFile()) {
        candidates.push(rel);
      }
    }
    if (gen !== this.gen) return;

    // 新しいファイルは .gitignore で無視されるものを除く (既に入っているファイルはそのまま更新する)
    let targets = [...new Set(candidates)];
    if (this.settings.useGitignore) {
      const fresh = targets.filter((p) => !this.rows.has(p));
      if (fresh.length > 0) {
        const ignored = await gitCheckIgnore(this.repo, fresh);
        if (ignored.size > 0) targets = targets.filter((p) => !ignored.has(p));
      }
    }
    let batch: Loaded[] = [];
    for (let i = 0; i < targets.length; i += IO_CONCURRENCY) {
      const slice = targets.slice(i, i + IO_CONCURRENCY);
      const results = await Promise.all(slice.map((rel) => this.loadIfChanged(rel)));
      if (gen !== this.gen) return;
      results.forEach((r, k) => {
        if (r === 'missing') {
          if (this.rows.has(slice[k])) removes.add(slice[k]);
        } else if (r) {
          batch.push(r);
        }
      });
      if (batch.length >= BATCH_FILES) {
        this.writeBatch(batch, []);
        batch = [];
      }
    }
    this.writeBatch(batch, [...removes]);
    this.emit();
  }

  // ---- 検索 ----

  searchFiles(query: string, limit: number): FileSearchItem[] {
    const q = query.toLowerCase().replace(/\s+/g, '').replace(/\\/g, '/');
    if (!q) return [];
    const out: FileSearchItem[] = [];
    for (const [p, row] of this.rows) {
      const m = fuzzyMatchPath(q, p, row.lower);
      if (m) out.push({ path: p, score: m.score, indices: m.indices });
    }
    out.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
    return out.slice(0, limit);
  }

  async searchContent(opts: ContentSearchOptions, aborted: () => boolean): Promise<ContentSearchResult> {
    const started = Date.now();
    const re = buildMatcher(opts);
    const include = compileGlobs(splitGlobList(opts.include));
    const exclude = compileGlobs(splitGlobList(opts.exclude));
    const gen = this.gen;
    // 3 文字以上の文字列は FTS (trigram) で候補を絞る。大文字小文字を区別しない索引なので、区別は照合で行う
    const literal = !opts.regex && [...opts.query].length >= 3;
    const candidates = (
      literal
        ? this.stmts.matchFiles.all(`"${opts.query.replace(/"/g, '""')}"`)
        : this.stmts.allContentFiles.all()
    ) as { id: number; path: string }[];

    const files: ContentFileResult[] = [];
    let matchCount = 0;
    let searched = 0;
    let truncated = false;
    let slice = Date.now();
    for (const c of candidates) {
      if (include && !include(c.path)) continue;
      if (exclude && exclude(c.path)) continue;
      // 長くかかる検索で他の要求を止めないよう、ときどき手放す (中断・作り直しも確かめる)
      if (Date.now() - slice > 15) {
        await new Promise((r) => setImmediate(r));
        if (aborted() || gen !== this.gen) break;
        slice = Date.now();
      }
      const body = this.stmts.getBody.get(c.id) as string | undefined;
      if (typeof body !== 'string') continue;
      searched++;
      const { lines, count } = scanBody(body, re, opts.maxResults - matchCount);
      if (count === 0) continue;
      files.push({ path: c.path, matches: lines.map((l) => toPreview(body, l)) });
      matchCount += count;
      if (matchCount >= opts.maxResults) {
        truncated = true;
        break;
      }
    }
    return {
      files,
      matchCount,
      truncated,
      searchedFiles: searched,
      elapsedMs: Date.now() - started,
      building: this.state === 'building',
    };
  }
}

// ---- リポジトリの登録 ----

const indexes = new Map<string, RepoIndex>();

function offStatus(repo: string): IndexStatus {
  return {
    repo,
    enabled: false,
    state: 'off',
    files: 0,
    contentFiles: 0,
    progress: null,
    updatedAt: null,
    error: null,
    settings: { ...DEFAULT_INDEX_SETTINGS },
    dbBytes: 0,
  };
}

function find(repo: string): RepoIndex | undefined {
  return indexes.get(repoKey(repo));
}

function requireIndex(repo: string): RepoIndex {
  const idx = find(repo);
  if (!idx) throw new SearchIndexError(409, 'このリポジトリはインデックスが有効になっていません');
  return idx;
}

/** サーバ起動時: 有効なリポジトリのインデックスを開き、照合と監視を始める */
export function initSearchIndexes(): void {
  const rows = appDb.prepare('SELECT repo, settings FROM search_index_repos').all() as { repo: string; settings: string }[];
  for (const r of rows) {
    let settings: IndexSettings;
    try {
      settings = normalizeSettings(JSON.parse(r.settings));
    } catch {
      settings = { ...DEFAULT_INDEX_SETTINGS };
    }
    try {
      const idx = new RepoIndex(r.repo, settings);
      indexes.set(repoKey(r.repo), idx);
      idx.start();
    } catch (err) {
      logger.error(`検索インデックスを開けませんでした (${r.repo}): ${err instanceof Error ? err.message : String(err)}`, {
        event: 'search-index',
        detail: errorDetail(err),
      });
    }
  }
}

export function getIndexStatus(repo: string): IndexStatus {
  return find(repo)?.status() ?? offStatus(repo);
}

export function listIndexStatuses(): IndexStatus[] {
  return [...indexes.values()].map((i) => i.status());
}

/** repo は Git リポジトリのルート (呼び出し側で確かめる) */
export function enableIndex(repo: string, rawSettings?: unknown): IndexStatus {
  const existing = find(repo);
  if (existing) return existing.status();
  const settings = normalizeSettings(rawSettings ?? DEFAULT_INDEX_SETTINGS);
  appDb
    .prepare(
      'INSERT INTO search_index_repos (repo, settings, created_at) VALUES (?, ?, ?) ON CONFLICT(repo) DO UPDATE SET settings = excluded.settings',
    )
    .run(repo, JSON.stringify(settings), new Date().toISOString());
  const idx = new RepoIndex(repo, settings);
  indexes.set(repoKey(repo), idx);
  idx.start();
  logger.info(`検索インデックスを有効にしました (${repo})`, { event: 'search-index' });
  return idx.status();
}

export async function disableIndex(repo: string): Promise<IndexStatus> {
  const idx = find(repo);
  if (idx) {
    indexes.delete(repoKey(repo));
    await idx.dispose(true);
    appDb.prepare('DELETE FROM search_index_repos WHERE repo = ?').run(idx.repo);
    logger.info(`検索インデックスを無効にしました (${idx.repo})`, { event: 'search-index' });
  }
  const st = offStatus(repo);
  broadcastEvent('search-index:status', st);
  return st;
}

export async function updateIndexSettings(repo: string, rawSettings: unknown): Promise<IndexStatus> {
  const idx = requireIndex(repo);
  const settings = normalizeSettings(rawSettings);
  appDb.prepare('UPDATE search_index_repos SET settings = ? WHERE repo = ?').run(JSON.stringify(settings), idx.repo);
  if (JSON.stringify(settings) !== JSON.stringify(idx.settings)) await idx.reconfigure(settings);
  return idx.status();
}

export function rescanIndex(repo: string, rebuild: boolean): IndexStatus {
  const idx = requireIndex(repo);
  idx.rescan(rebuild);
  return idx.status();
}

export function searchIndexedFiles(repo: string, query: string, limit: number): FileSearchItem[] {
  return requireIndex(repo).searchFiles(query, limit);
}

export function searchIndexedContent(
  repo: string,
  opts: ContentSearchOptions,
  aborted: () => boolean,
): Promise<ContentSearchResult> {
  return requireIndex(repo).searchContent(opts, aborted);
}

