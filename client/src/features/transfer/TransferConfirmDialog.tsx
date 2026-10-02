import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { useExplorer } from '../../stores/explorer';
import { useEditor, relocatedPath } from '../../stores/editor';
import { useGit } from '../../stores/git';
import { useToast, toastError } from '../../stores/toast';
import { usePreviewTab } from '../preview/MarkdownTab';
import { fileIcon, formatDate, formatSize, parentPath } from '../../lib/paths';
import { useDialogKeys } from '../../lib/dialogKeys';
import type {
  TransferCheck,
  TransferCheckItem,
  TransferConflictMode,
  TransferOp,
  TransferResult,
} from '../../types';
import styles from './Transfer.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

export interface TransferRequest {
  src: string[];
  destDir: string;
  /** 初期の操作 (ダイアログで変更できる) */
  op: TransferOp;
}

interface TransferConfirmStore {
  request: TransferRequest | null;
  resolve: ((results: TransferResult[] | null) => void) | null;
  finish: (results: TransferResult[] | null) => void;
}

const useTransferConfirm = create<TransferConfirmStore>((set, get) => ({
  request: null,
  resolve: null,
  finish: (results) => {
    get().resolve?.(results);
    set({ request: null, resolve: null });
  },
}));

/**
 * コピー / 移動の確認ダイアログを開く。
 * 実行したら項目ごとの結果、キャンセルしたら null で解決する。
 */
export function openTransferConfirm(request: TransferRequest): Promise<TransferResult[] | null> {
  // 前の確認が開いたままなら、それはキャンセル扱いにする
  useTransferConfirm.getState().resolve?.(null);
  return new Promise((resolve) => useTransferConfirm.setState({ request, resolve }));
}

