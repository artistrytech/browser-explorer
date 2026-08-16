import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { monaco, languageForPath } from '../editor/monacoSetup';
import { useGit } from '../../stores/git';
import { useRebase } from '../../stores/rebase';
import { useSettings } from '../../stores/settings';
import { useToast, toastError } from '../../stores/toast';
import { confirmDialog } from '../../stores/dialog';
import { useConflictResolver, usePendingStash, operationLabel } from '../../stores/conflict';
import { runGitCommands } from './GitCommandDialog';
import type { ConflictFile, ConflictVersions, MergeState } from '../../types';
import styles from './ConflictResolver.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * マージ競合の解消 (002.md §2):
 * 競合ファイル一覧 (§2.3) → 3-way 解消ツール (TortoiseGitMerge 相当 UI, §2.4)。
 * ブラウザ上で本体は動かないため、独自の対比ペイン + Monaco 結果ペインでエミュレートする。
 *
 * merge/rebase/cherry-pick の進行中だけでなく、stash の復元や cherry-pick --no-commit の
 * ように「進行中フラグが残らず未解決の競合だけが残る」ケース ('pending') も扱う。
 * この場合は続行 (--continue) が存在しないため、解決後はそのままコミットしてもらい、
 * 取り消しは git reset --merge で行う。
 */

// --- 競合マーカーのパース (§2.4) ---

type Segment =
  | { type: 'text'; lines: string[] }
  | { type: 'conflict'; ours: string[]; theirs: string[]; base?: string[] };

export function parseConflicts(working: string): Segment[] {
  const lines = working.split('\n');
  const segs: Segment[] = [];
  let text: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (/^<{7}(\s|$)/.test(lines[i])) {
      if (text.length > 0) {
        segs.push({ type: 'text', lines: text });
        text = [];
      }
      const ours: string[] = [];
      const base: string[] = [];
      const theirs: string[] = [];
      let mode: 'ours' | 'base' | 'theirs' = 'ours';
      i++;
      for (; i < lines.length; i++) {
        if (/^\|{7}(\s|$)/.test(lines[i])) { mode = 'base'; continue; }
        if (/^={7}$/.test(lines[i])) { mode = 'theirs'; continue; }
        if (/^>{7}(\s|$)/.test(lines[i])) { i++; break; }
        (mode === 'ours' ? ours : mode === 'base' ? base : theirs).push(lines[i]);
      }
      segs.push({ type: 'conflict', ours, theirs, base: base.length > 0 ? base : undefined });
    } else {
      text.push(lines[i]);
      i++;
    }
  }
  if (text.length > 0) segs.push({ type: 'text', lines: text });
  return segs;
}

type Resolution = null | 'ours' | 'theirs' | 'both' | 'both-rev';

/** 採用状態から統合結果テキストを組み立てる。未解決ブロックは標準マーカーで残す */
function buildResult(segs: Segment[], res: Resolution[]): string {
  const out: string[] = [];
  let ci = 0;
  for (const seg of segs) {
    if (seg.type === 'text') {
      out.push(...seg.lines);
      continue;
    }
    const r = res[ci++];
    if (r === 'ours') out.push(...seg.ours);
    else if (r === 'theirs') out.push(...seg.theirs);
    else if (r === 'both') out.push(...seg.ours, ...seg.theirs);
    else if (r === 'both-rev') out.push(...seg.theirs, ...seg.ours);
    else {
      out.push('<<<<<<< 自分 (HEAD)', ...seg.ours, '=======', ...seg.theirs, '>>>>>>> 相手');
    }
  }
  return out.join('\n');
}

// --- 競合ファイル一覧 (§2.3) ---

