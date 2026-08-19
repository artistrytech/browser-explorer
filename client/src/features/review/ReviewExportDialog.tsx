import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { toastError, useToast } from '../../stores/toast';
import styles from './Review.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

interface ExportDialogStore {
  open: boolean;
  id: number;
  show: (id: number) => void;
  close: () => void;
}

const useExportDialog = create<ExportDialogStore>((set) => ({
  open: false,
  id: 0,
  show: (id) => set({ open: true, id }),
  close: () => set({ open: false }),
}));

export function openReviewExportDialog(id: number): void {
  useExportDialog.getState().show(id);
}

/**
 * レビュー結果の Markdown 出力。
 * 出力対象は未解決のコメントのみ (解決済み・位置ずれの可能性があるものは除く)。
 */
export function ReviewExportDialog() {
  const { open, id, close } = useExportDialog();
  const [markdown, setMarkdown] = useState('');
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setMarkdown('');
    api
      .reviewExport(id)
      .then((r) => {
        setMarkdown(r.markdown);
        setCount(r.count);
      })
      .catch(toastError)
      .finally(() => setLoading(false));
  }, [open, id]);

  if (!open) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      useToast.getState().show('success', 'Markdown をコピーしました');
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className={cx('dialog-backdrop')} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={cx('dialog rv-export')}>
        <div className={cx('dialog-title')}>レビュー結果 (Markdown)</div>
        <div className={cx('rv-note')}>
          未解決のコメント {count} 件を出力します (解決済み・位置ずれの可能性があるコメントは含みません)。
        </div>
        <textarea className={cx('rv-export-text')} readOnly value={loading ? '読み込み中…' : markdown} />
        <div className={cx('dialog-buttons')}>
          <button className={cx('btn')} onClick={close}>
            閉じる
          </button>
          <button className={cx('btn primary')} disabled={loading || !markdown} onClick={() => void copy()}>
            クリップボードにコピー
          </button>
        </div>
      </div>
    </div>
  );
}
