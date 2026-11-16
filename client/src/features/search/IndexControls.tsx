import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { confirmDialog } from '../../stores/dialog';
import { DEFAULT_INDEX_SETTINGS, useIndexStatus, useSearchIndex } from '../../stores/searchIndex';
import { useDialogKeys } from '../../lib/dialogKeys';
import { baseName, formatSize } from '../../lib/paths';
import type { IndexSettings, IndexStatus } from '../../types';
import styles from './Search.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * 検索インデックスの状態表示 (左パネルの検索の上部) と、有効化・設定のダイアログ。
 * インデックスは利用者が有効にした Git リポジトリ (ルート) だけで作る。
 */

interface IndexDialogStore {
  repo: string | null;
  show: (repo: string) => void;
  close: () => void;
}

const useIndexDialog = create<IndexDialogStore>((set) => ({
  repo: null,
  show: (repo) => set({ repo }),
  close: () => set({ repo: null }),
}));

export function openIndexDialog(repo: string): void {
  useIndexDialog.getState().show(repo);
}

/** 無効にする (確認してからインデックスを消す) */
export async function disableIndexWithConfirm(repo: string): Promise<boolean> {
  const ok = await confirmDialog(
    'インデックスを無効にする',
    `${baseName(repo)} の検索インデックスを削除し、通常の名前検索に戻します。よろしいですか?`,
    true,
  );
  if (!ok) return false;
  return useSearchIndex.getState().disable(repo);
}

function formatCount(n: number): string {
  return n.toLocaleString('ja-JP');
}

function stateText(st: IndexStatus): string {
  if (st.state === 'building') {
    const p = st.progress;
    return p && p.total > 0 ? `作成中… ${formatCount(p.done)} / ${formatCount(p.total)}` : '作成中… (ファイルを列挙しています)';
  }
  if (st.state === 'error') return `エラー: ${st.error ?? '不明なエラー'}`;
  return `${formatCount(st.files)} ファイル`;
}

