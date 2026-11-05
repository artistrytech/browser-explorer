import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { toastError } from '../../stores/toast';
import { choiceDialog, confirmDialog } from '../../stores/dialog';
import { useExplorer } from '../../stores/explorer';
import {
  parseFileDiff,
  buildHunkPatch,
  buildLinesPatch,
  hunkLineNumbers,
  isChangeLine,
  isBinaryDiff,
  contentOnlyHeader,
  hunkEditRange,
  editRangeText,
  buildEditPatch,
  editPatchHeader,
  usableFileLines,
  type EditRange,
  type FileDiff,
  type Hunk,
} from '../../lib/diffPatch';
import { openLineEditDialog } from './LineEditDialog';
import { DiffLineText, useDiffHighlight, type DiffSources } from '../../lib/diffHighlight';
import styles from './WorkingDiff.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** コミットタブでフォーカス中のファイル (ステージ済み / 変更 / 未追跡) */
export interface FocusFile {
  path: string;
  /** 'staged' はステージ側 (HEAD↔index)、'unstaged' は作業ツリー側 (index↔worktree) */
  side: 'staged' | 'unstaged';
  /** ステージ済みで名前変更されたファイルの変更前パス (それ以外は null) */
  oldPath: string | null;
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
  const [sources, setSources] = useState<DiffSources | null>(null);
  const highlight = useDiffHighlight(parsed, file.path, sources);

  const reverse = file.side === 'staged'; // ステージ済み → 解除 (--reverse)
  const actionLabel = reverse ? '解除' : 'ステージ';
  const sideLabel = file.untracked ? '未追跡' : file.side === 'staged' ? 'ステージ済み' : '変更';
  const partialAvailable = !file.untracked; // 未追跡は Hunk/行の部分操作不可 (全体を＋でステージ)

  const load = () => {
    setLoading(true);
    api
      .gitDiff(repo, file.path, file.side === 'staged', file.untracked, file.oldPath)
      .then((r) => {
        setParsed(parseFileDiff(r.diff));
        setSelLines(new Set());
        setAnchorLine(null);
      })
      .catch(toastError)
      .finally(() => setLoading(false));
  };

  // ファイルが変わったら読み込み。onApplied による status 変化とは独立に自前で再取得する
  useEffect(load, [repo, file.path, file.side, file.untracked, file.oldPath]);

  /**
   * 色付けの状態を正しく取るためのファイル全体。
   * ステージ側は HEAD ↔ インデックス、変更側はインデックス ↔ 作業ツリーを見る。
   * 取得できなくても Hunk の行だけで色付けされるので、失敗は無視してよい。
   */
  useEffect(() => {
    let stale = false;
    setSources(null);
    const content = (rev: string, p = file.path) =>
      api
        .gitFileContent(repo, rev, p)
        .then((r) => r.content)
        .catch(() => null);
    // 未追跡ファイルは「変更前」が無く、全体が追加行になる。名前変更は HEAD 側を変更前のパスで取る
    const before = file.untracked ? Promise.resolve(null) : content(reverse ? 'HEAD' : '', file.oldPath ?? file.path);
    const after = content(reverse ? '' : 'worktree');
    void Promise.all([before, after]).then(([old, next]) => {
      if (!stale) setSources({ old, new: next });
    });
    return () => {
      stale = true;
    };
  }, [repo, file.path, file.side, file.untracked, file.oldPath, reverse]);

  /** 部分ステージ/解除・破棄のパッチに使うヘッダ (名前変更は内容の変更だけにする) */
  const patchHeader = parsed ? contentOnlyHeader(parsed.header) : [];

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

  /** Hunk 全体 / 選択行のどちらを対象にするかの選択肢 */
  const scopeOptions = (count: number) => [
    { value: 'hunk', label: 'Hunk 全体' },
    { value: 'lines', label: `選択した ${count} 行` },
  ];

  /** ステージ / 解除。選択行があれば Hunk 全体と選択行のどちらにするかを選んでもらう */
  const stageHunk = async (hunk: Hunk, selected: Set<number>) => {
    let scope = 'hunk';
    if (selected.size > 0) {
      const picked = await choiceDialog(
        actionLabel,
        `どちらを${actionLabel}しますか?`,
        scopeOptions(selected.size),
        'lines',
      );
      if (!picked) return;
      scope = picked;
    }
    await apply(
      scope === 'lines' ? buildLinesPatch(patchHeader, hunk, selected, reverse) : buildHunkPatch(patchHeader, [hunk]),
      '対象の行が選択されていません',
    );
  };

