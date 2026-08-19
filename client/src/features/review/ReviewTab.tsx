import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useContextMenu, type MenuItem } from '../../components/ContextMenu';
import { confirmDialog } from '../../stores/dialog';
import { useGit } from '../../stores/git';
import { useReview } from '../../stores/review';
import { toastError } from '../../stores/toast';
import { ReviewDetail } from './ReviewDetail';
import { openReviewCreateDialog } from './ReviewCreateDialog';
import { openReviewExportDialog } from './ReviewExportDialog';
import type { Review } from '../../types';
import styles from './Review.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** レビュータブ: URL (?review=<id>) があれば詳細、無ければ一覧 */
export function ReviewTab() {
  const repoRoot = useGit((s) => s.repoRoot);
  const currentId = useReview((s) => s.currentId);
  const detailRepo = useReview((s) => s.detail?.review.repo);

  // 別リポジトリへ移動したら、そのリポジトリのレビュー一覧へ戻す
  useEffect(() => {
    if (repoRoot && detailRepo && detailRepo !== repoRoot) useReview.getState().backToList();
  }, [repoRoot, detailRepo]);

  if (!repoRoot) {
    return <div className={cx('empty-hint')}>Git リポジトリではありません</div>;
  }
  return currentId ? <ReviewDetail id={currentId} /> : <ReviewListView repo={repoRoot} />;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ReviewListView({ repo }: { repo: string }) {
  const list = useReview((s) => s.list);
  const loading = useReview((s) => s.listLoading);
  const [showClosed, setShowClosed] = useState(false);

  useEffect(() => {
    void useReview.getState().loadList(repo).catch(toastError);
  }, [repo]);

  const rows = showClosed ? list : list.filter((r) => r.status === 'open');
  const closedCount = list.filter((r) => r.status === 'closed').length;

  const setStatus = async (r: Review, status: 'open' | 'closed') => {
    try {
      const res = await api.reviewSetStatus(r.id, status);
      useReview.getState().applyReview(res.review);
    } catch (e) {
      toastError(e);
    }
  };

  const remove = async (r: Review) => {
    const ok = await confirmDialog(
      'レビューを削除しますか?',
      `「${r.title}」とコメント ${r.comments} 件を削除します (元に戻せません)`,
      true,
    );
    if (!ok) return;
    try {
      await api.reviewDelete(r.id);
      useReview.getState().removeReview(r.id);
    } catch (e) {
      toastError(e);
    }
  };

  const rowMenu = (e: React.MouseEvent, r: Review) => {
    e.preventDefault();
    const items: MenuItem[] = [
      { label: '開く', action: () => useReview.getState().open(r.id) },
      { label: 'Markdown 出力', action: () => openReviewExportDialog(r.id) },
      { separator: true },
      {
        label: r.status === 'open' ? 'クローズ' : '再オープン',
        action: () => void setStatus(r, r.status === 'open' ? 'closed' : 'open'),
      },
      { label: '削除', danger: true, action: () => void remove(r) },
    ];
    useContextMenu.getState().open(e.clientX, e.clientY, items);
  };

  return (
    <div className={cx('rv-list-view')}>
      <div className={cx('rv-toolbar')}>
        <button className={cx('status-btn on')} onClick={() => openReviewCreateDialog(repo)}>
          ＋ レビュー作成
        </button>
        <button className={cx('status-btn')} onClick={() => void useReview.getState().loadList(repo).catch(toastError)}>
          再読込
        </button>
        <label className={cx('rv-toolbar-check')}>
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          クローズ済みも表示{closedCount > 0 ? ` (${closedCount})` : ''}
        </label>
        <span className={cx('rv-head-spacer')} />
        <span className={cx('rv-count')}>{rows.length} 件</span>
      </div>

      {rows.length === 0 ? (
        <div className={cx('empty-hint')}>
          {loading
            ? '読み込み中…'
            : list.length === 0
              ? 'レビューはまだありません。「＋ レビュー作成」で 2 つのブランチを比較します。'
              : '表示できるレビューはありません (クローズ済みのみ)'}
        </div>
      ) : (
        <div className={cx('rv-table')}>
          <div className={cx('rv-tr rv-th')}>
            <span className={cx('rv-c-status')}>状態</span>
            <span className={cx('rv-c-title')}>レビュー</span>
            <span className={cx('rv-c-branch')}>比較</span>
            <span className={cx('rv-c-num')}>未解決</span>
            <span className={cx('rv-c-num')}>コメント</span>
            <span className={cx('rv-c-date')}>更新</span>
          </div>
          {rows.map((r) => (
            <div
              key={r.id}
              className={cx(`rv-tr${r.status === 'closed' ? ' closed' : ''}`)}
              onClick={() => useReview.getState().open(r.id)}
              onContextMenu={(e) => rowMenu(e, r)}
            >
              <span className={cx('rv-c-status')}>
                <span className={cx(`rv-status ${r.status}`)}>
                  {r.status === 'open' ? 'レビュー中' : r.closedReason === 'branch-deleted' ? 'ブランチ削除' : 'クローズ'}
                </span>
              </span>
              <span className={cx('rv-c-title')} title={r.title}>
                {r.title}
              </span>
              <span className={cx('rv-c-branch')} title={`${r.headBranch} → ${r.baseBranch}`}>
                <code>{r.headBranch}</code> → <code>{r.baseBranch}</code>
              </span>
              <span className={cx('rv-c-num')}>{r.unresolved > 0 ? r.unresolved : '—'}</span>
              <span className={cx('rv-c-num')}>{r.comments}</span>
              <span className={cx('rv-c-date')}>{formatDate(r.updatedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