/** Windows のドライブパスは大文字小文字を区別しない */
function isSameOrUnder(p: string, root: string): boolean {
  return relocatedPath(p, root, root) !== null;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

const CONFLICT_LABEL: Record<TransferConflictMode, string> = {
  overwrite: '上書き',
  rename: '両方残す',
  skip: 'スキップ',
};

/** 現在の操作で、その項目を実行できない理由 (実行できるなら null) */
function blockedReason(item: TransferCheckItem, op: TransferOp): string | null {
  if (item.missing) return '見つかりません';
  if (item.intoSelf) return '自分自身またはその配下へは移動・コピーできません';
  if (op === 'move' && item.sameDir) return '同じフォルダのため移動しません';
  return null;
}

/** 衝突時に「上書き」を選べない理由 (選べるなら null) */
function overwriteBlocked(item: TransferCheckItem): string | null {
  if (!item.conflict) return null;
  if (item.sameDir) return '自分自身は上書きできません';
  if ((item.conflict.type === 'dir') !== (item.type === 'dir')) return 'ファイルとフォルダの間では上書きできません';
  if (isSameOrUnder(item.src, item.dest)) return '移動元を含むフォルダは上書きできません';
  return null;
}

type Phase = 'checking' | 'ready' | 'running' | 'done';

const RESULT_LABEL: Record<TransferResult['status'], string> = {
  done: '完了',
  skipped: 'スキップ',
  error: '失敗',
};

export function TransferConfirmDialog() {
  const request = useTransferConfirm((s) => s.request);
  const finish = useTransferConfirm((s) => s.finish);
  const tabs = useEditor((s) => s.tabs);
  const [phase, setPhase] = useState<Phase>('checking');
  const [check, setCheck] = useState<TransferCheck | null>(null);
  const [op, setOp] = useState<TransferOp>('move');
  const [modes, setModes] = useState<Record<string, TransferConflictMode>>({});
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<TransferResult[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 開くたびに衝突を問い合わせる
  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    setPhase('checking');
    setCheck(null);
    setOp(request.op);
    setModes({});
    setResults([]);
    api
      .transferCheck(request.src, request.destDir)
      .then((r) => {
        if (cancelled) return;
        setCheck(r);
        // 衝突の既定は「両方残す」(何も失わない側)
        const init: Record<string, TransferConflictMode> = {};
        for (const it of r.items) if (it.conflict) init[it.src] = 'rename';
        setModes(init);
        setPhase('ready');
      })
      .catch((e) => {
        if (cancelled) return;
        toastError(e);
        finish(null);
      });
    return () => {
      cancelled = true;
    };
  }, [request, finish]);

  // 開いた時点 (衝突の問い合わせ中) でフォーカスを奪い、背後のペインがキーを受け取らないようにする
  useLayoutEffect(() => {
    if (request) bodyRef.current?.focus();
  }, [request]);

  const items = check?.items ?? [];
  const runnable = items.filter((it) => !blockedReason(it, op));
  /** 衝突があり、扱いを選べる項目 (コピーで同じフォルダの場合は自分自身との衝突) */
  const conflicted = runnable.filter((it) => it.conflict);

  /** 未保存の編集があるタブ (移動元またはその配下 / 上書きされる側) */
  const dirtyTabs = tabs.filter((t) => t.dirty);
  const dirtyWarnings: string[] = [];
  for (const it of dirtyTabs.length > 0 ? runnable : []) {
    if (op === 'move' && dirtyTabs.some((t) => isSameOrUnder(t.path, it.src))) {
      dirtyWarnings.push(`${it.name}: 未保存の編集があります (エディタのタブは移動先に付け替わります)`);
    }
    if (it.conflict && modes[it.src] === 'overwrite' && dirtyTabs.some((t) => isSameOrUnder(t.path, it.dest))) {
      dirtyWarnings.push(`${it.name}: 上書きされる側を未保存のまま開いています`);
    }
  }

  const setAll = (mode: TransferConflictMode) => {
    const next = { ...modes };
    for (const it of conflicted) {
      // 上書きできない項目は「上書き」の一括指定から外す
      if (mode === 'overwrite' && overwriteBlocked(it)) continue;
      next[it.src] = mode;
    }
    setModes(next);
  };

  const run = async () => {
    if (!request || !check || phase !== 'ready' || runnable.length === 0) return;
    setPhase('running');
    setProgress({ done: 0, total: runnable.length });
    const out: TransferResult[] = items
      .filter((it) => blockedReason(it, op))
      .map((it) => ({ src: it.src, status: 'skipped' as const, message: blockedReason(it, op) ?? undefined }));
    // 1 件ずつ送って進捗を出す (サーバは項目ごとに結果を返す)
    for (const [i, it] of runnable.entries()) {
      const onConflict = it.conflict ? (modes[it.src] ?? 'rename') : undefined;
      try {
        const r = await api.transfer(op, check.destDir, [{ src: it.src, onConflict }]);
        out.push(...r.results);
      } catch (e) {
        out.push({ src: it.src, status: 'error', message: e instanceof Error ? e.message : String(e) });
      }
      setProgress({ done: i + 1, total: runnable.length });
    }
    afterTransfer(op, out, runnable, modes);
    const done = out.filter((r) => r.status === 'done').length;
    const failed = out.filter((r) => r.status === 'error').length;
    const skipped = out.length - done - failed;
    if (failed === 0 && skipped === 0) {
      useToast.getState().show('success', `${done} 項目を${op === 'move' ? '移動' : 'コピー'}しました`);
      finish(out);
      return;
    }
    // 失敗・スキップがあれば結果を見せてから閉じる
    setResults(out);
    setPhase('done');
  };

  const cancel = () => {
    if (phase === 'running') return;
    finish(phase === 'done' ? results : null);
  };

  const dialogRef = useDialogKeys({
    enabled: !!request,
    onEnter: phase === 'ready' && runnable.length > 0 ? () => void run() : phase === 'done' ? cancel : null,
    onEscape: phase === 'running' ? null : cancel,
  });

  if (!request) return null;

  const opLabel = op === 'move' ? '移動' : 'コピー';
  const resultOf = (src: string) => results.find((r) => r.src === src);

  return (
    <div ref={dialogRef} className={cx('dialog-backdrop nested')}>
      <div className={cx('dialog confirm-dialog')} ref={bodyRef} tabIndex={-1}>
        <div className={cx('dialog-title')}>
          {request.src.length} 項目を{phase === 'checking' ? '移動 / コピー' : opLabel}
        </div>

        {phase === 'checking' ? (
          <div className={cx('confirm-note')}>確認しています…</div>
        ) : (
          <>
            {phase !== 'done' && (
              <div className={cx('confirm-op')}>
                <span>操作:</span>
                {(['move', 'copy'] as const).map((v) => (
                  <label key={v} className={cx('confirm-radio')}>
                    <input
                      type="radio"
                      name="transfer-op"
                      checked={op === v}
                      disabled={phase !== 'ready'}
                      onChange={() => setOp(v)}
                    />
                    {v === 'move' ? '移動' : 'コピー'}
                  </label>
                ))}
              </div>
            )}
            <div className={cx('confirm-paths')}>
              <span className={cx('confirm-path-label')}>{opLabel}元</span>
              <span className={cx('confirm-path')}>{parentOf(items)}</span>
              <span className={cx('confirm-path-label')}>{opLabel}先</span>
              <span className={cx('confirm-path')}>{check?.destDir}</span>
            </div>

            <div className={cx('confirm-table-wrap')}>
              <table className={cx('confirm-table')}>
                <thead>
                  <tr>
                    <th>名前</th>
                    <th className={cx('num')}>サイズ</th>
                    <th>更新日時</th>
                    <th>{phase === 'done' ? '結果' : '衝突時の扱い'}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => {
                    const blocked = blockedReason(it, op);
                    const res = resultOf(it.src);
                    const owBlocked = overwriteBlocked(it);
                    const isDir = it.type === 'dir';
                    return (
                      <tr key={it.src} className={cx(blocked ? 'blocked' : '')}>
                        <td>
                          <span className={cx('confirm-name')}>
                            <span>{fileIcon({ type: it.type ?? 'file', ext: extOf(it.name) })}</span>
                            <span>{it.name}</span>
                          </span>
                          {!blocked && it.conflict && phase !== 'done' && (
                            <div className={cx('confirm-existing')}>
                              ⚠ {it.sameDir ? '同じフォルダへのコピー (自分自身と同名)' : '同名の項目があります'}
                              {!it.sameDir &&
                                ` — 既存: ${it.conflict.type === 'dir' ? 'フォルダ' : formatSize(it.conflict.size, false)} / ${formatDate(it.conflict.mtime)}`}
                            </div>
                          )}
                        </td>
                        <td className={cx('num')}>{it.missing ? '' : formatSize(it.size ?? 0, isDir)}</td>
                        <td>{it.mtime ? formatDate(it.mtime) : ''}</td>
                        <td>
                          {phase === 'done' ? (
                            <span className={cx(`result-${res?.status ?? 'skipped'}`)}>
                              {RESULT_LABEL[res?.status ?? 'skipped']}
                              {res?.message ? `: ${res.message}` : ''}
                            </span>
                          ) : blocked ? (
                            <span className={cx('confirm-blocked')}>{blocked}</span>
                          ) : it.conflict ? (
                            <select
                              value={modes[it.src] ?? 'rename'}
                              disabled={phase !== 'ready'}
                              title={owBlocked ? `上書きできません: ${owBlocked}` : undefined}
                              onChange={(e) => setModes({ ...modes, [it.src]: e.target.value as TransferConflictMode })}
                            >
                              {(['overwrite', 'rename', 'skip'] as const).map((m) => (
                                <option key={m} value={m} disabled={m === 'overwrite' && !!owBlocked}>
                                  {CONFLICT_LABEL[m]}
                                  {m === 'overwrite' && owBlocked ? ' (不可)' : ''}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className={cx('confirm-dim')}>衝突なし</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {phase === 'ready' && conflicted.length > 0 && (
              <div className={cx('confirm-bulk')}>
                <span>衝突 {conflicted.length} 件をまとめて:</span>
                {(['overwrite', 'rename', 'skip'] as const).map((m) => (
                  <button key={m} className={cx('btn small')} onClick={() => setAll(m)}>
                    {CONFLICT_LABEL[m]}
                  </button>
                ))}
                <span className={cx('confirm-dim')}>上書きされる側はゴミ箱へ移動します</span>
              </div>
            )}
            {phase === 'ready' &&
              dirtyWarnings.map((w) => (
                <div key={w} className={cx('confirm-warn')}>
                  ⚠ {w}
                </div>
              ))}
            {phase === 'running' && (
              <div className={cx('confirm-progress')}>
                <progress max={progress.total} value={progress.done} />
                <span>
                  {opLabel}中… {progress.done} / {progress.total}
                </span>
              </div>
            )}
          </>
        )}

        <div className={cx('dialog-buttons')}>
          {phase === 'done' ? (
            <button className={cx('btn primary')} onClick={cancel}>
              閉じる
            </button>
          ) : (
            <>
              <button className={cx('btn')} onClick={cancel} disabled={phase === 'running'}>
                キャンセル
              </button>
              <button
                className={cx('btn primary')}
                onClick={() => void run()}
                disabled={phase !== 'ready' || runnable.length === 0}
              >
                {opLabel}する
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 対象の親フォルダ (2 画面ダイアログからは常に 1 つ。複数あれば「複数のフォルダ」) */
function parentOf(items: TransferCheckItem[]): string {
  const dirs = new Set(items.map((it) => parentPath(it.src)));
  return dirs.size === 1 ? [...dirs][0] : '(複数のフォルダ)';
}

/** 実行後の後始末: エディタ等のタブを移動先へ付け替え、上書きされたファイルのタブは読み直し、一覧と Git 状態を更新する */
function afterTransfer(
  op: TransferOp,
  results: TransferResult[],
  items: TransferCheckItem[],
  modes: Record<string, TransferConflictMode>,
): void {
  const done = results.filter((r) => r.status === 'done' && r.dest);
  if (op === 'move') {
    const moves = done.map((r) => ({ from: r.src, to: r.dest! }));
    useEditor.getState().relocate(moves);
    const preview = usePreviewTab.getState().current;
    if (preview) {
      for (const m of moves) {
        const next = relocatedPath(preview, m.from, m.to);
        if (next) {
          usePreviewTab.getState().open(next);
          break;
        }
      }
    }
  }
  // 上書きされた側をエディタで開いていれば、外部変更として読み直す (未保存なら通知のみ)
  const editor = useEditor.getState();
  for (const r of done) {
    const item = items.find((it) => it.src === r.src);
    if (!item?.conflict || modes[r.src] !== 'overwrite') continue;
    for (const t of editor.tabs) {
      if (isSameOrUnder(t.path, r.dest!)) editor.handleExternalChange(t.path);
    }
  }
  void useExplorer.getState().refresh();
  void useGit.getState().refreshStatus();
}
