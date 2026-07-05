import type {
  AppState,
  Eol,
  FsEntry,
  GitBranch,
  GitCommit,
  GitStatus,
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

  // --- git ---
  isRepo: (path: string) =>
    get<{ isRepo: boolean; root?: string }>(`/api/git/is-repo?path=${q(path)}`),
  gitStatus: (repo: string) => get<GitStatus>(`/api/git/status?repo=${q(repo)}`),
  gitLog: (repo: string, limit = 100) =>
    get<{ commits: GitCommit[] }>(`/api/git/log?repo=${q(repo)}&limit=${limit}`),
  gitShow: (repo: string, hash: string) =>
    get<{ hash: string; author: string; date: string; message: string; patch: string }>(
      `/api/git/show?repo=${q(repo)}&hash=${q(hash)}`,
    ),
  gitDiff: (repo: string, path?: string, staged = false) =>
    get<{ diff: string }>(
      `/api/git/diff?repo=${q(repo)}${path ? `&path=${q(path)}` : ''}&staged=${staged}`,
    ),
  gitStage: (repo: string, paths: string[]) => post<{ ok: true }>('/api/git/stage', { repo, paths }),
  gitUnstage: (repo: string, paths: string[]) =>
    post<{ ok: true }>('/api/git/unstage', { repo, paths }),
  gitDiscard: (repo: string, paths: string[]) =>
    post<{ ok: true }>('/api/git/discard', { repo, paths }),
  gitCommit: (repo: string, message: string, amend = false) =>
    post<{ ok: true; commit: string }>('/api/git/commit', { repo, message, amend }),
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
  gitClone: (url: string, dir: string) => post<{ ok: true }>('/api/git/clone', { url, dir }),

  // --- state ---
  getState: () => get<AppState>('/api/state'),
  putState: (partial: Partial<AppState>) => put<{ ok: true }>('/api/state', partial),
  importState: (state: Partial<AppState>) => post<{ ok: true }>('/api/state/import', state),
};
