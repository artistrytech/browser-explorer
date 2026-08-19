/**
 * レビュー詳細の表示状態 (選択中ファイル・絞り込み・スクロール位置) を sessionStorage に保持する。
 * レビュータブは非表示時にアンマウントされるため、別タブから戻った際にここから復元する。
 * (コメント・確認済みなど「内容」は DB 側に持つ → server/services/reviewStore.ts)
 */

const PREFIX = 'review:view:';

export interface ReviewViewRecord {
  /** 選択中ファイル (変更後パス) */
  path: string | null;
  /** ファイル一覧の絞り込みテキスト */
  filter: string;
  /** ファイル一覧のスクロール位置 */
  listScrollTop: number;
  /** 差分ペインのスクロール位置 */
  diffScrollTop: number;
  ts: number;
}

const EMPTY: Omit<ReviewViewRecord, 'ts'> = {
  path: null,
  filter: '',
  listScrollTop: 0,
  diffScrollTop: 0,
};

export function loadReviewView(id: number): ReviewViewRecord | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + id);
    return raw ? (JSON.parse(raw) as ReviewViewRecord) : null;
  } catch {
    return null;
  }
}

/** 部分更新でマージ保存する */
export function saveReviewView(id: number, partial: Partial<Omit<ReviewViewRecord, 'ts'>>): void {
  try {
    const prev = loadReviewView(id) ?? EMPTY;
    sessionStorage.setItem(PREFIX + id, JSON.stringify({ ...prev, ...partial, ts: Date.now() }));
  } catch {
    /* storage full 等は無視 */
  }
}

export function clearReviewView(id: number): void {
  try {
    sessionStorage.removeItem(PREFIX + id);
  } catch {
    /* 無視 */
  }
}
