/**
 * Git パネルの表示状態 (選択中コミット・スクロール位置) を sessionStorage に保持する。
 * Git タブは非表示時にアンマウントされるため、タブを戻った際にここから復元する。
 */

const PREFIX = 'git:view:';

export interface GitViewRecord {
  /** 選択中コミットのハッシュ */
  hash: string | null;
  /** 絞り込みグラフ側のスクロール位置 */
  logScrollTop: number;
  /** 全体グラフ側のスクロール位置 */
  graphScrollTop: number;
  /** 「全ブランチ (--all)」チェックボックスの状態 (デフォルト OFF) */
  graphAll: boolean;
  /** コミット差分ファイル一覧のフィルタテキスト */
  filesFilter: string;
  ts: number;
}

export function loadGitView(repo: string): GitViewRecord | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + repo);
    return raw ? (JSON.parse(raw) as GitViewRecord) : null;
  } catch {
    return null;
  }
}

/** 部分更新でマージ保存する */
export function saveGitView(repo: string, partial: Partial<Omit<GitViewRecord, 'ts'>>): void {
  try {
    const prev =
      loadGitView(repo) ?? { hash: null, logScrollTop: 0, graphScrollTop: 0, graphAll: false, filesFilter: '' };
    sessionStorage.setItem(PREFIX + repo, JSON.stringify({ ...prev, ...partial, ts: Date.now() }));
  } catch {
    /* storage full 等は無視 */
  }
}
