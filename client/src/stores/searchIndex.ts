import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from '../api/client';
import { onWsEvent } from '../api/ws';
import { toastError } from './toast';
import type { ContentSearchParams, ContentSearchResult, IndexSettings, IndexStatus } from '../types';

/**
 * 検索インデックス (Git リポジトリ単位。サーバの services/searchIndex.ts)。
 * - 状態はリポジトリごとに控え、サーバからのプッシュ (search-index:status) で更新する
 * - 内容検索 (左パネルの検索) の入力・条件・結果もここに持つ (パネルを切り替えても残す)
 */

export const DEFAULT_INDEX_SETTINGS: IndexSettings = {
  excludes: ['.git', 'node_modules'],
  useGitignore: true,
  maxFileKB: 1024,
};

/** 内容検索の結果の上限 (一致の件数) */
export const CONTENT_SEARCH_LIMIT = 3000;

/** Windows のドライブパスは大文字小文字を区別しない */
function keyOf(repo: string): string {
  return /^[A-Za-z]:/.test(repo) ? repo.toLowerCase() : repo;
}

interface SearchIndexStore {
  statuses: Record<string, IndexStatus>;
  refresh: (repo: string) => Promise<void>;
  enable: (repo: string, settings: IndexSettings) => Promise<boolean>;
  disable: (repo: string) => Promise<boolean>;
  saveSettings: (repo: string, settings: IndexSettings) => Promise<boolean>;
  rescan: (repo: string, rebuild: boolean) => Promise<void>;
}

export const useSearchIndex = create<SearchIndexStore>((set) => {
  const put = (st: IndexStatus) => set((s) => ({ statuses: { ...s.statuses, [keyOf(st.repo)]: st } }));
  return {
    statuses: {},
    refresh: async (repo) => {
      try {
        put(await api.searchIndexStatus(repo));
      } catch {
        /* 取れなければ前の状態のまま */
      }
    },
    enable: async (repo, settings) => {
      try {
        put(await api.searchIndexEnable(repo, settings));
        return true;
      } catch (e) {
        toastError(e);
        return false;
      }
    },
    disable: async (repo) => {
      try {
        put(await api.searchIndexDisable(repo));
        return true;
      } catch (e) {
        toastError(e);
        return false;
      }
    },
    saveSettings: async (repo, settings) => {
      try {
        put(await api.searchIndexSettings(repo, settings));
        return true;
      } catch (e) {
        toastError(e);
        return false;
      }
    },
    rescan: async (repo, rebuild) => {
      try {
        put(await api.searchIndexRescan(repo, rebuild));
      } catch (e) {
        toastError(e);
      }
    },
  };
});

let subscribed = false;
function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  onWsEvent('search-index:status', (data) => {
    const st = data as IndexStatus;
    if (!st || typeof st.repo !== 'string') return;
    useSearchIndex.setState((s) => ({ statuses: { ...s.statuses, [keyOf(st.repo)]: st } }));
  });
}

/** repo のインデックスの状態 (未取得なら null)。repo が変わったら取り直す */
export function useIndexStatus(repo: string | null): IndexStatus | null {
  useEffect(() => {
    subscribe();
    if (repo) void useSearchIndex.getState().refresh(repo);
  }, [repo]);
  return useSearchIndex((s) => (repo ? (s.statuses[keyOf(repo)] ?? null) : null));
}

/** 状態を取り直さずに今の値だけ見る (ショートカットの判定用) */
export function indexStatusOf(repo: string | null): IndexStatus | null {
  subscribe();
  return repo ? (useSearchIndex.getState().statuses[keyOf(repo)] ?? null) : null;
}

// ---- 内容検索 ----

interface ContentSearchStore extends ContentSearchParams {
  /** 詳細 (含める / 除外するファイル) の入力欄を出すか */
  showDetails: boolean;
  /** 結果を出しているリポジトリ */
  repo: string | null;
  result: ContentSearchResult | null;
  /** 結果を出したときの検索語・条件 (見出しや再検索に使う) */
  resultParams: ContentSearchParams | null;
  loading: boolean;
  error: string | null;
  /** 折り畳んだファイル (相対パス) */
  collapsed: Set<string>;
  set: (patch: Partial<ContentSearchParams & { showDetails: boolean }>) => void;
  run: (repo: string) => Promise<void>;
  clear: () => void;
  toggleCollapsed: (path: string) => void;
  setAllCollapsed: (collapsed: boolean) => void;
}

let controller: AbortController | null = null;

export const useContentSearch = create<ContentSearchStore>((set, get) => ({
  query: '',
  matchCase: false,
  wholeWord: false,
  regex: false,
  include: '',
  exclude: '',
  showDetails: false,
  repo: null,
  result: null,
  resultParams: null,
  loading: false,
  error: null,
  collapsed: new Set(),
  set: (patch) => set(patch),
  run: async (repo) => {
    const s = get();
    const params: ContentSearchParams = {
      query: s.query,
      matchCase: s.matchCase,
      wholeWord: s.wholeWord,
      regex: s.regex,
      include: s.include,
      exclude: s.exclude,
    };
    controller?.abort();
    if (!params.query) {
      controller = null;
      set({ result: null, resultParams: null, loading: false, error: null, repo });
      return;
    }
    const my = new AbortController();
    controller = my;
    set({ loading: true, error: null });
    try {
      const result = await api.searchIndexContent(repo, params, CONTENT_SEARCH_LIMIT, my.signal);
      if (controller !== my) return;
      set({ result, resultParams: params, repo, loading: false, collapsed: new Set() });
    } catch (e) {
      if (controller !== my || my.signal.aborted) return;
      set({ loading: false, error: e instanceof Error ? e.message : String(e), result: null, resultParams: params, repo });
    }
  },
  clear: () => {
    controller?.abort();
    controller = null;
    set({ query: '', result: null, resultParams: null, loading: false, error: null, collapsed: new Set() });
  },
  toggleCollapsed: (path) =>
    set((s) => {
      const next = new Set(s.collapsed);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { collapsed: next };
    }),
  setAllCollapsed: (collapsed) =>
    set((s) => ({ collapsed: collapsed ? new Set(s.result?.files.map((f) => f.path) ?? []) : new Set() })),
}));
