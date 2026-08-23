import { create } from 'zustand';
import { api } from '../api/client';
import { watchPath } from '../api/ws';
import { toastError } from './toast';
import { useUi } from './ui';
import { loadFocus } from '../lib/focusMemory';
import { parentPath } from '../lib/paths';
import type { FsEntry } from '../types';

/** sessionStorage の記録から選択/フォーカスを復元する (002.md §6.4/§6.5) */
function restoredSelection(path: string, entries: FsEntry[]): { selection: string[]; anchor: string | null } {
  const rec = loadFocus(path);
  if (!rec) return { selection: [], anchor: null };
  const byName = new Map(entries.map((e) => [e.name, e.path]));
  const selection = rec.selected.map((n) => byName.get(n)).filter((p): p is string => !!p);
  let anchor = rec.focused ? (byName.get(rec.focused) ?? null) : null;
  if (rec.focused && !anchor && entries.length > 0 && rec.focusedIndex >= 0) {
    // 項目消失/リネーム時は近い index にフォールバック
    anchor = entries[Math.min(rec.focusedIndex, entries.length - 1)].path;
    return { selection: [anchor], anchor };
  }
  return { selection, anchor };
}

/**
 * フォルダとして開けなかったパスがファイルだった場合に、そのフォルダへ移動したうえで
 * ファイル自体も開く (「ファイル」タブでのダブルクリックと同じ挙動)。
 * 開けたら true、フォルダでもファイルでもない (存在しない等) なら false を返し、
 * 呼び元のエラー処理に任せる。
 */
async function openFileTarget(path: string, push: boolean): Promise<boolean> {
  let entry: FsEntry;
  try {
    entry = await api.stat(path);
  } catch {
    return false;
  }
  const dir = parentPath(entry.path);
  // フォルダ自体が開けなかった場合 (権限が無い等) は、親へ移動しても状況は変わらない
  if (entry.type === 'dir' || dir === entry.path) return false;
  await useExplorer.getState().navigate(dir, push);
  useExplorer.getState().setSelection([entry.path], entry.path);
  // push=false (起動時・戻る/進む) では navigate が URL を触らないので、
  // 現在の履歴エントリの path をフォルダへ直しておく (戻るたびに開き直さないため)
  const params = new URLSearchParams(location.search);
  if (params.get('path') !== dir) {
    params.set('path', dir);
    history.replaceState({ ...history.state, path: dir }, '', `${location.pathname}?${params}`);
  }
  // fileOps はこのストアを参照するため、循環 import にならないよう遅延読み込みする
  const { openWithDefault } = await import('../lib/fileOps');
  openWithDefault(entry);
  return true;
}

export interface Clipboard {
  op: 'copy' | 'cut';
  paths: string[];
}

interface ExplorerStore {
  path: string;
  entries: FsEntry[];
  loading: boolean;
  selection: string[]; // 選択中エントリのパス(順序保持)
  anchor: string | null; // Shift 選択の起点
  clipboard: Clipboard | null;
  renaming: string | null; // インライン リネーム中のパス
  searchQuery: string;
  searchResults: FsEntry[] | null;

  navigate: (path: string, push?: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  setSelection: (paths: string[], anchor?: string | null) => void;
  setClipboard: (c: Clipboard | null) => void;
  setRenaming: (path: string | null) => void;
  /** 名前で検索。push=true でブラウザ履歴に追加 (URL の ?q= に反映) */
  runSearch: (query: string, push?: boolean) => Promise<void>;
  clearSearch: () => void;
}

export function pathFromUrl(): string {
  const p = new URLSearchParams(location.search).get('path');
  return p && p.length > 0 ? p : '/';
}

/** URL の ?q= から検索クエリを復元 */
export function searchFromUrl(): string {
  return new URLSearchParams(location.search).get('q') ?? '';
}

export const useExplorer = create<ExplorerStore>((set, get) => ({
  path: pathFromUrl(),
  entries: [],
  loading: false,
  selection: [],
  anchor: null,
  clipboard: null,
  renaming: null,
  searchQuery: '',
  searchResults: null,

  navigate: async (path, push = true) => {
    set({ loading: true, searchResults: null, searchQuery: '' });
    try {
      const { path: resolved, entries } = await api.list(path);
      if (push) {
        // フォルダ移動時はビューを「ファイル」へ強制復帰 (?view= も付けない)
        const url = `${location.pathname}?path=${encodeURIComponent(resolved)}`;
        history.pushState({ path: resolved, view: 'files' }, '', url);
        useUi.getState().setView('files');
      }
      const { selection, anchor } = restoredSelection(resolved, entries);
      set({ path: resolved, entries, selection, anchor, renaming: null });
      watchPath(resolved);
    } catch (e) {
      // パスにフォルダではなくファイルが指定された場合の救済 (一覧の取得は失敗する)
      if (await openFileTarget(path, push)) return;
      toastError(e);
    } finally {
      set({ loading: false });
    }
  },

  refresh: async () => {
    const { path, searchResults, searchQuery } = get();
    try {
      const { entries } = await api.list(path);
      const alive = new Set(entries.map((e) => e.path));
      set({
        entries,
        selection: get().selection.filter((p) => alive.has(p)),
      });
      if (searchResults && searchQuery) {
        const { results } = await api.search(path, searchQuery);
        set({ searchResults: results });
      }
    } catch (e) {
      toastError(e);
    }
  },

  setSelection: (selection, anchor) =>
    set((s) => ({ selection, anchor: anchor === undefined ? s.anchor : anchor })),
  setClipboard: (clipboard) => set({ clipboard }),
  setRenaming: (renaming) => set({ renaming }),

  runSearch: async (query, push = true) => {
    if (!query) {
      get().clearSearch();
      return;
    }
    set({ loading: true, searchQuery: query });
    try {
      const { results } = await api.search(get().path, query);
      if (push) {
        // 検索実行をブラウザ履歴に追加 (戻るで検索前の一覧へ)
        const params = new URLSearchParams();
        params.set('path', get().path);
        params.set('q', query);
        history.pushState({ path: get().path, view: 'files' }, '', `${location.pathname}?${params}`);
        useUi.getState().setView('files');
      }
      set({ searchResults: results, selection: [] });
    } catch (e) {
      toastError(e);
    } finally {
      set({ loading: false });
    }
  },

  clearSearch: () => {
    set({ searchResults: null, searchQuery: '' });
    // URL の ?q= も現状に合わせる (履歴は積まない)
    const params = new URLSearchParams(location.search);
    if (params.has('q')) {
      params.delete('q');
      history.replaceState(history.state, '', `${location.pathname}?${params}`);
    }
  },
}));