function ConflictList() {
  const repoRoot = useGit((s) => s.repoRoot)!;
  const mergeState = useGit((s) => s.mergeState);
  // アプリ起点のリベース中は、続行/中止をセッション経由 (バックアップ管理付き) に差し替える
  const rebaseSession = useRebase((s) => s.session);
  const isRebaseSession = rebaseSession?.repo === repoRoot && mergeState.inProgress === 'rebase';
  const { dir, sticky, openFile, close } = useConflictResolver();
  // 進行中の git 操作がない競合 (stash 復元 / cherry-pick --no-commit)。
  // 競合が 0 件になっても表示を保つため、開いた時点の判定 (sticky) を使う
  const isPending = sticky && !mergeState.inProgress;
  const pendingStash = usePendingStash((s) => s.pending);
  const stashToDrop = pendingStash?.repo === repoRoot ? pendingStash : null;
  const [files, setFiles] = useState<ConflictFile[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () => {
    api
      .gitConflicts(repoRoot, dir || undefined)
      .then((r) => {
        setFiles(r.files);
        setTotal((t) => (t === null ? r.files.length : Math.max(t, r.files.length)));
      })
      .catch(toastError);
  };

  useEffect(reload, [repoRoot, dir, mergeState.conflicted.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown>, msg?: string) => {
    setBusy(true);
    try {
      await fn();
      if (msg) useToast.getState().show('success', msg);
      await useGit.getState().refreshStatus();
      reload();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const takeAll = (side: 'ours' | 'theirs') =>
    void confirmDialog(
      side === 'ours' ? 'すべて自分 (ours) を採用' : 'すべて相手 (theirs) を採用',
      `残り ${files.length} 件の競合をすべて ${side === 'ours' ? '自分側' : '相手側'} で解決します。よろしいですか?`,
    ).then((ok) => {
      if (ok) void run(() => api.gitConflictTake(repoRoot, files.map((f) => f.path), side), '解決しました');
    });

  /**
   * 'pending' の取り消し: 進行中の操作がないので --abort は使えない。
   * git reset --merge で、適用された変更と解決結果を捨てて HEAD の状態に戻す
   * (stash から復元した場合、退避そのものは残るのでやり直せる)。
   */
  const resetPending = () =>
    void confirmDialog(
      '適用を取り消す',
      '適用された変更と競合の解決結果を取り消し、HEAD の状態に戻します (git reset --merge)。\n' +
        'stash から復元した場合、退避は残るのでやり直せます。よろしいですか?',
      true,
    ).then((ok) => {
      if (!ok) return;
      close();
      void runGitCommands(repoRoot, [['reset', '--merge']], '競合の取り消し');
    });

  /**
   * 競合で中断した pop の後始末。
   * 控えた ref は他の stash 操作でずれ得るので、ハッシュで実際の位置を引き直してから削除する。
   */
  const dropStash = async () => {
    if (!stashToDrop) return;
    setBusy(true);
    let hit: string[] | undefined;
    try {
      const r = await api.gitExec(repoRoot, ['stash', 'list', '--format=%gd%x1f%H']);
      hit = r.output
        .split('\n')
        .map((l) => l.trim().split('\x1f'))
        .find(([, hash]) => hash === stashToDrop.hash);
    } catch (e) {
      toastError(e);
      setBusy(false);
      return;
    }
    setBusy(false);
    usePendingStash.getState().setPendingStash(null);
    if (!hit) {
      useToast.getState().show('info', '対象の退避は既に削除されています');
      return;
    }
    close();
    void runGitCommands(repoRoot, [['stash', 'drop', hit[0]]], 'Stash の削除');
  };

  const resolvedCount = total !== null ? total - files.length : 0;
  const opName = operationLabel(mergeState.inProgress);

  return (
    <>
      <div className={cx("conflict-head")}>
        <b>競合を解消{dir ? `: ${dir}/` : ''} ({files.length} 件)</b>
        {isPending && (
          <span className={cx("merge-hint")}>
            進行中の git 操作はありません (stash の復元 / cherry-pick --no-commit など)
          </span>
        )}
        <span className={cx("status-spacer")} />
        <button className={cx("dialog-close")} onClick={close} title="閉じる">✕</button>
      </div>
      <div className={cx("conflict-list")}>
        {files.map((f) => (
          <button key={f.path} className={cx("conflict-row")} onClick={() => openFile(f.path)}>
            <span className={cx("ov-conflicted")}>⚠</span>
            <span className={cx("conflict-path")}>{f.path}</span>
            <span className={cx("conflict-kind")}>
              {f.kind}
              {f.binary ? ' (binary)' : ''}
            </span>
          </button>
        ))}
        {resolvedCount > 0 && <div className={cx("conflict-resolved-note")}>✔ {resolvedCount} 件 解決済み</div>}
        {files.length === 0 && (
          <div className={cx("empty-hint")}>
            {mergeState.inProgress || isPending ? 'すべての競合が解決されました。' : '競合はありません。'}
          </div>
        )}
      </div>
      <div className={cx("conflict-actions")}>
        <button className={cx("btn")} disabled={busy || files.length === 0} onClick={() => takeAll('ours')}>
          すべて自分 (ours) を採用
        </button>
        <button className={cx("btn")} disabled={busy || files.length === 0} onClick={() => takeAll('theirs')}>
          すべて相手 (theirs) を採用
        </button>
        {isRebaseSession && files.length === 0 && (
          <button
            className={cx("btn primary")}
            disabled={busy}
            onClick={() =>
              void useRebase.getState().continueRebase(repoRoot).then((r) => {
                // 完了 or さらに次の競合が無ければツールを閉じる (残っていれば一覧に留まる)
                if (!r || r.phase === 'done' || r.phase === 'desynced') {
                  useConflictResolver.getState().close();
                }
              })
            }
          >
            リベースを続行
          </button>
        )}
        {!isRebaseSession && mergeState.inProgress && files.length === 0 && (
          <button
            className={cx("btn primary")}
            disabled={busy}
            onClick={() =>
              void run(() => api.gitMergeContinue(repoRoot), `${opName}を完了しました`).then(() =>
                useConflictResolver.getState().close(),
              )
            }
          >
            {opName}を完了 (コミット)
          </button>
        )}
        {/* pending は続行する操作が無い。解決結果はステージ済みなので、あとは通常のコミット */}
        {isPending && files.length === 0 && (
          <>
            <span className={cx("conflict-note")}>
              解決結果はステージ済みです。コミットタブでコミットしてください。
            </span>
            {stashToDrop && (
              <button
                className={cx("btn")}
                disabled={busy}
                onClick={() => void dropStash()}
                title={`${stashToDrop.ref}: ${stashToDrop.message}`}
              >
                残っている退避 ({stashToDrop.ref}) を削除
              </button>
            )}
            <button className={cx("btn primary")} disabled={busy} onClick={close}>
              閉じる
            </button>
          </>
        )}
        <span className={cx("status-spacer")} />
        <span className={cx("conflict-remaining")}>残り: {files.length} 件</span>
        {isRebaseSession && (
          <button
            className={cx("btn danger")}
            disabled={busy}
            onClick={() =>
              void confirmDialog(
                'リベースを中止',
                '進行中のリベースを中止します。途中経過は新しいバックアップに退避し、開始前のバックアップから復元します。よろしいですか?',
                true,
              ).then((ok) => {
                if (ok)
                  void useRebase.getState().abort(repoRoot).then(() =>
                    useConflictResolver.getState().close(),
                  );
              })
            }
          >
            リベースを中止
          </button>
        )}
        {!isRebaseSession && mergeState.inProgress && (
          <button
            className={cx("btn danger")}
            disabled={busy}
            onClick={() =>
              void confirmDialog(`${opName}を中止`, '進行中の操作を中止して開始前の状態へ戻します。よろしいですか?', true).then(
                (ok) => {
                  if (ok)
                    void run(() => api.gitMergeAbort(repoRoot), '中止しました').then(() =>
                      useConflictResolver.getState().close(),
                    );
                },
              )
            }
          >
            {opName}を中止
          </button>
        )}
        {isPending && (
          <button className={cx("btn danger")} disabled={busy} onClick={resetPending}>
            適用を取り消す
          </button>
        )}
      </div>
    </>
  );
}

// --- 3-way マージ解消ツール (§2.4) ---

function sideLabel(mergeKind: MergeState['inProgress']): { mine: string; theirs: string } {
  // 進行中の操作がない場合 (stash 復元 / cherry-pick --no-commit) は、
  // theirs = いま適用しようとしている変更
  const source =
    mergeKind === 'merge'
      ? 'MERGE_HEAD'
      : mergeKind === 'cherry-pick'
        ? 'CHERRY_PICK_HEAD'
        : mergeKind === 'rebase'
          ? 'rebase'
          : '適用した変更';
  return { mine: '自分 (Mine / HEAD)', theirs: `相手 (Theirs / ${source})` };
}

function MergeTool({ file }: { file: string }) {
  const repoRoot = useGit((s) => s.repoRoot)!;
  const mergeKind = useGit((s) => s.mergeState.inProgress);
  const theme = useSettings((s) => s.settings.theme);
  const { backToList } = useConflictResolver();
  const [versions, setVersions] = useState<ConflictVersions | null>(null);
  const [segs, setSegs] = useState<Segment[]>([]);
  const [res, setRes] = useState<Resolution[]>([]);
  const [busy, setBusy] = useState(false);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const minePaneRef = useRef<HTMLDivElement>(null);
  const theirsPaneRef = useRef<HTMLDivElement>(null);
  const syncingScroll = useRef(false);

  useEffect(() => {
    api
      .gitConflictVersions(repoRoot, file)
      .then((v) => {
        setVersions(v);
        const parsed = parseConflicts(v.working ?? '');
        setSegs(parsed);
        setRes(parsed.filter((s) => s.type === 'conflict').map(() => null));
      })
      .catch(toastError);
  }, [repoRoot, file]);

  const isTextTool =
    versions !== null && !versions.binary && versions.ours !== null && versions.theirs !== null;

  // 結果ペイン (編集可能 / Monaco, §2.4)
  useEffect(() => {
    if (!isTextTool || !editorHostRef.current || editorRef.current) return;
    const editor = monaco.editor.create(editorHostRef.current, {
      automaticLayout: true,
      minimap: { enabled: false },
      theme: theme === 'dark' ? 'vs-dark' : 'vs',
      value: buildResult(segs, res),
      language: languageForPath(file),
    });
    editorRef.current = editor;
    return () => {
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTextTool]);

  // ブロック採用 → 結果を再生成 (手編集は失われるため注意書きを表示)
  const adopt = (conflictIdx: number, r: Resolution) => {
    const next = res.map((v, i) => (i === conflictIdx ? r : v));
    setRes(next);
    editorRef.current?.setValue(buildResult(segs, next));
  };

  const adoptAll = (r: Resolution) => {
    const next = res.map(() => r);
    setRes(next);
    editorRef.current?.setValue(buildResult(segs, next));
  };

  const unresolved = res.filter((r) => r === null).length;

  const jumpToConflict = (dir: 1 | -1) => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    const matches = model.findMatches('^<{7}', false, true, false, null, false);
    if (matches.length === 0) return;
    const cur = editor.getPosition()?.lineNumber ?? 0;
    const lines = matches.map((m) => m.range.startLineNumber);
    const next =
      dir === 1 ? (lines.find((l) => l > cur) ?? lines[0]) : ([...lines].reverse().find((l) => l < cur) ?? lines[lines.length - 1]);
    editor.revealLineInCenter(next);
    editor.setPosition({ lineNumber: next, column: 1 });
    editor.focus();
  };

  const markResolved = async () => {
    const editor = editorRef.current;
    const content = editor ? editor.getValue() : null;
    if (content === null) return;
    if (/^<{7}(\s|$)/m.test(content)) {
      const ok = await confirmDialog(
        '競合マーカーが残っています',
        '結果に競合マーカー (<<<<<<<) が残っています。このまま解決としてマークしますか?',
        true,
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.gitConflictResolve(repoRoot, file, content);
      useToast.getState().show('success', `${file} を解決としてマークしました`);
      await useGit.getState().refreshStatus();
      backToList();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const take = async (side: 'ours' | 'theirs') => {
    setBusy(true);
    try {
      await api.gitConflictTake(repoRoot, [file], side);
      useToast.getState().show('success', '解決しました');
      await useGit.getState().refreshStatus();
      backToList();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const labels = sideLabel(mergeKind);

  // 上段ペイン: 片側バージョンを対比表示。競合ブロックはハイライト + 採用ボタン (§2.4)
  const renderPane = (side: 'ours' | 'theirs') => {
    let ci = -1;
    return segs.map((seg, i) => {
      if (seg.type === 'text') {
        return (
          <pre key={i} className={cx("merge-text")}>
            {seg.lines.join('\n')}
          </pre>
        );
      }
      ci++;
      const idx = ci;
      const lines = side === 'ours' ? seg.ours : seg.theirs;
      const r = res[idx];
      const adopted = r === side || r === 'both' || r === 'both-rev';
      return (
        <div key={i} className={cx(`merge-conflict${r !== null ? (adopted ? ' adopted' : ' rejected') : ''}`)}>
          <div className={cx("merge-conflict-bar")}>
            <span className={cx("merge-conflict-no")}>#{idx + 1}</span>
            {side === 'ours' ? (
              <>
                <button className={cx("status-btn")} onClick={() => adopt(idx, 'ours')}>◀ この塊を採用</button>
                <button className={cx("status-btn")} onClick={() => adopt(idx, 'both')}>両方採用 (自分→相手)</button>
                <button className={cx("status-btn")} onClick={() => adopt(idx, 'both-rev')}>両方 (相手→自分)</button>
              </>
            ) : (
              <button className={cx("status-btn")} onClick={() => adopt(idx, 'theirs')}>この塊を採用 ▶</button>
            )}
            {r !== null && (
              <button className={cx("status-btn")} onClick={() => adopt(idx, null)} title="未解決に戻す">↺</button>
            )}
          </div>
          <pre className={cx("merge-conflict-body")}>{lines.join('\n') || '(空)'}</pre>
        </div>
      );
    });
  };

  const syncScroll = (from: 'mine' | 'theirs') => {
    if (syncingScroll.current) return;
    syncingScroll.current = true;
    const src = from === 'mine' ? minePaneRef.current : theirsPaneRef.current;
    const dst = from === 'mine' ? theirsPaneRef.current : minePaneRef.current;
    if (src && dst) dst.scrollTop = src.scrollTop;
    requestAnimationFrame(() => (syncingScroll.current = false));
  };

  if (!versions) {
    return (
      <>
        <div className={cx("conflict-head")}>
          <button className={cx("btn")} onClick={backToList}>← 一覧へ</button>
          <b>{file}</b>
        </div>
        <div className={cx("empty-hint")}>読み込み中…</div>
      </>
    );
  }

  // バイナリ / 片側削除: 3-way 不可 → 片側採用のみ (§2.7)
  if (!isTextTool) {
    const oursMissing = versions.ours === null;
    const theirsMissing = versions.theirs === null;
    return (
      <>
        <div className={cx("conflict-head")}>
          <button className={cx("btn")} onClick={backToList}>← 一覧へ</button>
          <b>{file} の競合を解消</b>
          <span className={cx("conflict-kind")}>{versions.kind}{versions.binary ? ' (binary)' : ''}</span>
        </div>
        <div className={cx("conflict-binary")}>
          <p>
            {versions.binary
              ? 'バイナリファイルのため 3-way マージはできません。採用する側を選択してください。'
              : oursMissing
                ? '自分側 (HEAD) はこのファイルを削除しています。'
                : theirsMissing
                  ? '相手側はこのファイルを削除しています。'
                  : '採用する側を選択してください。'}
          </p>
          <div>
            <button className={cx("btn")} disabled={busy} onClick={() => void take('ours')}>
              {oursMissing ? '削除する (自分を採用)' : '自分 (ours) を採用'}
            </button>{' '}
            <button className={cx("btn")} disabled={busy} onClick={() => void take('theirs')}>
              {theirsMissing ? '削除する (相手を採用)' : '相手 (theirs) を採用'}
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className={cx("conflict-head")}>
        <button className={cx("btn")} onClick={backToList}>← 一覧へ</button>
        <b>{file} の競合を解消</b>
        <span className={cx("conflict-kind")}>{versions.kind}</span>
        <span className={cx("status-spacer")} />
        <span className={cx("merge-hint")}>ブロック採用で結果を再生成します (結果ペインの手編集はその際に失われます)</span>
      </div>
      <div className={cx("merge-top")}>
        <div className={cx("merge-pane")} ref={minePaneRef} onScroll={() => syncScroll('mine')}>
          <div className={cx("merge-pane-title mine")}>{labels.mine}</div>
          {renderPane('ours')}
        </div>
        <div className={cx("merge-pane")} ref={theirsPaneRef} onScroll={() => syncScroll('theirs')}>
          <div className={cx("merge-pane-title theirs")}>{labels.theirs}</div>
          {renderPane('theirs')}
        </div>
      </div>
      <div className={cx("merge-result-title")}>統合結果 (編集可能 / Monaco)</div>
      <div className={cx("merge-result")} ref={editorHostRef} />
      <div className={cx("conflict-actions")}>
        <span className={cx("conflict-remaining")}>未解決 {unresolved}/{res.length}</span>
        <button className={cx("status-btn")} onClick={() => jumpToConflict(-1)} title="前の未解決競合">▲ 前</button>
        <button className={cx("status-btn")} onClick={() => jumpToConflict(1)} title="次の未解決競合">▼ 次</button>
        <span className={cx("status-spacer")} />
        <button className={cx("btn")} disabled={busy} onClick={() => adoptAll('ours')}>自分を全採用</button>
        <button className={cx("btn")} disabled={busy} onClick={() => adoptAll('theirs')}>相手を全採用</button>
        <button className={cx("btn primary")} disabled={busy} onClick={() => void markResolved()}>
          解決としてマーク
        </button>
      </div>
    </>
  );
}

export function ConflictResolver() {
  const { open, file, sticky, close } = useConflictResolver();
  const repoRoot = useGit((s) => s.repoRoot);
  const inProgress = useGit((s) => s.mergeState.inProgress);

  // 進行状態が解消されたらツールを自動的に閉じる (§2.7)。
  // 'pending' (sticky) で開いた場合は続行の概念がなく、解決後に案内や後始末
  // (残った退避の削除) を見せる必要があるため、閉じるのはユーザー操作に任せる
  useEffect(() => {
    if (open && !inProgress && !sticky) close();
  }, [open, inProgress, sticky, close]);

  if (!open || !repoRoot) return null;

  return (
    <div className={cx("conflict-overlay")}>
      <div className={cx("conflict-window")}>{file ? <MergeTool file={file} /> : <ConflictList />}</div>
    </div>
  );
}
