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
