import { create } from 'zustand';
import { api } from '../api/client';
import { pushReviewView, reviewFileFromUrl, reviewIdFromUrl } from './ui';
import { clearReviewView, loadReviewView, saveReviewView } from '../lib/reviewViewMemory';
import type { Review, ReviewComment, ReviewDetail } from '../types';

/**
 * レビュータブの状態。
 * 「一覧」と「詳細」は URL (?view=review&review=<id>) で表現し、
 * ブラウザバックで詳細 → 一覧 → 前のタブと戻れるようにする。
 * 詳細で選択中のファイルも URL (&rfile=<path>) に含め、戻る/進むでファイル間を移動できるようにする。
 */
interface ReviewStore {
  /** 表示中のレビュー ID。null なら一覧 */
  currentId: number | null;
  /** 詳細で選択中のファイル (変更後パス)。null なら未選択 (先頭を自動選択する) */
  currentFile: string | null;
  list: Review[];
  /** list がどのリポジトリのものか (別リポジトリへ切り替えたら前の一覧を見せないため) */
  listRepo: string | null;
  listLoading: boolean;
  detail: ReviewDetail | null;
  detailLoading: boolean;
  loadList: (repo: string) => Promise<void>;
  loadDetail: (id: number, opts?: { silent?: boolean }) => Promise<void>;
  /** 詳細を開く (履歴に積む)。前回選択していたファイルがあればそれを開く */
  open: (id: number) => void;
  /**
   * 詳細でファイルを選ぶ (履歴に積む)。
   * replace=true はユーザー操作でない自動選択用で、現在の履歴エントリを差し替える。
   */
  selectFile: (path: string, replace?: boolean) => void;
  /** 一覧へ戻る (履歴に積む) */
  backToList: () => void;
  /** popstate: URL から表示対象を復元する */
  syncFromUrl: () => void;
  /** 詳細のコメント配列を差し替える (追加・更新・削除の反映) */
  applyComment: (comment: ReviewComment) => void;
  removeComment: (commentId: number) => void;
  setViewedLocal: (path: string, viewed: boolean) => void;
  /** レビュー本体 (タイトル・概要・状態) の更新を一覧と詳細の両方へ反映 */
  applyReview: (review: Review) => void;
  removeReview: (id: number) => void;
}

/** 初期表示: URL に選択ファイルが無ければ、前回の表示状態 (sessionStorage) から引き継ぐ */
function initialFile(id: number | null): string | null {
  return reviewFileFromUrl() ?? (id !== null ? (loadReviewView(id)?.path ?? null) : null);
}

export const useReview = create<ReviewStore>((set, get) => ({
  currentId: reviewIdFromUrl(),
  currentFile: initialFile(reviewIdFromUrl()),
  list: [],
  listRepo: null,
  listLoading: false,
  detail: null,
  detailLoading: false,

  loadList: async (repo) => {
    // 別リポジトリの一覧は先に消して「読み込み中…」にする (同じリポジトリの再読込は表示を維持)
    set({ listLoading: true, listRepo: repo, ...(get().listRepo !== repo ? { list: [] } : {}) });
    try {
      const { reviews } = await api.reviewList(repo);
      // 待っている間に別リポジトリの読み込みが始まっていたら、この結果は捨てる
      if (get().listRepo !== repo) return;
      set({ list: reviews });
    } finally {
      if (get().listRepo === repo) set({ listLoading: false });
    }
  },

  loadDetail: async (id, { silent = false } = {}) => {
    if (!silent) set({ detailLoading: true });
    try {
      const detail = await api.reviewDetail(id);
      // 読み込み中に別のレビューへ切り替わっていたら破棄する
      if (get().currentId === id) set({ detail });
    } finally {
      set({ detailLoading: false });
    }
  },

  open: (id) => {
    const file = loadReviewView(id)?.path ?? null;
    set({ currentId: id, currentFile: file, detail: null });
    pushReviewView(id, file);
  },

  selectFile: (path, replace = false) => {
    const id = get().currentId;
    if (id === null) return;
    set({ currentFile: path });
    saveReviewView(id, { path });
    pushReviewView(id, path, replace);
  },

  backToList: () => {
    set({ currentId: null, currentFile: null, detail: null });
    pushReviewView(null);
  },

  syncFromUrl: () => {
    const id = reviewIdFromUrl();
    const file = reviewFileFromUrl();
    if (id !== get().currentId) set({ currentId: id, currentFile: file, detail: null });
    else if (file !== get().currentFile) set({ currentFile: file });
  },

  applyComment: (comment) => {
    const detail = get().detail;
    if (!detail) return;
    const exists = detail.comments.some((c) => c.id === comment.id);
    const comments = exists
      ? detail.comments.map((c) => (c.id === comment.id ? comment : c))
      : [...detail.comments, comment];
    set({ detail: { ...detail, comments } });
  },

  removeComment: (commentId) => {
    const detail = get().detail;
    if (!detail) return;
    set({ detail: { ...detail, comments: detail.comments.filter((c) => c.id !== commentId) } });
  },

  setViewedLocal: (path, viewed) => {
    const detail = get().detail;
    if (!detail) return;
    const next = viewed
      ? [...new Set([...detail.viewed, path])]
      : detail.viewed.filter((p) => p !== path);
    set({ detail: { ...detail, viewed: next } });
  },

  applyReview: (review) => {
    const detail = get().detail;
    set({
      list: get().list.map((r) => (r.id === review.id ? review : r)),
      detail: detail && detail.review.id === review.id ? { ...detail, review } : detail,
    });
  },

  removeReview: (id) => {
    clearReviewView(id);
    set({ list: get().list.filter((r) => r.id !== id) });
    if (get().currentId === id) {
      set({ currentId: null, currentFile: null, detail: null });
      pushReviewView(null);
    }
  },
}));

/** 未解決コメント数 (outdated は除く) をファイル単位で数える */
export function unresolvedByPath(comments: ReviewComment[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const c of comments) {
    if (c.resolved || c.outdated) continue;
    map.set(c.path, (map.get(c.path) ?? 0) + 1);
  }
  return map;
}
