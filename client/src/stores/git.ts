import { create } from 'zustand';
import { api } from '../api/client';
import type { GitStatus } from '../types';

/**
 * ファイル一覧オーバーレイ用の Git 状態コード
 * plan §8.1: ✔ Normal / ● Modified / ＋ Staged / ？ Untracked / ⚠ Conflicted / － Ignored
 */
export type OverlayCode = 'normal' | 'modified' | 'staged' | 'untracked' | 'conflicted';

interface GitStore {
  repoRoot: string | null;
  status: GitStatus | null;
  /** repo 相対ではなく絶対パス → オーバーレイコード */
  overlay: Record<string, OverlayCode>;
  checkRepo: (dirPath: string) => Promise<void>;
  refreshStatus: () => Promise<void>;
}

function buildOverlay(root: string, status: GitStatus): Record<string, OverlayCode> {
  const overlay: Record<string, OverlayCode> = {};
  const conflicted = new Set(status.conflicted);
  for (const f of status.files) {
    const abs = `${root}/${f.path}`;
    if (conflicted.has(f.path)) {
      overlay[abs] = 'conflicted';
    } else if (f.index === '?' || f.workingDir === '?') {
      overlay[abs] = 'untracked';
    } else if (f.workingDir !== ' ' && f.workingDir !== '') {
      overlay[abs] = 'modified';
    } else {
      overlay[abs] = 'staged';
    }
    // 祖先フォルダにも「変更あり」を伝播
    let dir = abs;
    while (dir.length > root.length) {
      dir = dir.slice(0, dir.lastIndexOf('/'));
      if (dir.length >= root.length && !overlay[dir]) overlay[dir] = 'modified';
    }
  }
  return overlay;
}

export const useGit = create<GitStore>((set, get) => ({
  repoRoot: null,
  status: null,
  overlay: {},

  checkRepo: async (dirPath) => {
    try {
      const { isRepo, root } = await api.isRepo(dirPath);
      if (isRepo && root) {
        if (get().repoRoot !== root) set({ repoRoot: root, status: null, overlay: {} });
        else set({ repoRoot: root });
        await get().refreshStatus();
      } else {
        set({ repoRoot: null, status: null, overlay: {} });
      }
    } catch {
      set({ repoRoot: null, status: null, overlay: {} });
    }
  },

  refreshStatus: async () => {
    const root = get().repoRoot;
    if (!root) return;
    try {
      const status = await api.gitStatus(root);
      set({ status, overlay: buildOverlay(root, status) });
    } catch {
      /* repo が消えた等 */
    }
  },
}));
