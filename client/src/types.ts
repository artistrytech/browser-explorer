export interface FsEntry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'symlink';
  size: number;
  mtime: number;
  hidden: boolean;
  ext: string;
  linkTarget?: string;
}

export interface VolumeInfo {
  name: string;
  path: string;
}

export type Eol = 'CRLF' | 'LF' | 'CR';

export interface ReadResult {
  path: string;
  content: string;
  encoding: string;
  eol: Eol;
  bom: boolean;
  size: number;
  mtime: number;
}

export interface GitFileStatus {
  path: string;
  index: string;
  workingDir: string;
}

export interface GitStatus {
  branch: string | null;
  tracking: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  conflicted: string[];
}

export interface GitCommit {
  hash: string;
  parents: string;
  author: string;
  date: string;
  message: string;
  refs: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  commit: string;
  label: string;
  ahead?: number;
  behind?: number;
}

/** グラフ用ログの 1 コミット (002.md §5.2) */
export interface GitGraphCommit {
  hash: string;
  parents: string[];
  author: string;
  date: string;
  refs: string[];
  subject: string;
}

/** マージ/リベース/cherry-pick の進行状態 (002.md §2.2) */
export interface MergeState {
  inProgress: 'merge' | 'rebase' | 'cherry-pick' | null;
  conflicted: string[];
}

/** アプリ起点のリベースセッション (存在＝リベース中ロック) */
export interface RebaseSession {
  repo: string;
  onto: string;
  baseBranch: string;
  backupBranch: string;
  deleteBackupOnSuccess: boolean;
  createdAt: string;
}

/** リベース用バックアップブランチ 1 件 (ツールメニューでの削除対象) */
export interface RebaseBackup {
  name: string;
  hash: string;
  date: string;
  subject: string;
}

/** start/continue/abort の結果。phase で後続 UI を分岐する */
export interface RebaseActionResult {
  ok: boolean;
  /** backup=バックアップ失敗 / conflict=競合で停止 / done=成功完了 / failed=開始失敗 / desynced=git 実状態とズレ / aborted=中止完了 */
  phase: 'backup' | 'conflict' | 'done' | 'failed' | 'desynced' | 'aborted';
  output?: string;
  notes?: string[];
  warnings?: string[];
  wipBranch?: string | null;
  session?: RebaseSession | null;
  mergeState?: MergeState;
}

export interface ConflictFile {
  path: string;
  kind: string;
  binary: boolean;
}

export interface ConflictVersions {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  working: string | null;
  kind: string;
  binary: boolean;
}

/** コミットの差分ファイル 1 件 (行数はバイナリ時 null) */
export interface CommitFile {
  path: string;
  status: string; // A / M / D / T
  added: number | null;
  deleted: number | null;
  binary: boolean;
}

export interface CommitFilesResult {
  hash: string;
  author: string;
  date: string;
  message: string;
  files: CommitFile[];
  /** 表示上限 (config.json の commitFilesLimit) */
  limit: number;
}

export interface Favorite {
  path: string;
  label: string;
}

export interface RecentItem {
  path: string;
  kind: string;
  openedAt: string;
}

export interface AppState {
  settings: Record<string, unknown>;
  favorites: Favorite[];
  repositories: string[];
  recents: RecentItem[];
}

export type SortKey = 'name' | 'type' | 'size' | 'mtime';
export type ViewMode = 'details' | 'list' | 'icons';

// --- GUI で編集する設定 (サーバの appConfigStore と対応) ---

/** 外部ツール定義 (設定編集用: command/args も含む) */
export interface ExternalToolDef {
  id: string;
  label: string;
  command: string;
  args?: string[];
  group?: string;
  kind?: 'file' | 'dir' | 'any';
  extensions?: string[];
  confirm?: boolean;
}

/** 差分ツール定義 (設定編集用) */
export interface DiffToolDef {
  id: string;
  label: string;
  command: string;
  args?: string[];
  default?: boolean;
}

/** GET/PUT /api/settings の本体 */
export interface AppSettings {
  commitFilesLimit: number;
  contextMenu: Record<string, boolean>;
  externalTools: ExternalToolDef[];
  diffTools: DiffToolDef[];
  extDefaults: Record<string, string>;
}
