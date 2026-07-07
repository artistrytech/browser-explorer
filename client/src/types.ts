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
