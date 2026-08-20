import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useContextMenu } from '../../components/ContextMenu';
import { confirmDialog } from '../../stores/dialog';
import { useGit } from '../../stores/git';
import { useReview } from '../../stores/review';
import { toastError } from '../../stores/toast';
import { useUi } from '../../stores/ui';
import { fileOpenMenuItems, pruneMenuItems } from '../../lib/openMenu';
import { hunkLineNumbers, parseFileDiff, type FileDiff } from '../../lib/diffPatch';
import { DiffLineText, useDiffHighlight, type DiffSources } from '../../lib/diffHighlight';
import type { CommitFile, ReviewComment } from '../../types';
import styles from './Review.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** 差分 1 行 (Hunk 見出しも同じ配列に混ぜて描画順を保つ) */
interface DiffRow {
  kind: 'hunk' | 'line';
  /** Hunk 見出し (@@ …) */
  header?: string;
  /** 本文 (先頭のタグ文字を含む。CommitFileDiff と同じ見た目) */
  text: string;
  oldNo: number | null;
  newNo: number | null;
  /** この行に付けるコメントの側。null はコメント不可 ("\ No newline" 行) */
  side: 'old' | 'new' | null;
  /** side 側の行番号 */
  lineNo: number | null;
  /** 色付けの引き当てに使う元の位置 (Hunk 番号 / Hunk 内の行番号) */
  hunkIndex: number;
  lineIndex: number;
}

/** 選択範囲 (行インデックス。side は起点の行で決まる) */
interface Selection {
  side: 'old' | 'new';
  anchor: number;
  focus: number;
}

function buildRows(parsed: FileDiff): DiffRow[] {
  const rows: DiffRow[] = [];
  parsed.hunks.forEach((hunk, h) => {
    rows.push({
      kind: 'hunk',
      header: hunk.header,
      text: '',
      oldNo: null,
      newNo: null,
      side: null,
      lineNo: null,
      hunkIndex: h,
      lineIndex: -1,
    });
    const nos = hunkLineNumbers(hunk);
    hunk.lines.forEach((line, i) => {
      const tag = line[0];
      // 削除行は変更前、それ以外 (追加・文脈) は変更後に紐づける (GitHub と同じ)
      const side = tag === '\\' ? null : tag === '-' ? 'old' : 'new';
      rows.push({
        kind: 'line',
        text: line,
        oldNo: nos[i].old,
        newNo: nos[i].new,
        side,
        lineNo: side === 'old' ? nos[i].old : nos[i].new,
        hunkIndex: h,
        lineIndex: i,
      });
    });
  });
  return rows;
}

function lineClass(text: string): string {
  const tag = text[0];
  return tag === '+' ? 'diff-add' : tag === '-' ? 'diff-del' : tag === '\\' ? 'diff-meta' : '';
}

function rangeLabel(c: ReviewComment): string {
  const range = c.lineStart === c.lineEnd ? `L${c.lineStart}` : `L${c.lineStart}-L${c.lineEnd}`;
  return `${range} (${c.side === 'old' ? '変更前' : '変更後'})`;
}

/**
 * レビュー中の 1 ファイル分の差分 (unified)。
 * 行番号の溝をクリック / ドラッグして範囲を選び、その場でコメントを付けられる。
 */
