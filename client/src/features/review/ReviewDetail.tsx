import { useEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { api } from '../../api/client';
import { confirmDialog, promptDialog } from '../../stores/dialog';
import { unresolvedByPath, useReview } from '../../stores/review';
import { toastError, useToast } from '../../stores/toast';
import { loadReviewView, saveReviewView } from '../../lib/reviewViewMemory';
import { baseName, parentPath } from '../../lib/paths';
import { ReviewFileDiff } from './ReviewFileDiff';
import { openReviewExportDialog } from './ReviewExportDialog';
import type { CommitFile } from '../../types';
import styles from './Review.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

const STATUS_LABEL: Record<string, string> = {
  A: '追加',
  M: '変更',
  D: '削除',
  R: '名前変更',
  C: 'コピー',
  T: '種別変更',
};

/** レビュー詳細: 左に変更ファイル一覧、右にその差分 (GitHub の PR と同じ構成) */
export function ReviewDetail({ id }: { id: number }) {
  const detail = useReview((s) => s.detail);
  const loading = useReview((s) => s.detailLoading);
  const [filter, setFilter] = useState(() => loadReviewView(id)?.filter ?? '');
  const [selected, setSelected] = useState<string | null>(() => loadReviewView(id)?.path ?? null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void useReview.getState().loadDetail(id).catch(toastError);
  }, [id]);

  useEffect(() => {
    if (detail) setSummary(detail.review.summary);
  }, [detail?.review.id, detail?.review.summary]);

  const files = detail?.files ?? [];
  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return files;
    // 名前変更は変更前のパスでもヒットさせる
    return files.filter(
      (x) => x.path.toLowerCase().includes(f) || (x.oldPath ?? '').toLowerCase().includes(f),
    );
  }, [files, filter]);

  // 選択中のファイルが一覧から消えたら先頭を選び直す
  useEffect(() => {
    if (filtered.length === 0) return;
    if (!selected || !filtered.some((f) => f.path === selected)) {
      setSelected(filtered[0].path);
      saveReviewView(id, { path: filtered[0].path });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, selected]);

  // 別タブから戻った際のスクロール位置復元 (差分の読み込み後に効かせる)
  useEffect(() => {
    const saved = loadReviewView(id);
    if (!saved) return;
    if (listRef.current) listRef.current.scrollTop = saved.listScrollTop;
    if (diffRef.current) diffRef.current.scrollTop = saved.diffScrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.review.id]);

  if (!detail) {
    return (
      <div className={cx('empty-hint')}>
        <div>{loading ? '読み込み中…' : 'レビューが見つかりません (削除された可能性があります)'}</div>
        {!loading && (
          <button className={cx('status-btn')} onClick={() => useReview.getState().backToList()}>
            ← 一覧
          </button>
        )}
      </div>
    );
  }

  const { review, comments, viewed, available, headExists, newCommits } = detail;
  const readOnly = review.status === 'closed';
  const unresolved = unresolvedByPath(comments);
  const viewedSet = new Set(viewed);
  const current = files.find((f) => f.path === selected) ?? null;

  const selectFile = (f: CommitFile) => {
    setSelected(f.path);
    saveReviewView(id, { path: f.path, diffScrollTop: 0 });
    if (diffRef.current) diffRef.current.scrollTop = 0;
  };

  const changeFilter = (v: string) => {
    setFilter(v);
    saveReviewView(id, { filter: v });
  };

  const toggleViewed = async (f: CommitFile, next: boolean) => {
    useReview.getState().setViewedLocal(f.path, next);
    try {
      await api.reviewSetViewed(id, f.path, next);
    } catch (e) {
      useReview.getState().setViewedLocal(f.path, !next);
      toastError(e);
    }
  };

  const rename = async () => {
    const title = await promptDialog('レビュー名', review.title);
    if (title === null) return;
    try {
      const r = await api.reviewUpdate(id, { title });
      useReview.getState().applyReview(r.review);
    } catch (e) {
      toastError(e);
    }
  };

  const saveSummary = async () => {
    if (summary === review.summary) return;
    try {
      const r = await api.reviewUpdate(id, { summary });
      useReview.getState().applyReview(r.review);
    } catch (e) {
      toastError(e);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await api.reviewRefresh(id);
      useReview.getState().applyReview(r.review);
      await useReview.getState().loadDetail(id, { silent: true });
      useToast
        .getState()
        .show(
          'success',
          r.changed.length === 0
            ? '最新の状態です'
            : `${r.changed.length} ファイルの差分を更新しました (位置ずれの可能性があるコメント: ${r.outdated} 件)`,
        );
    } catch (e) {
      toastError(e);
    } finally {
      setRefreshing(false);
    }
  };

  const setStatus = async (status: 'open' | 'closed') => {
    try {
      const r = await api.reviewSetStatus(id, status);
      useReview.getState().applyReview(r.review);
    } catch (e) {
      toastError(e);
    }
  };

  const remove = async () => {
    const ok = await confirmDialog(
      'レビューを削除しますか?',
      `「${review.title}」とコメント ${review.comments} 件を削除します (元に戻せません)`,
      true,
    );
    if (!ok) return;
    try {
      await api.reviewDelete(id);
      useReview.getState().removeReview(id);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className={cx('rv-detail')}>
      <div className={cx('rv-head')}>
        <button className={cx('status-btn')} onClick={() => useReview.getState().backToList()}>
          ← 一覧
        </button>
        <span className={cx(`rv-status ${review.status}`)}>
          {review.status === 'open' ? 'レビュー中' : 'クローズ'}
        </span>
        <span className={cx('rv-title')} title={review.title} onDoubleClick={() => void rename()}>
          {review.title}
        </span>
        <span className={cx('rv-branches')}>
          <code>{review.headBranch}</code> → <code>{review.baseBranch}</code>
          <span className={cx('rv-hashes')}>
            {review.baseCommit.slice(0, 7)} … {review.headCommit.slice(0, 7)}
          </span>
        </span>
        <span className={cx('rv-head-spacer')} />
        <button className={cx('status-btn')} onClick={() => setSummaryOpen((v) => !v)}>
          概要
        </button>
        <button className={cx('status-btn')} onClick={() => openReviewExportDialog(id)}>
          Markdown 出力
        </button>
        <button className={cx('status-btn')} onClick={() => void rename()}>
          名前変更
        </button>
        <button
          className={cx('status-btn')}
          onClick={() => void setStatus(review.status === 'open' ? 'closed' : 'open')}
        >
          {review.status === 'open' ? 'クローズ' : '再オープン'}
        </button>
        <button className={cx('status-btn danger')} onClick={() => void remove()}>
          削除
        </button>
      </div>

      {summaryOpen && (
        <div className={cx('rv-summary')}>
          <textarea
            className={cx('rv-textarea')}
            value={summary}
            placeholder="レビュー全体のメモ (Markdown 出力の冒頭に入ります)"
            onChange={(e) => setSummary(e.target.value)}
            onBlur={() => void saveSummary()}
          />
        </div>
      )}

      {!available && (
        <div className={cx('rv-banner warn')}>
          差分を表示できません (リポジトリまたは対象コミットが失われています)。コメントは閲覧・出力できます。
        </div>
      )}
      {!headExists && review.closedReason === 'branch-deleted' && (
        <div className={cx('rv-banner')}>
          対象ブランチ <code>{review.headBranch}</code> が削除されたため、このレビューはクローズされました。
        </div>
      )}
      {newCommits > 0 && (
        <div className={cx('rv-banner')}>
          <span>
            <code>{review.headBranch}</code> に新しいコミットが {newCommits} 件あります。
            更新すると、差分が変わったファイルのコメントは「位置ずれの可能性」として扱われます。
          </span>
          <button className={cx('status-btn on')} disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? '更新中…' : '最新に更新'}
          </button>
        </div>
      )}

      <PanelGroup direction="horizontal" className={cx('rv-split')} autoSaveId="review-detail">
        <Panel defaultSize={24} minSize={14}>
          <div className={cx('rv-files')}>
            <div className={cx('rv-files-head')}>
              <input
                className={cx('rv-filter')}
                value={filter}
                placeholder="パスで絞り込み"
                onChange={(e) => changeFilter(e.target.value)}
              />
              <span className={cx('rv-count')}>
                {filtered.length}/{files.length}
              </span>
            </div>
            <div
              className={cx('rv-file-list')}
              ref={listRef}
              onScroll={(e) => saveReviewView(id, { listScrollTop: e.currentTarget.scrollTop })}
            >
              {filtered.length === 0 ? (
                <div className={cx('empty-hint')}>
                  {files.length === 0 ? '変更されたファイルはありません' : '一致するファイルはありません'}
                </div>
              ) : (
                filtered.map((f) => {
                  const n = unresolved.get(f.path) ?? 0;
                  const dir = parentPath(f.path);
                  return (
                    <div
                      key={f.path}
                      className={cx(
                        `rv-file${f.path === selected ? ' selected' : ''}${viewedSet.has(f.path) ? ' viewed' : ''}`,
                      )}
                      onClick={() => selectFile(f)}
                      title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                    >
                      <input
                        type="checkbox"
                        className={cx('rv-viewed')}
                        checked={viewedSet.has(f.path)}
                        title="確認済み"
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => void toggleViewed(f, e.target.checked)}
                      />
                      <span className={cx(`rv-st st-${f.status}`)} title={STATUS_LABEL[f.status] ?? f.status}>
                        {f.status}
                      </span>
                      <span className={cx('rv-file-name')}>
                        {baseName(f.path)}
                        {dir && dir !== f.path && <span className={cx('rv-file-dir')}>{dir}</span>}
                      </span>
                      {n > 0 && <span className={cx('rv-file-comments')}>{n}</span>}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </Panel>
        <PanelResizeHandle className={cx('rv-resize')} />
        <Panel>
          <div
            className={cx('rv-diff-host')}
            ref={diffRef}
            onScroll={(e) => saveReviewView(id, { diffScrollTop: e.currentTarget.scrollTop })}
          >
            {!available ? (
              <div className={cx('empty-hint')}>差分を表示できません</div>
            ) : current ? (
              <ReviewFileDiff
                reviewId={id}
                file={current}
                comments={comments.filter((c) => c.path === current.path)}
                readOnly={readOnly}
                baseCommit={review.baseCommit}
                headCommit={review.headCommit}
              />
            ) : (
              <div className={cx('empty-hint')}>ファイルを選択してください</div>
            )}
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
