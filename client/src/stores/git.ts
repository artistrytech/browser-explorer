import { create } from 'zustand';
import { api } from '../api/client';
import { switchView } from './ui';
import { saveGitView } from '../lib/gitViewMemory';
import type { GitStatus, MergeState } from '../types';

export type GitTab = 'changes' | 'log' | 'branches';

/** パス絞り込みログの条件 (002.md §1)。path はリポジトリルート相対 */
export interface LogFilter {
  path: string;
  follow: boolean;
}

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
  /** マージ/リベース/cherry-pick の進行状態 (002.md §2.2) */
  mergeState: MergeState;
  /** Git パネルの表示タブ (コンテキストメニューから外部制御するためストアに置く) */
  panelTab: GitTab;
  /** ログのパス絞り込み。null なら全体 (002.md §1) */
  logFilter: LogFilter | null;
  checkRepo: (dirPath: string) => Promise<void>;
  refreshStatus: () => Promise<void>;
  setPanelTab: (tab: GitTab) => void;
  setLogFilter: (f: LogFilter | null) => void;
  /** 「ログを表示」: 絞り込みを設定して Git パネルのログタブを開く (002.md §1.2) */
  showLogFor: (relPath: string, isFile: boolean) => void;
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

const NO_MERGE: MergeState = { inProgress: null, conflicted: [] };

export const useGit = create<GitStore>((set, get) => ({
  repoRoot: null,
  status: null,
  overlay: {},
  mergeState: NO_MERGE,
  panelTab: 'changes',
  logFilter: null,

  checkRepo: async (dirPath) => {
    try {
      const { isRepo, root } = await api.isRepo(dirPath);
      if (isRepo && root) {
        if (get().repoRoot !== root) {
          set({ repoRoot: root, status: null, overlay: {}, mergeState: NO_MERGE, logFilter: null });
        } else {
          set({ repoRoot: root });
        }
        await get().refreshStatus();
      } else {
        set({ repoRoot: null, status: null, overlay: {}, mergeState: NO_MERGE, logFilter: null });
      }
    } catch {
      set({ repoRoot: null, status: null, overlay: {}, mergeState: NO_MERGE, logFilter: null });
    }
  },

  refreshStatus: async () => {
    const root = get().repoRoot;
    if (!root) return;
    try {
      const [status, mergeState] = await Promise.all([
        api.gitStatus(root),
        api.gitMergeState(root).catch(() => NO_MERGE),
      ]);
      set({ status, overlay: buildOverlay(root, status), mergeState });
    } catch {
      /* repo が消えた等 */
    }
  },

  setPanelTab: (panelTab) => set({ panelTab }),
  setLogFilter: (logFilter) => set({ logFilter }),

  showLogFor: (relPath, isFile) => {
    // 差分ファイル一覧のフィルタ初期値として対象パスを設定 (GitPanel が復元する)
    const repo = get().repoRoot;
    if (repo) saveGitView(repo, { filesFilter: relPath });
    // リポジトリルート自体 ('') は全体表示 = 絞り込みなし
    set({ panelTab: 'log', logFilter: relPath ? { path: relPath, follow: isFile } : null });
    switchView('git');
  },
}));
