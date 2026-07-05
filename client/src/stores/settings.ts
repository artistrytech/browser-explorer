import { create } from 'zustand';
import { api } from '../api/client';
import { useToast, toastError } from './toast';
import type { Favorite, RecentItem, SortKey, ViewMode } from '../types';

export interface Settings {
  modKey: 'ctrl' | 'meta';
  showHidden: boolean;
  viewMode: ViewMode;
  sortKey: SortKey;
  sortAsc: boolean;
  theme: 'light' | 'dark';
  fontSize: number;
  wordWrap: boolean;
  defaultEncoding: string;
  defaultEol: 'CRLF' | 'LF';
  sidebarWidth: number;
}

const DEFAULT_SETTINGS: Settings = {
  modKey: 'ctrl',
  showHidden: false,
  viewMode: 'details',
  sortKey: 'name',
  sortAsc: true,
  theme: 'light',
  fontSize: 14,
  wordWrap: false,
  defaultEncoding: 'UTF-8',
  defaultEol: 'LF',
  sidebarWidth: 18,
};

interface SettingsStore {
  settings: Settings;
  favorites: Favorite[];
  repositories: string[];
  recents: RecentItem[];
  loaded: boolean;
  load: () => Promise<void>;
  update: (partial: Partial<Settings>) => void;
  setFavorites: (favorites: Favorite[]) => void;
  addFavorite: (fav: Favorite) => Promise<void>;
  removeFavorite: (path: string) => Promise<void>;
  isPinned: (path: string) => boolean;
  setRepositories: (repos: string[]) => void;
  addRepository: (path: string) => void;
  addRecent: (path: string, kind: 'file' | 'dir') => void;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist(partial: Record<string, unknown>): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.putState(partial).catch(() => {});
  }, 400);
}

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  favorites: [],
  repositories: [],
  recents: [],
  loaded: false,

  load: async () => {
    try {
      const state = await api.getState();
      const saved = (state.settings.app ?? {}) as Partial<Settings>;
      set({
        settings: { ...DEFAULT_SETTINGS, ...saved },
        favorites: state.favorites,
        repositories: state.repositories,
        recents: state.recents,
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },

  update: (partial) => {
    const settings = { ...get().settings, ...partial };
    set({ settings });
    persist({ settings: { app: settings } });
  },

  // 並べ替え (ドラッグ) は専用 API で永続化 (002.md §7.4)
  setFavorites: (favorites) => {
    set({ favorites });
    api
      .quickaccessReorder(favorites.map((f) => f.path))
      .then((r) => set({ favorites: r.favorites }))
      .catch(toastError);
  },

  // ピン止め追加 (002.md §7.2)。重複はサーバー側で無視されトーストで通知
  addFavorite: async (fav) => {
    try {
      const r = await api.quickaccessAdd(fav.path, fav.label);
      set({ favorites: r.favorites });
      useToast
        .getState()
        .show(r.added ? 'success' : 'info', r.added ? 'クイックアクセスにピン止めしました' : 'すでにピン止めされています');
    } catch (e) {
      toastError(e);
    }
  },

  // ピン止め解除 (002.md §7.3)。確認ダイアログは呼び出し側 (unpinFavorite) で行う
  removeFavorite: async (path) => {
    try {
      const r = await api.quickaccessRemove(path);
      set({ favorites: r.favorites });
    } catch (e) {
      toastError(e);
    }
  },

  isPinned: (path) => get().favorites.some((f) => f.path === path),

  setRepositories: (repositories) => {
    set({ repositories });
    persist({ repositories });
  },

  addRepository: (path) => {
    if (get().repositories.includes(path)) return;
    const repositories = [...get().repositories, path];
    set({ repositories });
    persist({ repositories });
  },

  addRecent: (path, kind) => {
    const recents = [
      { path, kind, openedAt: new Date().toISOString() },
      ...get().recents.filter((r) => r.path !== path),
    ].slice(0, 30);
    set({ recents });
    persist({ recents });
  },
}));

/** 設定に応じた修飾キー判定 (Ctrl 基準 / ⌘ 基準) */
export function isMod(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return useSettings.getState().settings.modKey === 'meta' ? e.metaKey : e.ctrlKey;
}
