import { create } from 'zustand';
import { api } from '../api/client';
import { toastError, useToast } from './toast';
import { confirmDialog } from './dialog';
import { switchView, replaceView } from './ui';
import { useSettings } from './settings';
import { baseName } from '../lib/paths';
import type { Eol } from '../types';

export interface EditorTab {
  path: string;
  name: string;
  content: string; // 最新の編集内容 (Monaco と同期)
  savedContent: string;
  encoding: string;
  eol: Eol;
  bom: boolean;
  dirty: boolean;
  mtime: number;
}

interface EditorStore {
  tabs: EditorTab[];
  activePath: string | null;
  cursor: { line: number; col: number };

  open: (path: string) => Promise<void>;
  close: (path: string) => Promise<void>;
  activate: (path: string) => void;
  updateContent: (path: string, content: string) => void;
  save: (path?: string) => Promise<void>;
  saveAll: () => Promise<void>;
  saveAs: (path: string, newPath: string) => Promise<void>;
  reload: (path: string, encoding?: string) => Promise<void>;
  setEncoding: (path: string, encoding: string) => void;
  setEol: (path: string, eol: Eol) => void;
  setBom: (path: string, bom: boolean) => void;
  setCursor: (line: number, col: number) => void;
  handleExternalChange: (path: string) => void;
}

/**
 * このアプリからの保存時刻 (path → epoch ms)。
 * 自分の書き込みで発火した fs 監視イベントを「外部変更」として扱わないための記録。
 */
const ownSaves = new Map<string, number>();
const OWN_SAVE_GRACE_MS = 2000;

export const useEditor = create<EditorStore>((set, get) => ({
  tabs: [],
  activePath: null,
  cursor: { line: 1, col: 1 },

  open: async (path) => {
    const existing = get().tabs.find((t) => t.path === path);
    if (existing) {
      set({ activePath: path });
      switchView('editor');
      return;
    }
    try {
      const r = await api.read(path);
      const tab: EditorTab = {
        path: r.path,
        name: baseName(r.path),
        content: r.content,
        savedContent: r.content,
        encoding: r.encoding,
        eol: r.eol,
        bom: r.bom,
        dirty: false,
        mtime: r.mtime,
      };
      set((s) => ({ tabs: [...s.tabs, tab], activePath: r.path }));
      // ファイル編集開始も履歴に積み、ブラウザバックで「ファイル」タブへ戻れるようにする
      switchView('editor');
      useSettings.getState().addRecent(r.path, 'file');
    } catch (e) {
      toastError(e);
    }
  },

  close: async (path) => {
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab) return;
    if (tab.dirty) {
      const ok = await confirmDialog(
        '未保存の変更',
        `${tab.name} には未保存の変更があります。保存せずに閉じますか?`,
        true,
      );
      if (!ok) return;
    }
    const tabs = get().tabs.filter((t) => t.path !== path);
    let activePath = get().activePath;
    if (activePath === path) {
      const idx = get().tabs.findIndex((t) => t.path === path);
      activePath = tabs[Math.min(idx, tabs.length - 1)]?.path ?? null;
    }
    set({ tabs, activePath });
    if (tabs.length === 0) replaceView('files');
  },

  activate: (path) => {
    set({ activePath: path });
    switchView('editor');
  },

  updateContent: (path, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path ? { ...t, content, dirty: content !== t.savedContent } : t,
      ),
    }));
  },

  save: async (path) => {
    const target = path ?? get().activePath;
    const tab = get().tabs.find((t) => t.path === target);
    if (!tab) return;
    try {
      const r = await api.write({
        path: tab.path,
        content: tab.content,
        encoding: tab.encoding,
        eol: tab.eol,
        bom: tab.bom,
      });
      ownSaves.set(tab.path, Date.now());
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.path === tab.path
            ? { ...t, savedContent: t.content, dirty: false, mtime: r.mtime }
            : t,
        ),
      }));
      // 成功時のトーストは出さない (失敗時のみ通知する)
    } catch (e) {
      toastError(e);
    }
  },

  saveAll: async () => {
    for (const t of get().tabs.filter((t) => t.dirty)) {
      await get().save(t.path);
    }
  },

  saveAs: async (path, newPath) => {
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab) return;
    try {
      await api.write({
        path: newPath,
        content: tab.content,
        encoding: tab.encoding,
        eol: tab.eol,
        bom: tab.bom,
      });
      ownSaves.set(newPath, Date.now());
      // タブを新パスに付け替え
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.path === path
            ? { ...t, path: newPath, name: baseName(newPath), savedContent: t.content, dirty: false }
            : t,
        ),
        activePath: s.activePath === path ? newPath : s.activePath,
      }));
      useToast.getState().show('success', `${baseName(newPath)} として保存しました`);
    } catch (e) {
      toastError(e);
    }
  },

  reload: async (path, encoding) => {
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab) return;
    try {
      const r = await api.read(path, encoding);
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.path === path
            ? {
                ...t,
                content: r.content,
                savedContent: r.content,
                encoding: r.encoding,
                eol: r.eol,
                bom: r.bom,
                dirty: false,
                mtime: r.mtime,
              }
            : t,
        ),
      }));
    } catch (e) {
      toastError(e);
    }
  },

  setEncoding: (path, encoding) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, encoding, dirty: true } : t)),
    })),
  setEol: (path, eol) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, eol, dirty: true } : t)),
    })),
  setBom: (path, bom) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, bom, dirty: true } : t)),
    })),
  setCursor: (line, col) => set({ cursor: { line, col } }),

  handleExternalChange: (path) => {
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab) return;
    // このアプリからの保存で発火したイベントは外部変更として扱わない
    const savedAt = ownSaves.get(path);
    if (savedAt && Date.now() - savedAt < OWN_SAVE_GRACE_MS) return;
    // mtime が保存/読込時と同じなら実際には変わっていない (自分の保存イベントの遅延到達等)
    void api
      .stat(path)
      .then((st) => {
        const cur = get().tabs.find((t) => t.path === path);
        if (!cur || st.mtime === cur.mtime) return;
        if (!cur.dirty) {
          void get().reload(path);
        } else {
          useToast
            .getState()
            .show('info', `${cur.name} が外部で変更されました (未保存の編集があるため再読込していません)`);
        }
      })
      .catch(() => {});
  },
}));
