import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { loadGitView, saveGitView } from '../../lib/gitViewMemory';
import { saveEnteredChild } from '../../lib/focusMemory';
import { useContextMenu, MenuItem } from '../../components/ContextMenu';
import { useGit, GitTab } from '../../stores/git';
import { useUi, defaultDiffToolIndex } from '../../stores/ui';
import { useExplorer } from '../../stores/explorer';
import { useSettings } from '../../stores/settings';
import { useToast, toastError } from '../../stores/toast';
import { confirmDialog } from '../../stores/dialog';
import { WorkingDiff, type FocusFile } from './WorkingDiff';
import { GitGraph } from './GitGraph';
import { openCloneDialog } from './CloneDialog';
import { openConflictResolver } from './ConflictResolver';
import { runGitCommands } from './GitCommandDialog';
import { openPushDialog, defaultPushArgs } from './PushDialog';
import { openFetchDialog } from './FetchDialog';
import { openStashDialog } from './StashDialog';
import { openAuthDialog } from './AuthDialog';
import { openCommitMessagePicker } from './CommitMessageDialog';
import { openCreateBranchDialog, openRemoteCheckoutDialog } from './BranchDialog';
import { openCommitDiff } from './DiffTab';
import type { CommitFile, CommitFilesResult, GitBranch, GitFileStatus } from '../../types';
import styles from './GitPanel.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** コミット差分ファイルのステータス表示 (A/M/D/T) */
const COMMIT_FILE_STATUS: Record<string, { label: string; cls: string }> = {
  A: { label: '追加', cls: 'st-add' },
  M: { label: '修正', cls: 'st-mod' },
  D: { label: '削除', cls: 'st-del' },
  T: { label: '種別変更', cls: 'st-mod' },
};

/** コミットの引数を組み立てる (amend + メッセージ空欄は --no-edit) */
function commitArgs(message: string, amend: boolean): string[] {
  if (amend && !message.trim()) return ['commit', '--amend', '--no-edit'];
  return amend ? ['commit', '--amend', '-m', message] : ['commit', '-m', message];
}

function statusLabel(f: GitFileStatus, staged: boolean): string {
  const c = staged ? f.index : f.workingDir;
  const map: Record<string, string> = {
    M: '変更', A: '追加', D: '削除', R: '名前変更', C: 'コピー', U: '競合', '?': '未追跡',
  };
  return map[c] ?? c;
}

