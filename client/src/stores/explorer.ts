import { create } from 'zustand';
import { api } from '../api/client';
import { watchPath } from '../api/ws';
import { toastError } from './toast';
import { useUi } from './ui';
import { loadFocus } from '../lib/focusMemory';
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
  runSearch: (query: string) => Promise<void>;
  clearSearch: () => void;
}

export function pathFromUrl(): string {
  const p = new URLSearchParams(location.search).get('path');
  return p && p.length > 0 ? p : '/';
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

  runSearch: async (query) => {
    if (!query) {
      set({ searchResults: null, searchQuery: '' });
      return;
    }
    set({ loading: true, searchQuery: query });
    try {
      const { results } = await api.search(get().path, query);
      set({ searchResults: results, selection: [] });
    } catch (e) {
      toastError(e);
    } finally {
      set({ loading: false });
    }
  },

  clearSearch: () => set({ searchResults: null, searchQuery: '' }),
}));