export function ReviewFileDiff({
  reviewId,
  file,
  comments,
  readOnly,
  baseCommit,
  headCommit,
}: {
  reviewId: number;
  file: CommitFile;
  /** このファイルに属するコメント */
  comments: ReviewComment[];
  /** クローズ済みレビューは閲覧のみ */
  readOnly: boolean;
  /** 色付けをファイル全体から行うための、固定したコミット */
  baseCommit: string;
  headCommit: string;
}) {
  const repoRoot = useGit((s) => s.repoRoot);
  const menuConfig = useUi((s) => s.menuConfig);
  const [parsed, setParsed] = useState<FileDiff | null>(null);
  const [sources, setSources] = useState<DiffSources | null>(null);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  /** コメント入力を開いている選択範囲 (mouseup で確定した範囲) */
  const [composing, setComposing] = useState<Selection | null>(null);
  const [draft, setDraft] = useState('');
  const dragging = useRef(false);
  /** mouseup (ペイン外で離した場合も含む) から参照する現在の選択 */
  const selectionRef = useRef<Selection | null>(null);

  const changeSelection = (sel: Selection | null) => {
    selectionRef.current = sel;
    setSelection(sel);
  };

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setParsed(null);
    changeSelection(null);
    setComposing(null);
    api
      .reviewFilePatch(reviewId, file.path, file.oldPath)
      .then((r) => {
        if (!stale) setParsed(parseFileDiff(r.diff));
      })
      .catch((e) => {
        if (!stale) toastError(e);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true; // 選択が素早く変わった場合、古い応答で上書きしない
    };
  }, [reviewId, file.path, file.oldPath]);

  /**
   * 色付けの状態を正しく取るためのファイル全体 (変更前 / 変更後)。
   * 取得できなくても Hunk の行だけで色付けされるので、失敗は無視してよい。
   */
  useEffect(() => {
    let stale = false;
    setSources(null);
    const oldPath = file.oldPath ?? file.path;
    const load = (rev: string, p: string, exists: boolean) =>
      exists
        ? api
            .gitFileContent(repoRoot!, rev, p)
            .then((r) => r.content)
            .catch(() => null)
        : Promise.resolve(null);
    if (!repoRoot) return;
    void Promise.all([
      load(baseCommit, oldPath, file.status !== 'A'),
      load(headCommit, file.path, file.status !== 'D'),
    ]).then(([before, after]) => {
      if (!stale) setSources({ old: before, new: after });
    });
    return () => {
      stale = true;
    };
  }, [repoRoot, baseCommit, headCommit, file.path, file.oldPath, file.status]);

  // ドラッグ終了はペイン外で離しても拾う
  useEffect(() => {
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      if (selectionRef.current) setComposing(selectionRef.current);
    };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, []);

  /** 選択範囲 → 行番号 (起点と同じ側の行だけを数える) */
  const selectedLines = (sel: Selection, list: DiffRow[]): { start: number; end: number } | null => {
    const from = Math.min(sel.anchor, sel.focus);
    const to = Math.max(sel.anchor, sel.focus);
    const nums: number[] = [];
    for (let i = from; i <= to; i++) {
      const r = list[i];
      if (r && r.kind === 'line' && r.side === sel.side && r.lineNo !== null) nums.push(r.lineNo);
    }
    if (nums.length === 0) return null;
    return { start: Math.min(...nums), end: Math.max(...nums) };
  };

  const startSelect = (index: number, row: DiffRow, e: React.MouseEvent) => {
    if (readOnly || row.side === null) return;
    e.preventDefault();
    // Shift+クリックは直前の起点から範囲を広げる (同じ側のときのみ)
    if (e.shiftKey && selection && selection.side === row.side) {
      const next = { ...selection, focus: index };
      changeSelection(next);
      setComposing(next);
      return;
    }
    dragging.current = true;
    setComposing(null);
    changeSelection({ side: row.side, anchor: index, focus: index });
  };

  const extendSelect = (index: number) => {
    if (!dragging.current || !selectionRef.current) return;
    changeSelection({ ...selectionRef.current, focus: index });
  };

  const cancelSelect = () => {
    changeSelection(null);
    setComposing(null);
    setDraft('');
  };

  const saveDraft = async () => {
    if (!rows || !composing) return;
    const body = draft.trim();
    if (!body) return;
    const range = selectedLines(composing, rows);
    if (!range) return;
    try {
      const { comment } = await api.reviewAddComment({
        id: reviewId,
        path: file.path,
        oldPath: file.oldPath,
        side: composing.side,
        lineStart: range.start,
        lineEnd: range.end,
        body,
      });
      useReview.getState().applyComment(comment);
      cancelSelect();
    } catch (e) {
      toastError(e);
    }
  };

  const rows = useMemo(() => (parsed ? buildRows(parsed) : null), [parsed]);
  const highlight = useDiffHighlight(parsed, file.path, sources);

  // 行末 (side + 行番号) ごとのコメント。位置が特定できないものは先頭にまとめて出す
  const { byLine, orphans } = useMemo(() => {
    const byLine = new Map<string, ReviewComment[]>();
    const keys = new Set<string>();
    for (const r of rows ?? []) {
      if (r.kind === 'line' && r.side && r.lineNo !== null) keys.add(`${r.side}:${r.lineNo}`);
    }
    const orphans: ReviewComment[] = [];
    for (const c of comments) {
      const key = `${c.side}:${c.lineEnd}`;
      if (!keys.has(key)) {
        orphans.push(c);
        continue;
      }
      const list = byLine.get(key) ?? [];
      list.push(c);
      byLine.set(key, list);
    }
    return { byLine, orphans };
  }, [rows, comments]);

  const selRange = selection && rows ? { from: Math.min(selection.anchor, selection.focus), to: Math.max(selection.anchor, selection.focus) } : null;
  const composingRange = composing && rows ? selectedLines(composing, rows) : null;
  const composingEnd = composing ? Math.max(composing.anchor, composing.focus) : -1;

  const title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;

  /**
   * 「開く」ボタン: ファイルタブのコンテキストメニューと同じ「開く」の項目を、
   * ボタンの直下にプルダウンとして出す。対象は作業ツリーの現在の内容
   * (レビューはコミットのスナップショットを見ているので、中身は一致しないことがある)。
   */
  const openFileMenu = (e: React.MouseEvent) => {
    if (!repoRoot) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const items = pruneMenuItems(fileOpenMenuItems(`${repoRoot}/${file.path}`), menuConfig);
    useContextMenu
      .getState()
      .open(
        rect.left,
        rect.bottom,
        items.length > 0 ? items : [{ label: '(表示できる項目がありません)', disabled: true }],
      );
  };

  return (
    <div className={cx('rv-diff')}>
      {/* 見出しより先に置いて、スクロール中も右上に残す (高さ 0 なので行は占有しない) */}
      <div className={cx('rv-diff-open')}>
        <button
          className={cx('status-btn')}
          // 削除されたファイルは作業ツリーに無いので開けない
          disabled={!repoRoot || file.status === 'D'}
          title={file.status === 'D' ? 'このファイルは削除されています' : 'このファイルを開く'}
          onClick={openFileMenu}
        >
          開く ▾
        </button>
      </div>
      <div className={cx('rv-diff-head')}>
        <span className={cx('rv-path')} title={title}>
          {title}
        </span>
        {file.added !== null && <span className={cx('rv-add')}>+{file.added}</span>}
        {file.deleted !== null && <span className={cx('rv-del')}>-{file.deleted}</span>}
      </div>

      {orphans.length > 0 && (
        <div className={cx('rv-orphans')}>
          <div className={cx('rv-orphans-title')}>
            この差分では位置を特定できないコメント ({orphans.length} 件)
          </div>
          {orphans.map((c) => (
            <CommentItem key={c.id} comment={c} readOnly={readOnly} showLocation />
          ))}
        </div>
      )}

      {loading ? (
        <div className={cx('empty-hint')}>読み込み中…</div>
      ) : !rows || rows.length === 0 ? (
        <div className={cx('empty-hint')}>
          {file.binary
            ? '表示できる差分はありません (バイナリ)'
            : file.oldPath
              ? '名前の変更のみで、内容の変更はありません'
              : '表示できる差分はありません'}
        </div>
      ) : (
        <div className={cx('rv-diff-body')}>
          {rows.map((row, i) => {
            if (row.kind === 'hunk') {
              return (
                <div key={i} className={cx('rv-hunk-head')}>
                  {row.header}
                </div>
              );
            }
            const key = row.side && row.lineNo !== null ? `${row.side}:${row.lineNo}` : '';
            const lineComments = key ? byLine.get(key) : undefined;
            const inSelection = selRange !== null && i >= selRange.from && i <= selRange.to;
            return (
              <div key={i}>
                <div
                  className={cx(
                    `rv-line ${lineClass(row.text)}${inSelection ? ' rv-selected' : ''}`,
                  )}
                  onMouseEnter={() => extendSelect(i)}
                >
                  <span
                    className={cx(`rv-gutter${readOnly || row.side === null ? '' : ' rv-gutter-active'}`)}
                    onMouseDown={(e) => startSelect(i, row, e)}
                    title={readOnly || row.side === null ? undefined : 'クリック / ドラッグでコメントを付ける'}
                  >
                    <span className={cx('rv-lineno')}>{row.oldNo ?? ''}</span>
                    <span className={cx('rv-lineno')}>{row.newNo ?? ''}</span>
                  </span>
                  <DiffLineText
                    line={row.text}
                    render={highlight(row.hunkIndex, row.lineIndex)}
                    className={cx('rv-linetext')}
                  />
                </div>
                {lineComments?.map((c) => (
                  <CommentItem key={c.id} comment={c} readOnly={readOnly} />
                ))}
                {composing && composingEnd === i && composingRange && (
                  <div className={cx('rv-form')}>
                    <div className={cx('rv-form-head')}>
                      {composingRange.start === composingRange.end
                        ? `L${composingRange.start}`
                        : `L${composingRange.start}-L${composingRange.end}`}
                      {composing.side === 'old' ? ' (変更前)' : ' (変更後)'} にコメント
                    </div>
                    <textarea
                      className={cx('rv-textarea')}
                      autoFocus
                      value={draft}
                      placeholder="コメント (改行可)"
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') cancelSelect();
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void saveDraft();
                      }}
                    />
                    <div className={cx('rv-form-buttons')}>
                      <span className={cx('rv-hint')}>Ctrl+Enter で保存</span>
                      <button className={cx('btn')} onClick={cancelSelect}>
                        キャンセル
                      </button>
                      <button className={cx('btn primary')} disabled={!draft.trim()} onClick={() => void saveDraft()}>
                        コメントする
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** コメント 1 件 (本文は素のテキストとして折り返し表示する) */
function CommentItem({
  comment,
  readOnly,
  showLocation = false,
}: {
  comment: ReviewComment;
  readOnly: boolean;
  showLocation?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.body);

  const save = async () => {
    const body = text.trim();
    if (!body) return;
    try {
      const r = await api.reviewUpdateComment(comment.id, { body });
      useReview.getState().applyComment(r.comment);
      setEditing(false);
    } catch (e) {
      toastError(e);
    }
  };

  const toggleResolved = async () => {
    try {
      const r = await api.reviewUpdateComment(comment.id, { resolved: !comment.resolved });
      useReview.getState().applyComment(r.comment);
    } catch (e) {
      toastError(e);
    }
  };

  const remove = async () => {
    if (!(await confirmDialog('コメントを削除しますか?', comment.body.slice(0, 120), true))) return;
    try {
      await api.reviewDeleteComment(comment.id);
      useReview.getState().removeComment(comment.id);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div
      className={cx(
        `rv-comment${comment.resolved ? ' rv-resolved' : ''}${comment.outdated ? ' rv-outdated' : ''}`,
      )}
    >
      <div className={cx('rv-comment-head')}>
        {showLocation && <span className={cx('rv-comment-loc')}>{rangeLabel(comment)}</span>}
        <span className={cx('rv-comment-date')}>
          {new Date(comment.updatedAt).toLocaleString('ja-JP')}
        </span>
        {comment.outdated && <span className={cx('rv-badge')}>位置ずれの可能性</span>}
        {comment.resolved && <span className={cx('rv-badge rv-badge-done')}>解決済み</span>}
        <span className={cx('rv-comment-actions')}>
          {!readOnly && !editing && (
            <>
              <button className={cx('rv-link')} onClick={toggleResolved}>
                {comment.resolved ? '未解決に戻す' : '解決済みにする'}
              </button>
              <button className={cx('rv-link')} onClick={() => setEditing(true)}>
                編集
              </button>
              <button className={cx('rv-link danger')} onClick={() => void remove()}>
                削除
              </button>
            </>
          )}
        </span>
      </div>
      {editing ? (
        <>
          <textarea
            className={cx('rv-textarea')}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setText(comment.body);
                setEditing(false);
              }
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save();
            }}
          />
          <div className={cx('rv-form-buttons')}>
            <button
              className={cx('btn')}
              onClick={() => {
                setText(comment.body);
                setEditing(false);
              }}
            >
              キャンセル
            </button>
            <button className={cx('btn primary')} disabled={!text.trim()} onClick={() => void save()}>
              保存
            </button>
          </div>
        </>
      ) : (
        <div className={cx('rv-comment-body')}>{comment.body}</div>
      )}
    </div>
  );
}
