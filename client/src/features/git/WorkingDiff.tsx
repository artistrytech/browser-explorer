import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { toastError } from '../../stores/toast';
import { confirmDialog } from '../../stores/dialog';
import { useExplorer } from '../../stores/explorer';
import { parseFileDiff, buildHunkPatch, buildLinesPatch, isChangeLine, type FileDiff } from '../../lib/diffPatch';
import styles from './WorkingDiff.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** コミットタブでフォーカス中のファイル (ステージ済み / 変更 / 未追跡) */
export interface FocusFile {
  path: string;
  /** 'staged' はステージ側 (HEAD↔index)、'unstaged' は作業ツリー側 (index↔worktree) */
  side: 'staged' | 'unstaged';
  /** 未追跡ファイル (部分ステージ不可・全体を追加行として表示) */
  untracked: boolean;
}

/** フォーカス中の複数ファイルの差分を、Hunk・行単位のステージ/解除つきで表示する */
export function WorkingDiff({
  repo,
  files,
  onApplied,
}: {
  repo: string;
  files: FocusFile[];
  onApplied: () => void;
}) {
  return (
    <div className={cx("work-diff")}>
      {files.map((f) => (
        <FileDiffBlock key={`${f.side}:${f.path}`} repo={repo} file={f} onApplied={onApplied} />
      ))}
    </div>
  );
}

function FileDiffBlock({ repo, file, onApplied }: { repo: string; file: FocusFile; onApplied: () => void }) {
  const [parsed, setParsed] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  /** 選択中の行キー `${hunkIndex}:${lineIndex}` */
  const [selLines, setSelLines] = useState<Set<string>>(new Set());
  /** Shift 範囲選択の起点 `${hunkIndex}:${lineIndex}` */
  const [anchorLine, setAnchorLine] = useState<string | null>(null);

  const reverse = file.side === 'staged'; // ステージ済み → 解除 (--reverse)
  const actionLabel = reverse ? '解除' : 'ステージ';
  const sideLabel = file.untracked ? '未追跡' : file.side === 'staged' ? 'ステージ済み' : '変更';
  const partialAvailable = !file.untracked; // 未追跡は Hunk/行の部分操作不可 (全体を＋でステージ)

  const load = () => {
    setLoading(true);
    api
      .gitDiff(repo, file.path, file.side === 'staged', file.untracked)
      .then((r) => {
        setParsed(parseFileDiff(r.diff));
        setSelLines(new Set());
        setAnchorLine(null);
      })
      .catch(toastError)
      .finally(() => setLoading(false));
  };

  // ファイルが変わったら読み込み。onApplied による status 変化とは独立に自前で再取得する
  useEffect(load, [repo, file.path, file.side, file.untracked]);

  const apply = async (patch: string | null, empty: string) => {
    if (!patch) {
      toastError(new Error(empty));
      return;
    }
    setBusy(true);
    try {
      await api.gitApplyPatch(repo, patch, reverse);
      load();
      onApplied();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  /** Hunk の変更を破棄する (作業ツリーへ reverse 適用)。破棄は取り消せないため確認する */
  const discardHunk = async (hunk: FileDiff['hunks'][number]) => {
    if (!parsed) return;
    const ok = await confirmDialog('変更を破棄', 'この Hunk の変更を破棄しますか?', true);
    if (!ok) return;
    setBusy(true);
    try {
      await api.gitApplyPatch(repo, buildHunkPatch(parsed.header, [hunk]), true, false);
      load();
      onApplied();
      void useExplorer.getState().refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  /** 行クリック: トグル / Shift で同一 Hunk 内の範囲をまとめて選択 */
  const clickLine = (e: React.MouseEvent, hIdx: number, lIdx: number) => {
    const key = `${hIdx}:${lIdx}`;
    if (e.shiftKey && anchorLine && parsed) {
      const [ah, al] = anchorLine.split(':').map(Number);
      if (ah === hIdx) {
        const hunk = parsed.hunks[hIdx];
        const [lo, hi] = al < lIdx ? [al, lIdx] : [lIdx, al];
        setSelLines((prev) => {
          const next = new Set(prev);
          for (let i = lo; i <= hi; i++) {
            if (isChangeLine(hunk.lines[i])) next.add(`${hIdx}:${i}`);
          }
          return next;
        });
        setAnchorLine(key);
        return;
      }
    }
    setSelLines((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setAnchorLine(key);
  };

  return (
    <div className={cx("work-diff-file")}>
      <div className={cx("work-diff-head")}>
        <span className={cx(`wd-side wd-side-${file.side}`)}>{sideLabel}</span>
        <span className={cx("wd-path")} title={file.path}>
          {file.path}
        </span>
      </div>

      {loading ? (
        <div className={cx("empty-hint")}>読み込み中…</div>
      ) : !parsed || parsed.hunks.length === 0 ? (
        <div className={cx("empty-hint")}>差分はありません</div>
      ) : (
        parsed.hunks.map((hunk, hIdx) => {
          const hunkSel = new Set<number>();
          selLines.forEach((k) => {
            const [h, l] = k.split(':').map(Number);
            if (h === hIdx) hunkSel.add(l);
          });
          return (
            <div key={hIdx} className={cx("wd-hunk")}>
              <div className={cx("wd-hunk-head")}>
                <span className={cx("wd-hunk-info")}>{hunk.header}</span>
                {partialAvailable && (
                  <span className={cx("wd-hunk-actions")}>
                    {hunkSel.size > 0 && (
                      <button
                        className={cx("status-btn")}
                        disabled={busy}
                        title={`選択した ${hunkSel.size} 行を${actionLabel}`}
                        onClick={() =>
                          void apply(
                            buildLinesPatch(parsed.header, hunk, hunkSel, reverse),
                            '対象の行が選択されていません',
                          )
                        }
                      >
                        選択行を{actionLabel}
                      </button>
                    )}
                    <button
                      className={cx("status-btn")}
                      disabled={busy}
                      title={`この Hunk を${actionLabel}`}
                      onClick={() => void apply(buildHunkPatch(parsed.header, [hunk]), '')}
                    >
                      Hunk を{actionLabel}
                    </button>
                    {!reverse && (
                      // 変更 (作業ツリー) 側のみ破棄可能。ステージ側は「解除」で戻す
                      <button
                        className={cx("status-btn danger")}
                        disabled={busy}
                        title="この Hunk の変更を破棄"
                        onClick={() => void discardHunk(hunk)}
                      >
                        Hunk を破棄
                      </button>
                    )}
                  </span>
                )}
              </div>
              <pre className={cx("diff-view")}>
                {hunk.lines.map((line, lIdx) => {
                  const tag = line[0];
                  const cls =
                    tag === '+' ? 'diff-add' : tag === '-' ? 'diff-del' : tag === '\\' ? 'diff-meta' : '';
                  const selectable = partialAvailable && isChangeLine(line);
                  const isSel = selLines.has(`${hIdx}:${lIdx}`);
                  return (
                    <div
                      key={lIdx}
                      className={cx(`diff-line ${cls}${selectable ? ' wd-selectable' : ''}${isSel ? ' wd-line-sel' : ''}`)}
                      onClick={selectable ? (e) => clickLine(e, hIdx, lIdx) : undefined}
                    >
                      {line || ' '}
                    </div>
                  );
                })}
              </pre>
            </div>
          );
        })
      )}
    </div>
  );
}
