import type {
  AppSettings,
  AppState,
  CommitFilesResult,
  ConflictFile,
  ConflictVersions,
  Eol,
  Favorite,
  FsEntry,
  GitBranch,
  GitCommit,
  GitGraphCommit,
  GitStatus,
  MergeState,
  RebaseActionResult,
  RebaseBackup,
  RebaseSession,
  ReadResult,
  VolumeInfo,
} from '../types';

declare const __APP_TOKEN__: string;
export const APP_TOKEN = __APP_TOKEN__;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'x-app-token': APP_TOKEN,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let code = 'error';
    let message = res.statusText;
    try {
      const body = await res.json();
      code = body.error ?? code;
      message = body.message ?? message;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, code, message);
  }
  return res.json() as Promise<T>;
}

const get = <T>(url: string) => request<T>(url);
const post = <T>(url: string, body: unknown) =>
  request<T>(url, { method: 'POST', body: JSON.stringify(body) });
const put = <T>(url: string, body: unknown) =>
  request<T>(url, { method: 'PUT', body: JSON.stringify(body) });
const del = <T>(url: string, body: unknown) =>
  request<T>(url, { method: 'DELETE', body: JSON.stringify(body) });

const q = encodeURIComponent;

export const api = {
  // --- fs ---
  volumes: () => get<{ volumes: VolumeInfo[]; home: string }>('/api/fs/volumes'),
  list: (path: string) => get<{ path: string; entries: FsEntry[] }>(`/api/fs/list?path=${q(path)}`),
  stat: (path: string) =>
    get<FsEntry & { ctime: number; mode: number }>(`/api/fs/stat?path=${q(path)}`),
  read: (path: string, encoding?: string) =>
    get<ReadResult>(`/api/fs/read?path=${q(path)}${encoding ? `&encoding=${q(encoding)}` : ''}`),
  write: (body: { path: string; content: string; encoding?: string; eol?: Eol; bom?: boolean }) =>
    post<{ ok: true; size: number; mtime: number }>('/api/fs/write', body),
  mkdir: (path: string) => post<{ ok: true; path: string }>('/api/fs/mkdir', { path }),
  create: (path: string) => post<{ ok: true; path: string }>('/api/fs/create', { path }),
  rename: (path: string, newName: string) =>
    post<{ ok: true; path: string }>('/api/fs/rename', { path, newName }),
  move: (src: string[], destDir: string) =>
    post<{ ok: true; moved: string[] }>('/api/fs/move', { src, destDir }),
  copy: (src: string[], destDir: string) =>
    post<{ ok: true; copied: string[] }>('/api/fs/copy', { src, destDir }),
  delete: (paths: string[], permanent = false) =>
    del<{ ok: true }>('/api/fs/delete', { paths, permanent }),
  search: (dir: string, query: string) =>
    get<{ results: FsEntry[] }>(`/api/fs/search?dir=${q(dir)}&query=${q(query)}`),

  // --- config ---
  uiConfig: () =>
    get<{
      contextMenu: Record<string, boolean>;
      externalTools: {
        id: string;
        label: string;
        group?: string;
        kind?: 'file' | 'dir' | 'any';
        extensions?: string[];
        confirm?: boolean;
      }[];
      diffTools: { id: string; label: string; isDefault?: boolean }[];
      extDefaults: Record<string, string>;
    }>('/api/config'),

  // 設定編集 (command/args も含む全項目)
  getSettings: () => get<AppSettings>('/api/settings'),
  putSettings: (partial: Partial<AppSettings>) => put<AppSettings>('/api/settings', partial),

  // --- git ---
  isRepo: (path: string) =>
    get<{ isRepo: boolean; root?: string }>(`/api/git/is-repo?path=${q(path)}`),
  gitStatus: (repo: string) => get<GitStatus>(`/api/git/status?repo=${q(repo)}`),
  gitEntriesStatus: (repo: string, dir: string, names: string[]) =>
    post<{ ignored: string[]; untracked: string[] }>('/api/git/entries-status', { repo, dir, names }),
  gitLog: (repo: string, opts: { limit?: number; skip?: number; path?: string; follow?: boolean } = {}) =>
    get<{ commits: GitCommit[] }>(
      `/api/git/log?repo=${q(repo)}&limit=${opts.limit ?? 100}` +
        `${opts.skip ? `&skip=${opts.skip}` : ''}` +
        `${opts.path ? `&path=${q(opts.path)}` : ''}` +
        `${opts.follow ? '&follow=true' : ''}`,
    ),
  gitGraph: (
    repo: string,
    opts: { all?: boolean; limit?: number; skip?: number; path?: string; follow?: boolean } = {},
  ) =>
    get<{ commits: GitGraphCommit[] }>(
      `/api/git/graph?repo=${q(repo)}&limit=${opts.limit ?? 200}` +
        `${opts.skip ? `&skip=${opts.skip}` : ''}${opts.all ? '&all=true' : ''}` +
        `${opts.path ? `&path=${q(opts.path)}` : ''}` +
        `${opts.follow ? '&follow=true' : ''}`,
    ),
  gitCommitFiles: (repo: string, hash: string) =>
    get<CommitFilesResult>(`/api/git/commit-files?repo=${q(repo)}&hash=${q(hash)}`),
  gitCommitFileDiff: (repo: string, hash: string, path: string) =>
    get<{ path: string; before: string | null; after: string | null; binary: boolean }>(
      `/api/git/commit-file-diff?repo=${q(repo)}&hash=${q(hash)}&path=${q(path)}`,
    ),
  gitShow: (repo: string, hash: string) =>
    get<{ hash: string; author: string; date: string; message: string; patch: string }>(
      `/api/git/show?repo=${q(repo)}&hash=${q(hash)}`,
    ),
  gitDiff: (repo: string, path?: string, staged = false, untracked = false) =>
    get<{ diff: string }>(
      `/api/git/diff?repo=${q(repo)}${path ? `&path=${q(path)}` : ''}&staged=${staged}` +
        (untracked ? '&untracked=true' : ''),
    ),
  /** Hunk・行単位の部分ステージ/解除。reverse でステージ解除、cached=false で作業ツリーへ適用 (破棄) */
  gitApplyPatch: (repo: string, patch: string, reverse: boolean, cached = true) =>
    post<{ ok: true }>('/api/git/apply-patch', { repo, patch, reverse, cached }),
  /** 外部差分ツール (設定の diffTools) で比較を開く。tool は設定の id */
  gitDiffTool: (
    tool: string,
    repo: string,
    path: string,
    mode: 'commit' | 'staged' | 'worktree',
    hash?: string,
  ) =>
    post<{ ok: true; command: string; left: string; right: string }>('/api/git/difftool', {
      tool,
      repo,
      path,
      mode,
      hash,
    }),
  gitStage: (repo: string, paths: string[]) => post<{ ok: true }>('/api/git/stage', { repo, paths }),
  gitUnstage: (repo: string, paths: string[]) =>
    post<{ ok: true }>('/api/git/unstage', { repo, paths }),
  gitDiscard: (repo: string, paths: string[], full = false) =>
    post<{ ok: true }>('/api/git/discard', { repo, paths, full }),
  gitCommit: (repo: string, message: string, amend = false) =>
    post<{ ok: true; commit: string }>('/api/git/commit', { repo, message, amend }),
  /** 直近のコミットメッセージ (再利用候補。新しい順・重複なし・最大 20 件) */
  gitCommitMessages: () => get<{ messages: string[] }>('/api/git/commit-messages'),
  /** コミット成功時にメッセージを履歴へ記録 */
  gitAddCommitMessage: (message: string) =>
    post<{ ok: true }>('/api/git/commit-messages', { message }),
  gitPush: (repo: string) => post<{ ok: true }>('/api/git/push', { repo }),
  gitPull: (repo: string) => post<{ ok: true }>('/api/git/pull', { repo }),
  gitFetch: (repo: string) => post<{ ok: true }>('/api/git/fetch', { repo }),
  gitBranches: (repo: string) =>
    get<{ current: string; branches: GitBranch[] }>(`/api/git/branches?repo=${q(repo)}`),
  gitBranch: (repo: string, action: 'create' | 'checkout' | 'delete', name: string) =>
    post<{ ok: true }>('/api/git/branch', { repo, action, name }),
  gitMerge: (repo: string, branch: string) => post<{ ok: true }>('/api/git/merge', { repo, branch }),
  gitStash: (repo: string, action: 'save' | 'pop' | 'list') =>
    post<{ ok: true; list?: unknown[] }>('/api/git/stash', { repo, action }),
  gitInit: (path: string) => post<{ ok: true }>('/api/git/init', { path }),
  /** git コマンド実行: 非 0 終了でも HTTP 200 で ok:false が返る */
  // --- リポジトリ単位の認証設定 (鍵のパス等の参照のみ保存。秘密情報は保持しない) ---
  gitAuthGet: (repo: string) =>
    get<{
      auth: { sshKey: string; credentialHelper: string };
      sshKeys: string[];
      remotes: { name: string; url: string }[];
    }>(`/api/git/auth?repo=${q(repo)}`),
  gitAuthSet: (repo: string, sshKey: string, credentialHelper: string) =>
    post<{ ok: true; auth: { sshKey: string; credentialHelper: string } }>('/api/git/auth', {
      repo,
      sshKey,
      credentialHelper,
    }),
  gitAuthTest: (repo: string, remote: string) =>
    post<{ ok: boolean; command: string; output: string }>('/api/git/auth/test', { repo, remote }),

  gitExec: (repo: string, args: string[]) =>
    post<{ ok: boolean; code: number; command: string; output: string }>('/api/git/exec', {
      repo,
      args,
    }),
  gitClone: (body: { url: string; dir: string; branch?: string; depth?: number; recursive?: boolean }) =>
    post<{ ok: true; id: string }>('/api/git/clone', body),

  // --- git: 競合解消 (002.md §2) ---
  gitMergeState: (repo: string) => get<MergeState>(`/api/git/merge-state?repo=${q(repo)}`),
  gitConflicts: (repo: string, dir?: string) =>
    get<{ files: ConflictFile[] }>(`/api/git/conflicts?repo=${q(repo)}${dir ? `&dir=${q(dir)}` : ''}`),
  gitConflictVersions: (repo: string, path: string) =>
    get<ConflictVersions>(`/api/git/conflict/versions?repo=${q(repo)}&path=${q(path)}`),
  gitConflictResolve: (repo: string, path: string, content: string) =>
    post<{ ok: true }>('/api/git/conflict/resolve', { repo, path, content }),
  gitConflictTake: (repo: string, paths: string[], side: 'ours' | 'theirs') =>
    post<{ ok: true }>('/api/git/conflict/take', { repo, paths, side }),
  gitMergeContinue: (repo: string) => post<{ ok: true }>('/api/git/merge/continue', { repo }),
  gitMergeAbort: (repo: string) => post<{ ok: true }>('/api/git/merge/abort', { repo }),

  // --- git: リベース (アプリ起点。バックアップ + セッションによる全画面ロック) ---
  gitRebaseSession: (repo: string) =>
    get<{ session: RebaseSession | null; mergeState: MergeState }>(
      `/api/git/rebase/session?repo=${q(repo)}`,
    ),
  gitRebaseStart: (repo: string, onto: string, deleteBackupOnSuccess: boolean) =>
    post<RebaseActionResult>('/api/git/rebase/start', { repo, onto, deleteBackupOnSuccess }),
  gitRebaseContinue: (repo: string) => post<RebaseActionResult>('/api/git/rebase/continue', { repo }),
  gitRebaseAbort: (repo: string) => post<RebaseActionResult>('/api/git/rebase/abort', { repo }),
  gitRebaseSessionClear: (repo: string) => post<{ ok: true }>('/api/git/rebase/session/clear', { repo }),
  gitRebaseBackups: (repo: string) =>
    get<{ backups: RebaseBackup[] }>(`/api/git/rebase/backups?repo=${q(repo)}`),
  gitRebaseBackupDelete: (repo: string, name: string) =>
    post<{ ok: true; output: string }>('/api/git/rebase/backups/delete', { repo, name }),

  // --- git: グラフ上のコミット操作 (002.md §5.5) ---
  gitCheckoutCommit: (repo: string, hash: string) =>
    post<{ ok: true }>('/api/git/checkout-commit', { repo, hash }),
  gitReset: (repo: string, hash: string, mode: 'soft' | 'mixed' | 'hard') =>
    post<{ ok: true }>('/api/git/reset', { repo, hash, mode }),
  gitCherryPick: (repo: string, hash: string) => post<{ ok: true }>('/api/git/cherry-pick', { repo, hash }),
  gitTag: (repo: string, name: string, hash: string) =>
    post<{ ok: true }>('/api/git/tag', { repo, name, hash }),

  // --- os 連携 (002.md §4) ---
  osPlatform: () => get<{ platform: string }>('/api/os/platform'),
  osOpenFileManager: (path: string) => post<{ ok: true }>('/api/os/open-in-file-manager', { path }),
  osOpenTerminal: (path: string) => post<{ ok: true }>('/api/os/open-in-terminal', { path }),
  osRunTool: (tool: string, paths: string[]) => post<{ ok: true }>('/api/os/run-tool', { tool, paths }),

  // --- クイックアクセス (002.md §7) ---
  quickaccessList: () => get<{ favorites: Favorite[] }>('/api/quickaccess'),
  quickaccessAdd: (path: string, label?: string) =>
    post<{ ok: true; added: boolean; favorites: Favorite[] }>('/api/quickaccess', { path, label }),
  quickaccessRemove: (path: string) =>
    del<{ ok: true; removed: boolean; favorites: Favorite[] }>('/api/quickaccess', { path }),
  quickaccessReorder: (paths: string[]) =>
    post<{ ok: true; favorites: Favorite[] }>('/api/quickaccess/reorder', { paths }),

  // --- state ---
  getState: () => get<AppState>('/api/state'),
  putState: (partial: Partial<AppState>) => put<{ ok: true }>('/api/state', partial),
  importState: (state: Partial<AppState>) => post<{ ok: true }>('/api/state/import', state),
};
