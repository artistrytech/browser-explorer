import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { toastError } from '../../stores/toast';
import type { CommitFilesResult } from '../../types';
import { CommitFileDiff, commitFileLabel } from './CommitFileDiff';
import styles from './StashDetailDialog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * Stash の詳細ダイアログ (Stash ダイアログの一覧をダブルクリックで開く)。
 * 左に基本情報と差分ファイル一覧、右に選択行の差分を表示する。
 * 「復元」を押すと 'restore' を返し、呼び出し元 (StashDialog) がそのまま復元を実行して閉じる。
 *
 * stash は「退避時点のコミット」なので、差分の取得はコミット用の API
 * (commit-files / commit-file-patch = 第 1 親との差分) をそのまま流用できる。
 * ※ -u で退避した未追跡ファイルは第 3 親に入るため、この一覧には出ない。
 */

/** ダイアログに渡す一覧行 (StashDialog の StashEntry と同じ形) */
export interface StashDetailEntry {
  ref: string;
  date: string;
  message: string;
}

/** 差分ファイルのステータス表示 (A/M/D/T/R/C) */
const FILE_STATUS: Record<string, { label: string; cls: string }> = {
  A: { label: '追加', cls: 'st-add' },
  M: { label: '修正', cls: 'st-mod' },
  D: { label: '削除', cls: 'st-del' },
  T: { label: '種別変更', cls: 'st-mod' },
  R: { label: '名前変更', cls: 'st-mod' },
  C: { label: 'コピー', cls: 'st-add' },
};

interface Store {
  open: boolean;
  repo: string;
  entry: StashDetailEntry | null;
  resolve: ((v: 'restore' | null) => void) | null;
  show: (repo: string, entry: StashDetailEntry, resolve: (v: 'restore' | null) => void) => void;
  close: () => void;
}

const useStore = create<Store>((set) => ({
  open: false,
  repo: '',
  entry: null,
  resolve: null,
  show: (repo, entry, resolve) => set({ open: true, repo, entry, resolve }),
  close: () => set({ open: false, entry: null, resolve: null }),
}));

export function openStashDetail(repo: string, entry: StashDetailEntry): Promise<'restore' | null> {
  return new Promise((resolve) => useStore.getState().show(repo, entry, resolve));
}

/** "WIP on main: 1234abc 件名" / "On main: メモ" から元ブランチ名を取り出す */
function stashBranch(message: string): string | null {
  return message.match(/^(?:WIP on|On) ([^:]+):/)?.[1] ?? null;
}

export function StashDetailDialog() {
  const { open, repo, entry, resolve, close } = useStore();
  const [detail, setDetail] = useState<CommitFilesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const ref = entry?.ref ?? '';

  const finish = (v: 'restore' | null) => {
    resolve?.(v);
    close();
  };

  useEffect(() => {
    if (!open || !repo || !ref) return;
    let stale = false;
    setLoading(true);
    setDetail(null);
    setSelectedPath(null);
    api
      .gitCommitFiles(repo, ref)
      .then((r) => {
        if (stale) return;
        setDetail(r);
        setSelectedPath(r.files[0]?.path ?? null); // 先頭行を選択して右に差分を出す
      })
      .catch((e) => {
        if (!stale) toastError(e);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [open, repo, ref]);

  // 一覧が出たらフォーカスを移し、そのまま ↑↓ で行を選べるようにする
  useEffect(() => {
    if (open && detail) listRef.current?.focus();
  }, [open, detail]);

  // 開いている間は Escape で閉じられるようにする
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, resolve]);

  if (!open || !entry) return null;

  const files = detail?.files ?? [];
  const selectedFile = files.find((f) => f.path === selectedPath) ?? null;

  /** ↑↓ で選択行を移動する (移動先が隠れていればスクロールして見せる) */
  const moveSelection = (delta: number) => {
    if (files.length === 0) return;
    const idx = files.findIndex((f) => f.path === selectedPath);
    const next = idx < 0 ? 0 : Math.min(files.length - 1, Math.max(0, idx + delta));
    const path = files[next].path;
    setSelectedPath(path);
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector(`[data-path="${CSS.escape(path)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
  };

  const listKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    }
  };

  const branch = stashBranch(entry.message);

  return (
    <div className={cx("dialog-backdrop nested")} onMouseDown={() => finish(null)}>
      <div className={cx("dialog stash-detail-dialog")} onMouseDown={(e) => e.stopPropagation()}>
        <div className={cx("dialog-title")}>Stash の詳細 — {entry.ref}</div>

        <div className={cx("sd-body")}>
          <div className={cx("sd-left")}>
            <dl className={cx("sd-info")}>
              <dt>メッセージ</dt>
              <dd className={cx("sd-info-msg")}>{entry.message || '(メッセージなし)'}</dd>
              <dt>退避日時</dt>
              <dd>{detail?.date || entry.date}</dd>
              {branch && (
                <>
                  <dt>元ブランチ</dt>
                  <dd>{branch}</dd>
                </>
              )}
              {detail && (
                <>
                  <dt>作成者</dt>
                  <dd>{detail.author}</dd>
                  <dt>コミット</dt>
                  <dd className={cx("sd-mono")}>{detail.hash.slice(0, 12)}</dd>
                </>
              )}
            </dl>

            <div className={cx("sd-list-head")}>
              変更ファイル{detail ? ` (${files.length})` : ''}
            </div>
            {loading ? (
              <div className={cx("empty-hint")}>読み込み中…</div>
            ) : files.length === 0 ? (
              <div className={cx("empty-hint")}>変更ファイルはありません</div>
            ) : (
              <div
                className={cx("sd-files")}
                ref={listRef}
                tabIndex={0}
                onKeyDown={listKeyDown}
              >
                <table className={cx("sd-file-table")}>
                  <thead>
                    <tr>
                      <th>ステータス</th>
                      <th>ファイル</th>
                      <th className={cx("num")}>追加</th>
                      <th className={cx("num")}>削除</th>
                    </tr>
                  </thead>
                  <tbody>
                    {files.map((f) => {
                      const st = FILE_STATUS[f.status] ?? { label: f.status, cls: 'st-mod' };
                      const label = commitFileLabel(f);
                      return (
                        <tr
                          key={f.path}
                          data-path={f.path}
                          className={cx(selectedPath === f.path ? 'selected' : '')}
                          title={label}
                          onClick={() => setSelectedPath(f.path)}
                        >
                          <td className={cx(`sd-status ${st.cls}`)}>{st.label}</td>
                          <td className={cx("sd-path")}>{label}</td>
                          <td className={cx("num sd-added")}>{f.binary ? '–' : `+${f.added ?? 0}`}</td>
                          <td className={cx("num sd-deleted")}>{f.binary ? '–' : `−${f.deleted ?? 0}`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className={cx("sd-right")}>
            {selectedFile ? (
              <CommitFileDiff
                repo={repo}
                hash={entry.ref}
                path={selectedFile.path}
                oldPath={selectedFile.oldPath}
                label={entry.ref}
              />
            ) : (
              <div className={cx("empty-hint")}>ファイルを選択すると差分を表示します</div>
            )}
          </div>
        </div>

        <div className={cx("dialog-buttons")}>
          <button className={cx("btn")} onClick={() => finish(null)}>
            閉じる
          </button>
          <button className={cx("btn primary")} onClick={() => finish('restore')}>
            復元
          </button>
        </div>
      </div>
    </div>
  );
}
