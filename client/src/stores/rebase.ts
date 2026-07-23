import { create } from 'zustand';
import { api } from '../api/client';
import { useGit } from './git';
import { useToast, toastError } from './toast';
import type { RebaseActionResult, RebaseSession } from '../types';

/**
 * アプリ起点のリベース状態 (README/設計 §リベース):
 * サーバの rebase_sessions 行が存在する間は「リベース中ロック」とみなし、
 * App レベルの全画面モーダルで操作をブロックする。session はサーバ (DB) が真実源で、
 * 別タブ・リロード時も /rebase/session から復元し、WS `git:rebase` で同期する。
 */
interface RebaseStore {
  /** null ならリベース中でない (ロックなし) */
  session: RebaseSession | null;
  /** 直近コマンドの出力 (競合内容・エラー等の表示用) */
  lastOutput: string;
  busy: boolean;
  /** セッションをサーバから取得 (併せて Git status も最新化) */
  refresh: (repo: string) => Promise<void>;
  start: (repo: string, onto: string, deleteBackupOnSuccess: boolean) => Promise<RebaseActionResult | null>;
  continueRebase: (repo: string) => Promise<RebaseActionResult | null>;
  abort: (repo: string) => Promise<RebaseActionResult | null>;
  /** git 実状態とズレたセッションを終了しロック解除 (バックアップは残す) */
  clearSession: (repo: string) => Promise<void>;
}

/** notes / warnings をトーストで通知する共通処理 */
function notify(result: RebaseActionResult): void {
  const show = useToast.getState().show;
  for (const n of result.notes ?? []) show('success', n);
  for (const w of result.warnings ?? []) show('error', w);
}

export const useRebase = create<RebaseStore>((set, get) => ({
  session: null,
  lastOutput: '',
  busy: false,

  refresh: async (repo) => {
    try {
      const [{ session }] = await Promise.all([
        api.gitRebaseSession(repo),
        useGit.getState().refreshStatus(),
      ]);
      set({ session });
    } catch {
      /* repo が消えた等は無視 */
    }
  },

  start: async (repo, onto, deleteBackupOnSuccess) => {
    set({ busy: true, lastOutput: '' });
    try {
      const result = await api.gitRebaseStart(repo, onto, deleteBackupOnSuccess);
      set({ session: result.session ?? null, lastOutput: result.output ?? '' });
      notify(result);
      if (result.phase === 'backup') useToast.getState().show('error', `バックアップの作成に失敗しました:\n${result.output ?? ''}`);
      else if (result.phase === 'done') useToast.getState().show('success', 'リベースが完了しました');
      else if (result.phase === 'failed') useToast.getState().show('error', 'リベースを開始できませんでした');
      await useGit.getState().refreshStatus();
      return result;
    } catch (e) {
      toastError(e);
      await get().refresh(repo);
      return null;
    } finally {
      set({ busy: false });
    }
  },

  continueRebase: async (repo) => {
    set({ busy: true });
    try {
      const result = await api.gitRebaseContinue(repo);
      set({ session: result.session ?? null, lastOutput: result.output ?? get().lastOutput });
      notify(result);
      if (result.phase === 'done') useToast.getState().show('success', 'リベースが完了しました');
      await useGit.getState().refreshStatus();
      return result;
    } catch (e) {
      toastError(e);
      await get().refresh(repo);
      return null;
    } finally {
      set({ busy: false });
    }
  },

  abort: async (repo) => {
    set({ busy: true });
    try {
      const result = await api.gitRebaseAbort(repo);
      set({ session: null, lastOutput: '' });
      notify(result);
      if (result.wipBranch) {
        useToast.getState().show('success', `途中経過を ${result.wipBranch} に退避しました`);
      }
      if ((result.warnings?.length ?? 0) === 0) useToast.getState().show('success', 'リベースを中止しました');
      await useGit.getState().refreshStatus();
      return result;
    } catch (e) {
      toastError(e);
      await get().refresh(repo);
      return null;
    } finally {
      set({ busy: false });
    }
  },

  clearSession: async (repo) => {
    set({ busy: true });
    try {
      await api.gitRebaseSessionClear(repo);
      set({ session: null, lastOutput: '' });
      useToast.getState().show('success', 'リベースセッションを終了しました');
      await useGit.getState().refreshStatus();
    } catch (e) {
      toastError(e);
    } finally {
      set({ busy: false });
    }
  },
}));
