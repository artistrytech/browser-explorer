import { create } from 'zustand';
import { api } from '../api/client';
import { pushReviewView, reviewIdFromUrl } from './ui';
import { clearReviewView } from '../lib/reviewViewMemory';
import type { Review, ReviewComment, ReviewDetail } from '../types';

/**
 * レビュータブの状態。
 * 「一覧」と「詳細」は URL (?view=review&review=<id>) で表現し、
 * ブラウザバックで詳細 → 一覧 → 前のタブと戻れるようにする。
 */
interface ReviewStore {
  /** 表示中のレビュー ID。null なら一覧 */
  currentId: number | null;
  list: Review[];
  listLoading: boolean;
  detail: ReviewDetail | null;
  detailLoading: boolean;
  loadList: (repo: string) => Promise<void>;
  loadDetail: (id: number, opts?: { silent?: boolean }) => Promise<void>;
  /** 詳細を開く (履歴に積む) */
  open: (id: number) => void;
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

export const useReview = create<ReviewStore>((set, get) => ({
  currentId: reviewIdFromUrl(),
  list: [],
  listLoading: false,
  detail: null,
  detailLoading: false,

  loadList: async (repo) => {
    set({ listLoading: true });
    try {
      const { reviews } = await api.reviewList(repo);
      set({ list: reviews });
    } finally {
      set({ listLoading: false });
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
    set({ currentId: id, detail: null });
    pushReviewView(id);
  },

  backToList: () => {
    set({ currentId: null, detail: null });
    pushReviewView(null);
  },

  syncFromUrl: () => {
    const id = reviewIdFromUrl();
    if (id !== get().currentId) set({ currentId: id, detail: null });
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
      set({ currentId: null, detail: null });
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
