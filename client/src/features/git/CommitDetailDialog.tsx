import { Fragment, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { toastError } from '../../stores/toast';
import type { CommitFilesResult } from '../../types';
import { CommitFileDiff, commitFileLabel } from './CommitFileDiff';
import styles from './CommitDetailDialog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * コミットの詳細ダイアログ:
 * 左に基本情報と差分ファイル一覧、右に選択行の差分を表示する。
 * ログ/ブランチタブのコミット行のダブルクリックと、Stash 一覧の行から開く。
 *
 * stash は「退避時点のコミット」なので、差分の取得はコミット用の API
 * (commit-files / commit-file-patch = 第 1 親との差分) をそのまま流用できる。
 * ※ -u で退避した未追跡ファイルは第 3 親に入るため、この一覧には出ない。
 */

/** 呼び出し元ごとの見出し・情報欄・ボタンの差分 */
export interface CommitDetailOptions {
  /** 見出し (既定: 「コミットの詳細 — <ref>」) */
  title?: string;
  /** 「メッセージ」欄に出す文字列 (既定: 取得したコミットメッセージ) */
  message?: string;
  /** 日時欄のラベル (既定: 「日時」) */
  dateLabel?: string;
  /** 取得前に出しておく日時 (一覧が持っている値。取得できたらそちらを優先する) */
  date?: string;
  /** 情報欄に追加する行 (値が空の行は出さない) */
  rows?: { label: string; value: string }[];
  /** 主ボタンのラベル。押すと Promise が 'action' で解決する (省略時は「閉じる」のみ) */
  actionLabel?: string;
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
  /** 表示対象 (コミットハッシュ / stash@{n} などの rev) */
  target: string;
  options: CommitDetailOptions;
  resolve: ((v: 'action' | null) => void) | null;
  show: (
    repo: string,
    target: string,
    options: CommitDetailOptions,
    resolve: (v: 'action' | null) => void,
  ) => void;
  close: () => void;
}

const useStore = create<Store>((set) => ({
  open: false,
  repo: '',
  target: '',
  options: {},
  resolve: null,
  show: (repo, target, options, resolve) => set({ open: true, repo, target, options, resolve }),
  close: () => set({ open: false, target: '', resolve: null }),
}));

/** 詳細を開く。主ボタン (actionLabel) が押されたら 'action'、閉じたら null で解決する */
export function openCommitDetail(
  repo: string,
  target: string,
  options: CommitDetailOptions = {},
): Promise<'action' | null> {
  return new Promise((resolve) => useStore.getState().show(repo, target, options, resolve));
}

export function CommitDetailDialog() {
  const { open, repo, target, options, resolve, close } = useStore();
  const [detail, setDetail] = useState<CommitFilesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const finish = (v: 'action' | null) => {
    resolve?.(v);
    close();
  };

  useEffect(() => {
    if (!open || !repo || !target) return;
    let stale = false;
    setLoading(true);
    setDetail(null);
    setSelectedPath(null);
    setFilter('');
    api
      .gitCommitFiles(repo, target)
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
  }, [open, repo, target]);

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

  if (!open) return null;

  const allFiles = detail?.files ?? [];
  // パス部分一致で絞り込む (名前変更は変更前のパスでも引っかかるよう表示ラベルで判定)
  const matches = (f: (typeof allFiles)[number], text: string) =>
    commitFileLabel(f).toLowerCase().includes(text);
  const filterText = filter.trim().toLowerCase();
  const files = filterText ? allFiles.filter((f) => matches(f, filterText)) : allFiles;
  const selectedFile = files.find((f) => f.path === selectedPath) ?? null;
  // 情報欄の「メッセージ」。呼び出し元の指定 (stash の一覧行など) を優先する
  const message = options.message ?? detail?.message ?? '';
  // 差分ヘッダの見出し: 生のハッシュは CommitFileDiff の既定 (先頭 7 桁) に任せ、
  // stash@{n} のような記号的な rev はそのまま出す
  const diffLabel = /^[0-9a-f]{40}$/i.test(target) ? undefined : target;

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

  const changeFilter = (v: string) => {
    setFilter(v);
    // 選択行が絞り込みで消えたら先頭を選び直し、右ペインを空のままにしない
    const text = v.trim().toLowerCase();
    const next = text ? allFiles.filter((f) => matches(f, text)) : allFiles;
    if (!next.some((f) => f.path === selectedPath)) setSelectedPath(next[0]?.path ?? null);
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

  return (
    <div className={cx("dialog-backdrop nested")} onMouseDown={() => finish(null)}>
      <div className={cx("dialog commit-detail-dialog")} onMouseDown={(e) => e.stopPropagation()}>
        <div className={cx("dialog-title")}>{options.title ?? `コミットの詳細 — ${target}`}</div>

        <div className={cx("sd-body")}>
          <div className={cx("sd-left")}>
            <dl className={cx("sd-info")}>
              <dt>メッセージ</dt>
              <dd className={cx("sd-info-msg")}>{message || '(メッセージなし)'}</dd>
              <dt>{options.dateLabel ?? '日時'}</dt>
              <dd>{detail?.date || options.date || ''}</dd>
              {/* dl は grid なので dt/dd を直接の子に置く (Fragment で挟む) */}
              {(options.rows ?? [])
                .filter((r) => r.value)
                .map((r) => (
                  <Fragment key={r.label}>
                    <dt>{r.label}</dt>
                    <dd>{r.value}</dd>
                  </Fragment>
                ))}
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
              <span>変更ファイル</span>
              <input
                className={cx("sd-filter")}
                type="text"
                placeholder="パスで絞り込み (部分一致)"
                value={filter}
                onChange={(e) => changeFilter(e.target.value)}
              />
              {detail && (
                <span className={cx("sd-count")}>
                  {files.length}/{allFiles.length} 件
                </span>
              )}
            </div>
            {loading ? (
              <div className={cx("empty-hint")}>読み込み中…</div>
            ) : allFiles.length === 0 ? (
              <div className={cx("empty-hint")}>変更ファイルはありません</div>
            ) : files.length === 0 ? (
              <div className={cx("empty-hint")}>絞り込みに一致するファイルがありません</div>
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
                hash={target}
                path={selectedFile.path}
                oldPath={selectedFile.oldPath}
                label={diffLabel}
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
          {options.actionLabel && (
            <button className={cx("btn primary")} onClick={() => finish('action')}>
              {options.actionLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
