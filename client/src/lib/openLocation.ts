import { useExplorer } from '../stores/explorer';
import { useGit } from '../stores/git';
import { useReview } from '../stores/review';
import { pushReviewView, switchView, useUi, type MainView } from '../stores/ui';
import { openInNewTab } from './appTabs';

/** リポジトリ選択時にそのまま保持する最上位タブ。それ以外 (エディタ等) は「ファイル」へ移る */
const REPO_KEEP_VIEWS: readonly MainView[] = ['files', 'commit', 'log', 'branches', 'review'];

/**
 * フォルダ (クイックアクセス・リポジトリ・場所) を開く。サイドバーとコマンドパレットで共通。
 * 通常は「ファイル」タブで開く。keepView を指定すると、現在のタブが REPO_KEEP_VIEWS なら保持する
 * (navigate はビューを files に戻すので、完了後に元のタブへ切り替え直す)。
 * newTab では別タブで開く。
 */
export function openLocation(target: string, { keepView = false, newTab = false } = {}): void {
  const current = useUi.getState().view;
  const view: MainView = keepView && REPO_KEEP_VIEWS.includes(current) ? current : 'files';
  if (newTab) {
    const params = new URLSearchParams();
    params.set('path', target);
    if (view !== 'files') params.set('view', view);
    openInNewTab(`${location.pathname}?${params}`);
    return;
  }
  const sameRepo = useGit.getState().repoRoot === target;
  void useExplorer.getState().navigate(target).then(() => {
    if (view === 'review') {
      // 同じリポジトリなら開いていたレビュー詳細を URL ごと保持、別リポジトリなら一覧へ
      const { currentId, currentFile } = useReview.getState();
      pushReviewView(sameRepo ? currentId : null, sameRepo ? currentFile : null);
    } else {
      switchView(view);
    }
  });
}