/** 左パネルの検索の上部: インデックスの状態と、有効 / 無効の切り替え・設定 */
export function IndexStatusBar({ repo }: { repo: string }) {
  const st = useIndexStatus(repo);
  const enabled = st?.enabled === true;
  const progress = st?.state === 'building' && st.progress && st.progress.total > 0 ? st.progress : null;

  const toggle = () => {
    if (enabled) void disableIndexWithConfirm(repo);
    else openIndexDialog(repo);
  };

  const title = enabled && st
    ? [
        `インデックス: ${repo}`,
        `ファイル: ${formatCount(st.files)} (内容あり ${formatCount(st.contentFiles)})`,
        `サイズ: ${formatSize(st.dbBytes, false)}`,
        st.updatedAt ? `最終更新: ${new Date(st.updatedAt).toLocaleString('ja-JP')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : `${repo}\nファイルの名前と内容をインデックスして、内容の逐次検索とファイル名の検索 (Ctrl+P) を使えるようにします`;

  return (
    <div className={cx('index-bar')} title={title}>
      <button
        className={cx(`index-switch${enabled ? ' on' : ''}`)}
        role="switch"
        aria-checked={enabled}
        aria-label="インデックス検索の有効 / 無効"
        onClick={toggle}
      >
        <span className={cx('index-knob')} />
      </button>
      <span className={cx('index-label')}>インデックス検索</span>
      <span className={cx(`index-state${st?.state === 'error' ? ' error' : ''}`)}>
        {!st ? '' : enabled ? stateText(st) : '無効'}
      </span>
      <button className={cx('icon-btn')} title="インデックスの設定…" onClick={() => openIndexDialog(repo)}>
        ⚙
      </button>
      {progress && (
        <div className={cx('index-progress')}>
          <div style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

/** 除外の入力欄 (1 行に 1 つ) ⇔ 配列 */
function excludesToText(ex: string[]): string {
  return ex.join('\n');
}
function textToExcludes(text: string): string[] {
  return text
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** インデックスの有効化 / 設定のダイアログ */
export function IndexSettingsDialog() {
  const repo = useIndexDialog((s) => s.repo);
  const close = useIndexDialog((s) => s.close);
  const st = useIndexStatus(repo);
  const enabled = st?.enabled === true;
  const [excludes, setExcludes] = useState('');
  const [useGitignore, setUseGitignore] = useState(true);
  const [maxKB, setMaxKB] = useState('1024');
  const [busy, setBusy] = useState(false);

  // 開いたときに現在の設定 (無効なら既定値) を入れる
  useEffect(() => {
    if (!repo) return;
    const s = st?.enabled ? st.settings : DEFAULT_INDEX_SETTINGS;
    setExcludes(excludesToText(s.excludes));
    setUseGitignore(s.useGitignore);
    setMaxKB(String(s.maxFileKB));
    setBusy(false);
  }, [repo, st?.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const kb = Number(maxKB);
  const valid = Number.isFinite(kb) && kb >= 1;
  const settings = (): IndexSettings => ({
    excludes: textToExcludes(excludes),
    useGitignore,
    maxFileKB: Math.round(kb),
  });

  const submit = async () => {
    if (!repo || !valid || busy) return;
    setBusy(true);
    const s = useSearchIndex.getState();
    const ok = enabled ? await s.saveSettings(repo, settings()) : await s.enable(repo, settings());
    setBusy(false);
    if (ok) close();
  };

  const dialogRef = useDialogKeys({
    enabled: repo !== null,
    onEnter: valid && !busy ? () => void submit() : null,
    onEscape: busy ? null : close,
  });

  if (!repo) return null;

  return (
    <div ref={dialogRef} className={cx('dialog-backdrop')}>
      <div className={cx('dialog index-dialog')}>
        <div className={cx('dialog-title')}>{enabled ? '検索インデックスの設定' : '検索インデックスを有効にする'}</div>
        <div className={cx('index-repo')} title={repo}>
          {repo}
        </div>
        {!enabled && (
          <p className={cx('index-note')}>
            このリポジトリのファイルの名前と内容をインデックスし、左パネルの検索を内容の逐次検索に切り替えます。
            Ctrl+P (mac は ⌘+P) / Ctrl+Shift+R でファイル名から開けるようになります。
            インデックスはファイルの変更に合わせて自動で更新します。
          </p>
        )}
        {enabled && st && (
          <p className={cx('index-note')}>
            {stateText(st)} (内容あり {formatCount(st.contentFiles)}) / インデックスのサイズ {formatSize(st.dbBytes, false)}
          </p>
        )}
        <label className={cx('index-field')}>
          <span className={cx('index-field-label')}>除外するフォルダ / ファイル (1 行に 1 つ)</span>
          <textarea
            className={cx('index-textarea')}
            value={excludes}
            rows={6}
            spellCheck={false}
            disabled={busy}
            placeholder={'.git\nnode_modules\ndist\n*.min.js'}
            onChange={(e) => setExcludes(e.target.value)}
          />
          <span className={cx('index-hint')}>
            / を含まない名前 (node_modules, *.min.js) はどの階層にも一致し、/ を含むもの (client/dist) はリポジトリのルートからのパスです。
            * ? ** が使えます。.git フォルダは常に除外します。
          </span>
        </label>
        <label className={cx('index-check')}>
          <input type="checkbox" checked={useGitignore} disabled={busy} onChange={(e) => setUseGitignore(e.target.checked)} />
          <span>.gitignore で無視されるファイルを除外する</span>
        </label>
        <label className={cx('index-check')}>
          <span>内容を検索するファイルの上限サイズ:</span>
          <input
            className={cx('index-number')}
            type="number"
            min={1}
            value={maxKB}
            disabled={busy}
            onChange={(e) => setMaxKB(e.target.value)}
          />
          <span>KB (超えるファイル・バイナリはファイル名のみ)</span>
        </label>
        <div className={cx('dialog-buttons')}>
          {enabled && (
            <>
              <button
                className={cx('btn')}
                disabled={busy}
                title="インデックスを捨てて最初から作り直します"
                onClick={() => {
                  void useSearchIndex.getState().rescan(repo, true);
                  close();
                }}
              >
                作り直す
              </button>
              <button
                className={cx('btn danger')}
                disabled={busy}
                onClick={() => {
                  void disableIndexWithConfirm(repo).then((ok) => ok && close());
                }}
              >
                無効にする
              </button>
              <span className={cx('spacer')} />
            </>
          )}
          <button className={cx('btn')} disabled={busy} onClick={close}>
            キャンセル
          </button>
          <button className={cx('btn primary')} disabled={!valid || busy} onClick={() => void submit()}>
            {enabled ? '保存' : '有効にする'}
          </button>
        </div>
      </div>
    </div>
  );
}
