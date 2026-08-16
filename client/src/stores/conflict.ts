import { create } from 'zustand';
import { useGit } from './git';
import type { MergeState } from '../types';

/**
 * 競合解消ツールの開閉状態と、競合まわりの共通判定 (002.md §2)。
 *
 * 競合解消ツール本体 (ConflictResolver) とその起動元 (GitCommandDialog 等) の
 * 双方から参照するため、循環 import を避けてストアだけをここに置く。
 */

/**
 * 競合の状態。
 * merge/rebase/cherry-pick は git の操作が進行中で、--continue / --abort が使える。
 * 一方 stash の復元 (pop/apply) や cherry-pick --no-commit で競合した場合は
 * MERGE_HEAD 等の進行中フラグが残らず、「未解決の競合だけがインデックスに残る」
 * 状態になる。これを 'pending' として扱う。
 */
export type ConflictMode = NonNullable<MergeState['inProgress']> | 'pending';

export function conflictMode(m: MergeState): ConflictMode | null {
  return m.inProgress ?? (m.conflicted.length > 0 ? 'pending' : null);
}

/** 進行中の git 操作の表示名 (pending / なしは空文字) */
export function operationLabel(m: MergeState['inProgress']): string {
  return m === 'merge' ? 'マージ' : m === 'rebase' ? 'リベース' : m === 'cherry-pick' ? 'cherry-pick' : '';
}

interface ConflictStore {
  open: boolean;
  /** 絞り込み対象 (repo 相対ディレクトリ、'' で全体) */
  dir: string;
  /** 3-way ツールで開いているファイル (repo 相対)。null なら一覧 */
  file: string | null;
  /**
   * 進行中の git 操作を伴わない競合 ('pending') として開いたか。
   * この場合は競合が 0 件になっても自動で閉じず、後始末 (退避の削除など) を案内する。
   */
  sticky: boolean;
  show: (dir: string, sticky: boolean) => void;
  openFile: (path: string) => void;
  backToList: () => void;
  close: () => void;
}

export const useConflictResolver = create<ConflictStore>((set) => ({
  open: false,
  dir: '',
  file: null,
  sticky: false,
  show: (dir, sticky) => set({ open: true, dir, sticky, file: null }),
  openFile: (file) => set({ file }),
  backToList: () => set({ file: null }),
  close: () => set({ open: false, file: null }),
}));

export function openConflictResolver(relDir: string): void {
  useConflictResolver.getState().show(relDir, useGit.getState().mergeState.inProgress === null);
}

/**
 * pop での stash 復元が競合で中断したときに残る退避。
 * git は競合時に退避を削除しないため、競合を解決し終えたあとに削除できるよう控えておく。
 * ref は他の stash 操作でずれ得るので、取り違え防止用に hash も持つ。
 */
export interface PendingStash {
  repo: string;
  ref: string;
  hash: string;
  message: string;
}

interface PendingStashStore {
  pending: PendingStash | null;
  setPendingStash: (p: PendingStash | null) => void;
}

export const usePendingStash = create<PendingStashStore>((set) => ({
  pending: null,
  setPendingStash: (pending) => set({ pending }),
}));