  /**
   * 変更を破棄する (作業ツリーへ reverse 適用)。破棄は取り消せないため確認する。
   * 選択行があれば、確認のダイアログで Hunk 全体と選択行のどちらを破棄するかを選んでもらう。
   * 選択行のパッチは「解除方向」の形 (未選択の + は文脈化・未選択の - は破棄) で組み立てると
   * パッチの変更後 = 現在の作業ツリーとなり、--reverse 適用で選択行だけが元に戻る。
   */
  const discard = async (hunk: Hunk, selected: Set<number>) => {
    if (!parsed) return;
    const scope =
      selected.size > 0
        ? await choiceDialog(
            '変更を破棄',
            'どちらの変更を破棄しますか? (元に戻せません)',
            scopeOptions(selected.size),
            'lines',
            true,
          )
        : (await confirmDialog('変更を破棄', 'この Hunk の変更を破棄しますか?', true))
          ? 'hunk'
          : null;
    if (!scope) return;
    const patch =
      scope === 'lines' ? buildLinesPatch(patchHeader, hunk, selected, true) : buildHunkPatch(patchHeader, [hunk]);
    if (!patch) {
      toastError(new Error('対象の行が選択されていません'));
      return;
    }
    setBusy(true);
    try {
      await api.gitApplyPatch(repo, patch, true, false);
      load();
      onApplied();
      void useExplorer.getState().refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Hunk 全体 / 選択行の範囲を、ダイアログでテキストとして直接書き換える。
   * 選択行があれば、ダイアログのラジオボタンで Hunk 全体と選択行を切り替えられる (最初は選択行)。
   * 変更 (未ステージ・未追跡) 側だけが対象で、作業ツリーのファイルを書き換える。
   * 範囲の前後を文脈に付けたパッチを作業ツリーへ git apply で当てる。
   * 削除行は変更後側に行が無いので、その位置への挿入として扱う
   */
  const editLines = async (hunk: Hunk, selected: Set<number>) => {
    if (!parsed || reverse) return;
    const header = editPatchHeader(parsed.header);
    const hunkRange = hunkEditRange(hunk, hunk.lines.keys());
    const selRange = selected.size > 0 ? hunkEditRange(hunk, selected) : null;
    if (!header || !hunkRange) {
      toastError(new Error('編集できる行がありません'));
      return;
    }
    setBusy(true);
    let content: string | null;
    try {
      content = (await api.gitFileContent(repo, 'worktree', file.path)).content;
    } catch (e) {
      toastError(e);
      return;
    } finally {
      setBusy(false);
    }
    if (content === null) {
      toastError(new Error('ファイルの内容を読み込めませんでした'));
      return;
    }
    // 表示中の差分と今のファイルが食い違う (外部で書き換わった) なら、読み込み直してから編集してもらう
    if (!usableFileLines(parsed, 'new', content)) {
      toastError(new Error('ファイルが変更されています。差分を読み込み直したので、もう一度操作してください'));
      load();
      return;
    }
    const describe = (r: EditRange) =>
      `作業ツリー ${r.hi < r.lo ? `${r.lo} 行目の前に挿入` : r.hi === r.lo ? `${r.lo} 行目` : `${r.lo}〜${r.hi} 行目`}`;
    const scopes = [{ value: 'hunk', label: 'Hunk 全体', range: hunkRange }];
    if (selRange) scopes.push({ value: 'lines', label: `選択した ${selected.size} 行`, range: selRange });
    const result = await openLineEditDialog({
      title: '編集',
      path: file.path,
      scopes: scopes.map((sc) => ({
        value: sc.value,
        label: sc.label,
        target: describe(sc.range),
        text: editRangeText(content, sc.range),
      })),
      scope: selRange ? 'lines' : 'hunk',
    });
    if (!result) return;
    const range = (scopes.find((sc) => sc.value === result.scope) ?? scopes[0]).range;
    const patch = buildEditPatch(header, content, range, result.text);
    if (!patch) return; // 変更なし
    setBusy(true);
    try {
      await api.gitApplyPatch(repo, patch, false, false);
      load();
      onApplied();
      void useExplorer.getState().refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Shift+クリックは行の範囲選択に使うので、ブラウザ既定の「テキスト選択の拡張」は止める。
   * (Shift 無しのドラッグによるテキストの範囲選択・コピーはそのまま使える)
   */
  const mouseDownLine = (e: React.MouseEvent) => {
    if (e.shiftKey) e.preventDefault();
  };

  /** 行クリック: トグル / Shift で同一 Hunk 内の範囲をまとめて選択 */
  const clickLine = (e: React.MouseEvent, hIdx: number, lIdx: number) => {
    // ドラッグでテキストを範囲選択したときは、行の選択トグルとして扱わない。
    // (単純なクリックなら mousedown の時点で選択が解除され collapsed になる。
    //  Shift+クリックは mousedown で既定動作を止めているのでテキスト選択は起きない)
    if (!e.shiftKey && !(window.getSelection()?.isCollapsed ?? true)) return;
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

  const title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;

  return (
    <div className={cx("work-diff-file")}>
      <div className={cx("work-diff-head")}>
        <span className={cx(`wd-side wd-side-${file.side}`)}>{sideLabel}</span>
        <span className={cx("wd-path")} title={title}>
          {title}
        </span>
      </div>

      {loading ? (
        <div className={cx("empty-hint")}>読み込み中…</div>
      ) : !parsed || parsed.hunks.length === 0 ? (
        <div className={cx("empty-hint")}>
          {parsed && isBinaryDiff(parsed)
            ? 'バイナリファイルです'
            : file.oldPath
              ? '名前の変更のみです (内容の差分はありません)'
              : '差分はありません'}
        </div>
      ) : (
        parsed.hunks.map((hunk, hIdx) => {
          const hunkSel = new Set<number>();
          selLines.forEach((k) => {
            const [h, l] = k.split(':').map(Number);
            if (h === hIdx) hunkSel.add(l);
          });
          const lineNos = hunkLineNumbers(hunk);
          return (
            <div key={hIdx} className={cx("wd-hunk")}>
              <div className={cx("wd-hunk-head")}>
                <span className={cx("wd-hunk-info")}>{hunk.header}</span>
                <span className={cx("wd-hunk-actions")}>
                  {partialAvailable && (
                    <button
                      className={cx("status-btn")}
                      disabled={busy}
                      title={
                        hunkSel.size > 0
                          ? `この Hunk か選択した ${hunkSel.size} 行を${actionLabel}`
                          : `この Hunk を${actionLabel}`
                      }
                      onClick={() => void stageHunk(hunk, hunkSel)}
                    >
                      {actionLabel}
                    </button>
                  )}
                  {partialAvailable && !reverse && (
                    // 変更 (作業ツリー) 側のみ破棄可能。ステージ側は「解除」で戻す
                    <button
                      className={cx("status-btn danger")}
                      disabled={busy}
                      title={
                        hunkSel.size > 0
                          ? `この Hunk か選択した ${hunkSel.size} 行の変更を破棄`
                          : 'この Hunk の変更を破棄'
                      }
                      onClick={() => void discard(hunk, hunkSel)}
                    >
                      破棄
                    </button>
                  )}
                  {!reverse && (
                    // 変更 (作業ツリー) 側のみ編集可能。ステージ済みの Hunk は編集しない
                    <button
                      className={cx("status-btn")}
                      disabled={busy}
                      title={
                        hunkSel.size > 0
                          ? `この Hunk か選択した ${hunkSel.size} 行の範囲をテキストで編集`
                          : 'この Hunk の範囲をテキストで編集'
                      }
                      onClick={() => void editLines(hunk, hunkSel)}
                    >
                      編集
                    </button>
                  )}
                </span>
              </div>
              <pre className={cx("diff-view")}>
                {hunk.lines.map((line, lIdx) => {
                  const tag = line[0];
                  const cls =
                    tag === '+' ? 'diff-add' : tag === '-' ? 'diff-del' : tag === '\\' ? 'diff-meta' : '';
                  const selectable = partialAvailable && isChangeLine(line);
                  const isSel = selLines.has(`${hIdx}:${lIdx}`);
                  const no = lineNos[lIdx];
                  return (
                    <div
                      key={lIdx}
                      className={cx(`diff-line ${cls}${selectable ? ' wd-selectable' : ''}${isSel ? ' wd-line-sel' : ''}`)}
                      onMouseDown={selectable ? mouseDownLine : undefined}
                      onClick={selectable ? (e) => clickLine(e, hIdx, lIdx) : undefined}
                    >
                      <span className={cx("wd-lineno")} aria-hidden="true">{no.old ?? ''}</span>
                      <span className={cx("wd-lineno")} aria-hidden="true">{no.new ?? ''}</span>
                      <DiffLineText
                        line={line}
                        render={highlight(hIdx, lIdx)}
                        className={cx("wd-linetext")}
                      />
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