/** tab は最上位タブ (コミット/ログ/ブランチ) から与えられる */
export function GitPanel({ tab }: { tab: GitTab }) {
  const { repoRoot, status, refreshStatus, mergeState, logFilter } = useGit();
  const { addRepository, repositories } = useSettings();
  const show = useToast((s) => s.show);
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  /** コミットタブ 変更一覧の選択 (フォーカス)。キーは `S:`(ステージ側)/`W:`(作業ツリー側)+path */
  const [selKeys, setSelKeys] = useState<Set<string>>(new Set());
  /** Shift 範囲選択の起点 */
  const [anchorKey, setAnchorKey] = useState<string | null>(null);
  const [commitDetail, setCommitDetail] = useState<CommitFilesResult | null>(null);
  /** 差分ファイル一覧のフィルタ (パス部分一致)。sessionStorage に保持 */
  const [fileFilter, setFileFilter] = useState('');
  /** 差分ファイル一覧のフォーカス行 (マーキングのみ。履歴には積まず sessionStorage に保持) */
  const [focusedFile, setFocusedFileState] = useState<string | null>(null);
  const setFocusedFile = (p: string | null) => {
    setFocusedFileState(p);
    if (repoRoot) saveGitView(repoRoot, { focusedFile: p });
  };
  const openMenu = useContextMenu((s) => s.open);
  /** 差分表示に使う外部ツール (config.jsonc の diffTools。index が識別子) */
  const diffTools = useUi((s) => s.diffTools);
  /** 既定の差分ツール (config の default: true)。未設定ならアプリ内の 2 ペイン差分 */
  const defaultTool = defaultDiffToolIndex(diffTools);

  const explorerPath = useExplorer((s) => s.path);

  /** コミット選択: 詳細を取得しつつ sessionStorage に保持 (タブ復帰時に復元) */
  const selectCommit = (hash: string) => {
    if (!repoRoot) return;
    // コミットが変われば以前のフォーカスは無効
    saveGitView(repoRoot, { hash, focusedFile: null });
    setFocusedFileState(null);
    api.gitCommitFiles(repoRoot, hash).then(setCommitDetail).catch(toastError);
  };

  // タブ復帰/リポジトリ切替時: 保存済みの選択コミット・ファイルフィルタ・フォーカス行を復元
  useEffect(() => {
    setCommitDetail(null);
    setFocusedFileState(null);
    if (!repoRoot) return;
    const saved = loadGitView(repoRoot);
    setFileFilter(saved?.filesFilter ?? '');
    setFocusedFileState(saved?.focusedFile ?? null);
    if (saved?.hash) {
      api.gitCommitFiles(repoRoot, saved.hash).then(setCommitDetail).catch(() => {
        saveGitView(repoRoot, { hash: null, focusedFile: null }); // 消えたコミット (reset 等) は破棄
      });
    }
  }, [repoRoot]);

  // ログの絞り込み対象が変わったら、フィルタの初期値をそのパスにする (解除時は空欄)
  const prevLogFilterRef = useRef(logFilter);
  useEffect(() => {
    if (prevLogFilterRef.current === logFilter) return; // マウント直後は sessionStorage の復元を優先
    prevLogFilterRef.current = logFilter;
    const v = logFilter?.path ?? '';
    setFileFilter(v);
    if (repoRoot) saveGitView(repoRoot, { filesFilter: v });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logFilter]);

  const changeFileFilter = (v: string) => {
    setFileFilter(v);
    if (repoRoot) saveGitView(repoRoot, { filesFilter: v });
  };

  useEffect(() => {
    if (repoRoot && tab === 'branches') {
      api.gitBranches(repoRoot).then((r) => setBranches(r.branches)).catch(toastError);
    }
  }, [repoRoot, tab, status]);

  if (!repoRoot) {
    return (
      <div className={cx("git-panel")}>
        <div className={cx("empty-hint")}>
          <p>このフォルダは Git リポジトリではありません。</p>
          <button
            className={cx("btn")}
            onClick={() =>
              void confirmDialog('Git リポジトリを作成', `${explorerPath} で git init を実行しますか?`).then(
                (ok) => {
                  if (ok) {
                    api
                      .gitInit(explorerPath)
                      .then(() => useGit.getState().checkRepo(explorerPath))
                      .then(() => show('success', 'リポジトリを作成しました'))
                      .catch(toastError);
                  }
                },
              )
            }
          >
            git init
          </button>{' '}
          <button className={cx("btn")} onClick={() => openCloneDialog(explorerPath)}>
            Git Clone…
          </button>
        </div>
      </div>
    );
  }

  const run = async (fn: () => Promise<unknown>, successMsg?: string) => {
    setBusy(true);
    try {
      await fn();
      if (successMsg) show('success', successMsg);
      await refreshStatus();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const staged = (status?.files ?? []).filter((f) => f.index !== ' ' && f.index !== '?' && f.index !== '');
  const unstaged = (status?.files ?? []).filter(
    (f) => (f.workingDir !== ' ' && f.workingDir !== '') || f.index === '?',
  );

  // 変更一覧の表示順 (ステージ済み → 変更)。範囲選択・選択操作はこの並びを基準にする
  const orderedRows = [
    ...staged.map((f) => ({ key: `S:${f.path}`, side: true as const, f })),
    ...unstaged.map((f) => ({ key: `W:${f.path}`, side: false as const, f })),
  ];

  /** 行クリック: 単一選択 / Ctrl でトグル / Shift で範囲選択 */
  const rowClick = (e: React.MouseEvent, key: string) => {
    if (e.shiftKey && anchorKey) {
      const a = orderedRows.findIndex((r) => r.key === anchorKey);
      const b = orderedRows.findIndex((r) => r.key === key);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelKeys(new Set(orderedRows.slice(lo, hi + 1).map((r) => r.key)));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setSelKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    } else {
      setSelKeys(new Set([key]));
    }
    setAnchorKey(key);
  };

  const selectSingle = (key: string) => {
    setSelKeys(new Set([key]));
    setAnchorKey(key);
  };

  /** 右クリック時のフォーカス: 未選択の行なら単一選択にし、選択済み (複数選択中も含む) なら維持 */
  const focusForMenu = (key: string) => {
    if (selKeys.has(key)) return;
    setSelKeys(new Set([key]));
    setAnchorKey(key);
  };

  const selectedStaged = orderedRows.filter((r) => r.side && selKeys.has(r.key)).map((r) => r.f.path);
  const selectedUnstaged = orderedRows.filter((r) => !r.side && selKeys.has(r.key)).map((r) => r.f.path);

  // フォーカス中ファイルの差分 (WorkingDiff 用)。消えた行のキーは自然に除外される
  const focusFiles: FocusFile[] = orderedRows
    .filter((r) => selKeys.has(r.key))
    .map((r) => ({
      path: r.f.path,
      side: r.side ? 'staged' : 'unstaged',
      untracked: !r.side && (r.f.index === '?' || r.f.workingDir === '?'),
    }));

  // コミット実行可否 (メッセージ or amend があり、ステージ済みがある or amend)
  const canCommit = !busy && (!!message.trim() || amend) && (staged.length > 0 || amend);

  /**
   * コミット (任意で続けて Push)。成功したらメッセージを履歴に保存し入力を初期化する。
   * amend でメッセージ空欄のときは --no-edit なので履歴保存はしない。
   */
  const doCommit = (push: boolean) => {
    if (!canCommit) return;
    const msg = message.trim();
    const commands = push
      ? [commitArgs(message, amend), defaultPushArgs(status ?? { branch: null, tracking: null })]
      : [commitArgs(message, amend)];
    void runGitCommands(repoRoot, commands, push ? 'Commit & Push' : 'Commit').then((ok) => {
      if (!ok) return;
      if (msg) void api.gitAddCommitMessage(msg).catch(() => {}); // 履歴保存 (失敗は無視)
      setMessage('');
      setAmend(false);
    });
  };

  /** 過去のコミットメッセージから選んで入力欄に設定する */
  const pickCommitMessage = () => {
    void openCommitMessagePicker().then((m) => {
      if (m !== null) setMessage(m);
    });
  };

  // 差分ファイル一覧: パス部分一致フィルタ → 表示上限 (config.json の commitFilesLimit)
  const filterText = fileFilter.trim().toLowerCase();
  const matchedFiles = commitDetail
    ? filterText
      ? commitDetail.files.filter((f) => f.path.toLowerCase().includes(filterText))
      : commitDetail.files
    : [];
  const filesLimit = commitDetail?.limit ?? 100;
  const shownFiles = matchedFiles.slice(0, filesLimit);

  /**
   * 外部差分ツールで開くメニュー項目 (設定の diffTools)。
   * 送るのはツールの id と比較対象だけで、コマンドはサーバ側の設定からのみ解決される。
   */
  const diffToolItems = (
    filePath: string,
    mode: 'commit' | 'staged' | 'worktree',
    hash?: string,
  ): MenuItem[] =>
    diffTools.map((t) => ({
      label: t.label,
      action: () => void api.gitDiffTool(t.id, repoRoot, filePath, mode, hash).catch(toastError),
    }));

  /** ダブルクリック時の差分表示: 既定ツールがあればそれ、無ければアプリ内の 2 ペイン差分 */
  const openDefaultCommitDiff = (f: CommitFile, detail: CommitFilesResult) => {
    if (defaultTool >= 0) {
      void api.gitDiffTool(diffTools[defaultTool].id, repoRoot, f.path, 'commit', detail.hash).catch(toastError);
      return;
    }
    openCommitDiff({
      repo: repoRoot,
      hash: detail.hash,
      path: f.path,
      subject: detail.message.split('\n')[0],
    });
  };

  const openDefaultWorkingDiff = (f: GitFileStatus, stagedSide: boolean) => {
    if (defaultTool >= 0) {
      void api
        .gitDiffTool(diffTools[defaultTool].id, repoRoot, f.path, stagedSide ? 'staged' : 'worktree')
        .catch(toastError);
      return;
    }
    // 既定の外部ツールが無ければアプリ内差分 (フォーカス) にフォールバック
    selectSingle(`${stagedSide ? 'S' : 'W'}:${f.path}`);
  };

  const isRemoteBranch = (b: GitBranch) => b.name.startsWith('remotes/');
  const isRemoteHead = (b: GitBranch) => /^remotes\/[^/]+\/HEAD$/.test(b.name);

  const checkoutBranch = (b: GitBranch) => {
    if (b.current || isRemoteBranch(b)) return;
    void runGitCommands(repoRoot, [['checkout', b.name]], 'ブランチ切替');
  };

  const checkoutRemoteBranch = (b: GitBranch) => {
    if (!isRemoteBranch(b) || isRemoteHead(b)) return;
    openRemoteCheckoutDialog(b.name);
  };

  const branchDoubleClick = (b: GitBranch) => {
    if (isRemoteBranch(b)) checkoutRemoteBranch(b);
    else checkoutBranch(b);
  };

  const branchMenu = (e: React.MouseEvent, b: GitBranch) => {
    e.preventDefault();
    const remote = isRemoteBranch(b);
    const items: MenuItem[] = remote
      ? [
          {
            label: 'チェックアウト',
            disabled: isRemoteHead(b),
            action: () => checkoutRemoteBranch(b),
          },
        ]
      : [
          {
            label: '切替',
            disabled: b.current,
            action: () => checkoutBranch(b),
          },
          {
            label: 'マージ',
            disabled: b.current,
            action: () => void runGitCommands(repoRoot, [['merge', b.name]], 'マージ'),
          },
          {
            label: '削除',
            disabled: b.current,
            danger: true,
            action: () =>
              void confirmDialog('ブランチ削除', `${b.name} を削除しますか?`, true).then((ok) => {
                if (ok) void runGitCommands(repoRoot, [['branch', '-d', b.name]], 'ブランチ削除');
              }),
          },
        ];
    openMenu(e.clientX, e.clientY, items);
  };

  /** 変更ファイル行 (コミットタブ) の右クリックメニュー */
  const workingFileMenu = (e: React.MouseEvent, f: GitFileStatus, stagedSide: boolean, key: string) => {
    e.preventDefault();
    focusForMenu(key); // 未選択なら単一選択、選択済みなら現在の選択を維持
    // メニュー操作の対象は現在の選択 (未選択の行なら focusForMenu 後のその 1 行)。
    // setState は非同期なので、この場では選択後の状態を自前で組み立てて使う
    const effKeys = selKeys.has(key) ? selKeys : new Set([key]);
    const rowsIn = orderedRows.filter((r) => effKeys.has(r.key));
    const stagePaths = rowsIn.filter((r) => !r.side).map((r) => r.f.path); // 未ステージ側 → ステージ
    const unstagePaths = rowsIn.filter((r) => r.side).map((r) => r.f.path); // ステージ側 → 解除
    const allPaths = [...new Set(rowsIn.map((r) => r.f.path))]; // 破棄対象 (ファイル単位)

    const items: MenuItem[] = [];
    // 「ステージ」「解除」はメニュー先頭。機能は「選択をステージ/解除」と同じ (現在の選択を対象)
    if (stagePaths.length > 0) {
      items.push({
        label: `ステージ${stagePaths.length > 1 ? ` (${stagePaths.length})` : ''}`,
        action: () => void run(() => api.gitStage(repoRoot, stagePaths)),
      });
    }
    if (unstagePaths.length > 0) {
      items.push({
        label: `解除${unstagePaths.length > 1 ? ` (${unstagePaths.length})` : ''}`,
        action: () => void run(() => api.gitUnstage(repoRoot, unstagePaths)),
      });
    }
    // 「破棄」はファイル差分全体 (ステージ済み含む) を破棄。未ステージ/ステージ済みどちらも同じ動作
    items.push({
      label: `破棄${allPaths.length > 1 ? ` (${allPaths.length})` : ''}`,
      danger: true,
      action: () =>
        void confirmDialog(
          '変更を破棄',
          allPaths.length === 1
            ? `${allPaths[0]} の変更をすべて破棄しますか?`
            : `選択した ${allPaths.length} 件の変更をすべて破棄しますか?`,
          true,
        ).then((ok) => {
          if (ok)
            void run(
              () => api.gitDiscard(repoRoot, allPaths, true).then(() => useExplorer.getState().refresh()),
              '破棄しました',
            );
        }),
    });
    items.push({ separator: true }, { label: '差分を表示', action: () => selectSingle(key) });
    const tools = diffToolItems(f.path, stagedSide ? 'staged' : 'worktree');
    if (tools.length > 0) items.push({ separator: true }, ...tools);
    openMenu(e.clientX, e.clientY, items);
  };

  /** 差分ファイル行の右クリックメニュー。存在チェック後に開く (場所に移動の活性判定) */
  const commitFileMenu = (e: React.MouseEvent, f: CommitFile, detail: CommitFilesResult) => {
    e.preventDefault();
    const hash = detail.hash;
    setFocusedFile(f.path); // 右クリックでもフォーカスを当てる
    const { clientX: x, clientY: y } = e;
    const abs = `${repoRoot}/${f.path}`;
    void api
      .stat(abs)
      .then(() => true)
      .catch(() => false)
      .then((exists) => {
        const short = hash.slice(0, 7);
        const items: MenuItem[] = [
          {
            label: '差分を表示',
            // Ctrl+クリック (mac は ⌘) はブラウザの別タブで開く
            action: (ev) =>
              openCommitDiff(
                { repo: repoRoot, hash, path: f.path, subject: detail.message.split('\n')[0] },
                ev.ctrlKey || ev.metaKey,
              ),
          },
          // 外部差分ツール (WinMerge / Meld など) でコミット前後を比較
          ...diffToolItems(f.path, 'commit', hash),
          { separator: true },
          {
            label: 'ログを表示',
            // Ctrl+クリック (mac は ⌘) はブラウザの別タブで開く
            action: (ev) => useGit.getState().showLogFor(f.path, true, ev.ctrlKey || ev.metaKey),
          },
          {
            label: 'ファイル場所に移動',
            disabled: !exists,
            action: (ev) => {
              const slash = abs.lastIndexOf('/');
              const dir = abs.slice(0, slash);
              // 移動先でこのファイルにフォーカスが当たるように記録してから遷移する
              // (新規タブは sessionStorage が複製されるので、window.open より先に保存する)
              saveEnteredChild(dir, f.path.slice(f.path.lastIndexOf('/') + 1), 0);
              if (ev.ctrlKey || ev.metaKey) {
                // Ctrl+クリック (mac は ⌘) はブラウザの別タブで開く
                window.open(`${location.pathname}?path=${encodeURIComponent(dir)}`, '_blank');
              } else {
                void useExplorer.getState().navigate(dir);
              }
            },
          },
          { separator: true },
          {
            label: `このバージョンに戻す (${short})`,
            action: () =>
              void confirmDialog(
                'このバージョンに戻す',
                `${f.path} を ${short} コミット後の内容に置き換えます。作業ツリーの変更は失われます。よろしいですか?`,
                true,
              ).then((ok) => {
                if (ok)
                  void runGitCommands(
                    repoRoot,
                    [['restore', '--source', hash, '--worktree', '--', f.path]],
                    'このバージョンに戻す',
                  );
              }),
          },
          {
            label: `一つ前のバージョンに戻す (${short}^)`,
            action: () =>
              void confirmDialog(
                '一つ前のバージョンに戻す',
                `${f.path} を ${short} コミット前の内容に置き換えます。作業ツリーの変更は失われます。よろしいですか?`,
                true,
              ).then((ok) => {
                if (ok)
                  void runGitCommands(
                    repoRoot,
                    [['restore', '--source', `${hash}^`, '--worktree', '--', f.path]],
                    '一つ前のバージョンに戻す',
                  );
              }),
          },
        ];
        openMenu(x, y, items);
      });
  };

  const fileRow = (f: GitFileStatus, stagedSide: boolean) => {
    const key = `${stagedSide ? 'S' : 'W'}:${f.path}`;
    const selected = selKeys.has(key);
    return (
      <div
        key={key}
        className={cx(`git-file-row${selected ? ' selected' : ''}`)}
        onClick={(e) => rowClick(e, key)}
        onDoubleClick={() => openDefaultWorkingDiff(f, stagedSide)}
        onContextMenu={(e) => workingFileMenu(e, f, stagedSide, key)}
      >
        <span
          className={cx("git-file-name")}
          title={
            `${f.path}\nクリックで選択 / Ctrl・Shift で複数選択 / 右クリックでメニュー` +
            (defaultTool >= 0 ? `\nダブルクリックで ${diffTools[defaultTool].label}` : '')
          }
        >
          <span className={cx("git-file-status")}>{statusLabel(f, stagedSide)}</span> {f.path}
        </span>
        {stagedSide ? (
          <button
            className={cx("status-btn")}
            title="ステージ解除"
            onClick={(e) => {
              e.stopPropagation();
              void run(() => api.gitUnstage(repoRoot, [f.path]));
            }}
          >
            −
          </button>
        ) : (
          <>
            <button
              className={cx("status-btn")}
              title="ステージ"
              onClick={(e) => {
                e.stopPropagation();
                void run(() => api.gitStage(repoRoot, [f.path]));
              }}
            >
              ＋
            </button>
            <button
              className={cx("status-btn danger")}
              title="変更を破棄"
              onClick={(e) => {
                e.stopPropagation();
                void confirmDialog('変更を破棄', `${f.path} の変更を破棄しますか?`, true).then((ok) => {
                  if (ok)
                    void run(
                      () => api.gitDiscard(repoRoot, [f.path]).then(() => useExplorer.getState().refresh()),
                      '破棄しました',
                    );
                });
              }}
            >
              ↩
            </button>
          </>
        )}
      </div>
    );
  };

  return (
    <div className={cx("git-panel")}>
      <div className={cx("git-header")}>
        <span className={cx("git-repo-name")} title={repoRoot}>
          🌿 {status?.branch ?? '?'}
          {status?.tracking ? ` ↑${status.ahead}↓${status.behind}` : ''}
        </span>
        {/* Fetch/Pull/Stash は即時実行せず、確認ダイアログを挟む (Push と同じフロー) */}
        <button className={cx("status-btn")} disabled={busy} onClick={openFetchDialog}>
          Fetch
        </button>
        <button
          className={cx("status-btn")}
          disabled={busy}
          onClick={() =>
            void confirmDialog('Pull', 'git pull を実行しますか?').then((ok) => {
              if (ok) void runGitCommands(repoRoot, [['pull']], 'Pull');
            })
          }
        >
          Pull
        </button>
        <button className={cx("status-btn")} disabled={busy} onClick={openPushDialog}>
          Push
        </button>
        <button className={cx("status-btn")} disabled={busy} onClick={openStashDialog}>
          Stash
        </button>
        <button
          className={cx("status-btn")}
          title="このリポジトリの認証設定 (SSH 鍵 / 資格情報ヘルパー)"
          onClick={openAuthDialog}
        >
          🔑 認証
        </button>
        {!repositories.includes(repoRoot) && (
          <button className={cx("status-btn")} onClick={() => addRepository(repoRoot)} title="サイドバーに登録">
            ★ 登録
          </button>
        )}
        <span className={cx("status-spacer")} />
      </div>

      {mergeState.inProgress && (
        <div className={cx("merge-banner")}>
          ⚠ {mergeState.inProgress === 'merge' ? 'マージ' : mergeState.inProgress === 'rebase' ? 'リベース' : 'cherry-pick'}
          が進行中です
          {mergeState.conflicted.length > 0 && ` (競合 ${mergeState.conflicted.length} 件)`}
          {mergeState.conflicted.length > 0 ? (
            <button className={cx("btn")} onClick={() => openConflictResolver('')}>
              競合を解消…
            </button>
          ) : (
            <button
              className={cx("btn")}
              onClick={() =>
                void runGitCommands(
                  repoRoot,
                  [
                    mergeState.inProgress === 'merge'
                      ? ['commit', '--no-edit']
                      : mergeState.inProgress === 'rebase'
                        ? ['rebase', '--continue']
                        : ['cherry-pick', '--continue'],
                  ],
                  '続行 (完了)',
                )
              }
            >
              完了 (コミット)
            </button>
          )}
          <button
            className={cx("btn danger")}
            onClick={() =>
              void confirmDialog('中止', '進行中の操作を中止して開始前の状態へ戻します。よろしいですか?', true).then(
                (ok) => {
                  if (ok)
                    void runGitCommands(
                      repoRoot,
                      [
                        mergeState.inProgress === 'merge'
                          ? ['merge', '--abort']
                          : mergeState.inProgress === 'rebase'
                            ? ['rebase', '--abort']
                            : ['cherry-pick', '--abort'],
                      ],
                      '中止',
                    );
                },
              )
            }
          >
            中止
          </button>
        </div>
      )}

      <div className={cx("git-body")}>
        {/* ログタブはスクロールを .graph-rows 側に持たせる (スクロール位置の保存/復元のため) */}
        <div className={cx(`git-left${tab === 'log' ? ' graph-host' : ''}`)}>
          {tab === 'changes' && (
            <>
              <div className={cx("git-section-title")}>
                ステージ済み ({staged.length})
                <span className={cx("git-section-actions")}>
                  {selectedStaged.length > 0 && (
                    <button
                      className={cx("status-btn")}
                      title="選択したファイルをステージ解除"
                      onClick={() => void run(() => api.gitUnstage(repoRoot, selectedStaged))}
                    >
                      選択を解除 ({selectedStaged.length})
                    </button>
                  )}
                  {staged.length > 0 && (
                    <button
                      className={cx("status-btn")}
                      onClick={() => void run(() => api.gitUnstage(repoRoot, staged.map((f) => f.path)))}
                    >
                      すべて解除
                    </button>
                  )}
                </span>
              </div>
              {staged.map((f) => fileRow(f, true))}
              <div className={cx("git-section-title")}>
                変更 ({unstaged.length})
                <span className={cx("git-section-actions")}>
                  {selectedUnstaged.length > 0 && (
                    <button
                      className={cx("status-btn")}
                      title="選択したファイルをステージ"
                      onClick={() => void run(() => api.gitStage(repoRoot, selectedUnstaged))}
                    >
                      選択をステージ ({selectedUnstaged.length})
                    </button>
                  )}
                  {unstaged.length > 0 && (
                    <button
                      className={cx("status-btn")}
                      onClick={() => void run(() => api.gitStage(repoRoot, unstaged.map((f) => f.path)))}
                    >
                      すべてステージ
                    </button>
                  )}
                </span>
              </div>
              {unstaged.map((f) => fileRow(f, false))}

              <div className={cx("commit-box")}>
                <div className={cx("commit-message-head")}>
                  <span className={cx("git-section-title-text")}>コミットメッセージ</span>
                  <button
                    className={cx("status-btn")}
                    title="過去のコミットメッセージから選ぶ"
                    onClick={pickCommitMessage}
                  >
                    履歴から選ぶ
                  </button>
                </div>
                <textarea
                  className={cx("commit-message")}
                  placeholder="コミットメッセージ (Ctrl+Enter でコミット)"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => {
                    // Ctrl+Enter (mac は ⌘+Enter) でコミット実行
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      doCommit(false);
                    }
                  }}
                />
                <label className={cx("amend-label")}>
                  <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} />
                  amend (直前のコミットを修正)
                </label>
                <div>
                  <button className={cx("btn primary")} disabled={!canCommit} onClick={() => doCommit(false)}>
                    Commit
                  </button>{' '}
                  <button className={cx("btn")} disabled={!canCommit} onClick={() => doCommit(true)}>
                    Commit & Push
                  </button>
                </div>
              </div>
            </>
          )}

          {tab === 'log' && (
            // コミット DAG をグラフ描画 (002.md §5)。パス絞り込み時も同じグラフ表示
            <>
              {logFilter && (
                <div className={cx("log-filter-bar")}>
                  <span className={cx("log-filter-path")} title={logFilter.path}>
                    {logFilter.path} の履歴{logFilter.follow ? ' (リネーム追跡)' : ''}
                  </span>
                  <button className={cx("status-btn")} onClick={() => useGit.getState().showLogFor('', false)}>
                    絞り込み解除
                  </button>
                </div>
              )}
              <GitGraph
                repo={repoRoot}
                selectedHash={commitDetail?.hash ?? null}
                onSelect={selectCommit}
                filter={logFilter}
              />
            </>
          )}

          {tab === 'branches' && (
            <div className={cx("git-branches")}>
              <button
                className={cx("btn")}
                onClick={openCreateBranchDialog}
              >
                ＋ ブランチ作成
              </button>
              {branches.map((b) => (
                <div
                  key={b.name}
                  className={cx("branch-row")}
                  onDoubleClick={() => branchDoubleClick(b)}
                  onContextMenu={(e) => branchMenu(e, b)}
                  title="右クリックでメニュー、ダブルクリックで操作"
                >
                  <span className={cx(b.current ? 'branch-current' : '')} title={b.name}>
                    {b.current ? '● ' : '  '}
                    {b.name}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={cx("git-right")}>
          {/* 差分ファイル一覧はログタブ選択時のみ表示 (変更/ブランチでは非表示) */}
          {tab === 'log' ? (
            commitDetail ? (
              <div className={cx("commit-detail")}>
                <div className={cx("commit-detail-head")}>
                  {/* 1 行目を見出し、2 行目以降は本文として全体を表示する */}
                  <div className={cx("commit-full-message")}>
                    <b>{commitDetail.message.split('\n')[0]}</b>
                    {commitDetail.message.includes('\n') && (
                      <div className={cx("commit-body")}>
                        {commitDetail.message.split('\n').slice(1).join('\n').replace(/^\n+|\s+$/g, '')}
                      </div>
                    )}
                  </div>
                  <div className={cx("log-meta")}>
                    {commitDetail.author} · {commitDetail.date} · {commitDetail.hash.slice(0, 12)}
                  </div>
                </div>
                <div className={cx("cf-filter-bar")}>
                  <input
                    className={cx("cf-filter")}
                    type="text"
                    placeholder="パスで絞り込み (部分一致)"
                    value={fileFilter}
                    onChange={(e) => changeFileFilter(e.target.value)}
                  />
                  <span className={cx("cf-count")}>
                    {matchedFiles.length}/{commitDetail.files.length} 件
                  </span>
                </div>
                {/* 差分ファイル一覧: ダブルクリックで 2 ペイン差分タブ、右クリックでメニュー */}
                <table className={cx("commit-files")}>
                  <thead>
                    <tr>
                      <th>ステータス</th>
                      <th>ファイル</th>
                      <th className={cx("num")}>追加</th>
                      <th className={cx("num")}>削除</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownFiles.map((f) => {
                      const st = COMMIT_FILE_STATUS[f.status] ?? { label: f.status, cls: 'st-mod' };
                      return (
                        <tr
                          key={f.path}
                          className={cx(focusedFile === f.path ? 'focused' : '')}
                          title={
                            defaultTool >= 0
                              ? `ダブルクリックで ${diffTools[defaultTool].label} / 右クリックでメニュー`
                              : 'ダブルクリックで差分を表示 / 右クリックでメニュー'
                          }
                          onClick={() => setFocusedFile(f.path)}
                          onDoubleClick={() => openDefaultCommitDiff(f, commitDetail)}
                          onContextMenu={(e) => commitFileMenu(e, f, commitDetail)}
                        >
                          <td className={cx(`cf-status ${st.cls}`)}>{st.label}</td>
                          <td className={cx("cf-path")} title={f.path}>{f.path}</td>
                          <td className={cx("num cf-added")}>{f.binary ? '–' : `+${f.added ?? 0}`}</td>
                          <td className={cx("num cf-deleted")}>{f.binary ? '–' : `−${f.deleted ?? 0}`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {commitDetail.files.length === 0 && <div className={cx("empty-hint")}>変更ファイルはありません</div>}
                {commitDetail.files.length > 0 && matchedFiles.length === 0 && (
                  <div className={cx("empty-hint")}>フィルタに一致するファイルがありません</div>
                )}
                {matchedFiles.length > shownFiles.length && (
                  <div className={cx("commit-files-hint")}>
                    表示上限 {filesLimit} 件 (該当 {matchedFiles.length} 件)。上限は config.json の
                    commitFilesLimit で変更できます
                  </div>
                )}
                <div className={cx("commit-files-hint")}>
                  {defaultTool >= 0
                    ? `行をダブルクリックすると ${diffTools[defaultTool].label} で差分を開きます (アプリ内の差分は右クリック →「差分を表示」)`
                    : '行をダブルクリックすると 2 ペインの差分を表示します'}
                </div>
              </div>
            ) : (
              <div className={cx("empty-hint")}>コミットを選択すると差分ファイル一覧を表示します</div>
            )
          ) : tab === 'changes' ? (
            focusFiles.length > 0 ? (
              <WorkingDiff repo={repoRoot} files={focusFiles} onApplied={() => void refreshStatus()} />
            ) : (
              <div className={cx("empty-hint")}>
                ファイルを選択すると差分を表示します (Ctrl / Shift で複数選択)
              </div>
            )
          ) : (
            <div className={cx("empty-hint")}>ファイルを選択すると差分を表示します</div>
          )}
        </div>
      </div>
    </div>
  );
}
