import { useEffect, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { api } from '../../api/client';
import { loadGitView, saveGitView } from '../../lib/gitViewMemory';
import { loadLogLayout, saveLogLayout, type LogLayoutDir } from '../../lib/logLayoutMemory';
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
import { openCreateBranchDialog, openRemoteCheckoutDialog, openRenameBranchDialog } from './BranchDialog';
import { openRebaseDialog } from './Rebase';
import { openDiscardAllDialog } from './DiscardAllDialog';
import { openCommitDiff } from './DiffTab';
import { CommitFileDiff } from './CommitFileDiff';
import { useRebase } from '../../stores/rebase';
import type { CommitFile, CommitFilesResult, GitBranch, GitFileStatus, RebaseBackup } from '../../types';
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

interface BranchTreeNode {
  key: string;
  label: string;
  branch: GitBranch | null;
  children: BranchTreeNode[];
}

interface MutableBranchTreeNode extends BranchTreeNode {
  childMap: Map<string, MutableBranchTreeNode>;
}

function createBranchTreeNode(key: string, label: string): MutableBranchTreeNode {
  return { key, label, branch: null, children: [], childMap: new Map() };
}

function branchTreeParts(branch: GitBranch): string[] {
  const parts = branch.name.split('/').filter(Boolean);
  return branch.name.startsWith('remotes/') ? parts.slice(1) : parts;
}

function buildBranchTree(branches: GitBranch[], keyPrefix: string): BranchTreeNode[] {
  const root = new Map<string, MutableBranchTreeNode>();

  for (const branch of branches) {
    const parts = branchTreeParts(branch);
    if (parts.length === 0) continue;
    let level = root;
    let node: MutableBranchTreeNode | undefined;
    let key = '';

    parts.forEach((part, index) => {
      key = key ? `${key}/${part}` : part;
      node = level.get(part);
      if (!node) {
        node = createBranchTreeNode(`${keyPrefix}:${key}`, part);
        level.set(part, node);
      }
      if (index === parts.length - 1) node.branch = branch;
      level = node.childMap;
    });
  }

  const finalize = (nodes: Iterable<MutableBranchTreeNode>): BranchTreeNode[] =>
    [...nodes]
      .sort((a, b) => {
        const aIsFolder = a.branch === null;
        const bIsFolder = b.branch === null;
        if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
        return a.label.localeCompare(b.label);
      })
      .map((node) => ({
        key: node.key,
        label: node.label,
        branch: node.branch,
        children: finalize(node.childMap.values()),
      }));

  return finalize(root.values());
}

/** 折りたたみを反映した「画面に見えている行」の並び (キーボード移動の順序) */
function visibleBranchRows(
  trees: BranchTreeNode[][],
  collapsed: Set<string>,
): { node: BranchTreeNode; depth: number }[] {
  const out: { node: BranchTreeNode; depth: number }[] = [];
  const walk = (nodes: BranchTreeNode[], depth: number) => {
    for (const node of nodes) {
      out.push({ node, depth });
      if (!node.branch && !collapsed.has(node.key)) walk(node.children, depth + 1);
    }
  };
  for (const tree of trees) walk(tree, 0);
  return out;
}

function branchSyncLabel(branch: GitBranch): string {
  if (branch.ahead === undefined || branch.behind === undefined) return '';
  return ` ↑${branch.ahead}↓${branch.behind}`;
}

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
  const [collapsedBranchGroups, setCollapsedBranchGroups] = useState<Set<string>>(new Set());
  /** ブランチ一覧の選択 (フォーカス) 行。BranchTreeNode.key。sessionStorage に保持 */
  const [selectedBranchKey, setSelectedBranchKeyState] = useState<string | null>(null);
  const branchListRef = useRef<HTMLDivElement>(null);
  const commitMessageRef = useRef<HTMLTextAreaElement>(null);
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
  /** ログタブの分割レイアウト。方向は再描画が要るので state、サイズはドラッグ中に頻繁に変わるので ref */
  const [initialLogLayout] = useState(loadLogLayout);
  const [logDir, setLogDir] = useState<LogLayoutDir>(initialLogLayout.dir);
  const logSizes = useRef(initialLogLayout.sizes);
  const openMenu = useContextMenu((s) => s.open);
  /** 差分表示に使う外部ツール (config.jsonc の diffTools。index が識別子) */
  const diffTools = useUi((s) => s.diffTools);
  /** 既定の差分ツール (config の default: true)。未設定ならアプリ内の 2 ペイン差分 */
  const defaultTool = defaultDiffToolIndex(diffTools);

  const explorerPath = useExplorer((s) => s.path);

  const setSelectedBranchKey = (key: string | null) => {
    setSelectedBranchKeyState(key);
    if (repoRoot) saveGitView(repoRoot, { selectedBranchKey: key });
  };

  /** ドラッグ確定時にだけ sessionStorage へ書き出す (ドラッグ中は ref の更新のみ) */
  const persistLogLayout = () => saveLogLayout({ dir: logDir, sizes: logSizes.current });

  const changeLogDir = (dir: LogLayoutDir) => {
    setLogDir(dir);
    saveLogLayout({ dir, sizes: logSizes.current });
  };

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
    setCollapsedBranchGroups(new Set(saved?.collapsedBranchGroups ?? []));
    setSelectedBranchKeyState(saved?.selectedBranchKey ?? null);
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
    const el = commitMessageRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [message, tab]);

  useEffect(() => {
    if (repoRoot && tab === 'branches') {
      api.gitBranches(repoRoot).then((r) => setBranches(r.branches)).catch(toastError);
    }
  }, [repoRoot, tab, status]);

  // キーボードで選択を動かしたとき、その行が隠れていればスクロールして見せる
  useEffect(() => {
    if (tab !== 'branches' || !selectedBranchKey) return;
    branchListRef.current
      ?.querySelector(`[data-branch-key="${CSS.escape(selectedBranchKey)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedBranchKey, tab]);

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

  const currentBranch = status?.branch ?? null;
  const isRemoteBranch = (b: GitBranch) => b.name.startsWith('remotes/');
  const isRemoteHead = (b: GitBranch) => /^remotes\/[^/]+\/HEAD$/.test(b.name);

  /** ローカルブランチへの切替。作業ツリーに影響する操作なので確認を挟む */
  const checkoutBranch = (b: GitBranch) => {
    if (b.current || isRemoteBranch(b)) return;
    void confirmDialog(
      'ブランチ切替',
      `${currentBranch ?? 'HEAD'} から ${b.name} へ切り替えますか?`,
    ).then((ok) => {
      if (ok) void runGitCommands(repoRoot, [['checkout', b.name]], 'ブランチ切替');
    });
  };

  const checkoutRemoteBranch = (b: GitBranch) => {
    if (!isRemoteBranch(b) || isRemoteHead(b)) return;
    openRemoteCheckoutDialog(b.name);
  };

  const copyBranchName = async (name: string) => {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(name);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = name;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      show('success', 'ブランチ名をコピーしました');
    } catch (e) {
      toastError(e);
    }
  };

  const branchDoubleClick = (b: GitBranch) => {
    if (isRemoteBranch(b)) checkoutRemoteBranch(b);
    else checkoutBranch(b);
  };

  /** ブランチ行のメニュー。マウスダウンで選択済みなので、対象は常に選択行 (key) の分岐 */
  const branchMenu = (e: React.MouseEvent, b: GitBranch, key: string) => {
    e.preventDefault();
    setSelectedBranchKey(key);
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
            label: 'リベース (現在のブランチをこの上に移動)',
            disabled: b.current || !currentBranch,
            action: () => currentBranch && openRebaseDialog(b.name, currentBranch),
          },
          {
            label: '名前変更',
            action: () => openRenameBranchDialog(b.name),
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

  /** ヘッダの「ツール」メニュー: 変更の一括破棄 / リベース用バックアップ (backup/rebase/*) の削除 */
  const openToolsMenu = (e: React.MouseEvent) => {
    const { clientX: x, clientY: y } = e;
    const deleteItem = (bk: RebaseBackup): MenuItem => ({
      label: `🗑 ${bk.name}`,
      danger: true,
      action: () =>
        void confirmDialog(
          'バックアップブランチを削除',
          `${bk.name}\n(${bk.hash} ${bk.date} ${bk.subject}) を削除しますか?`,
          true,
        ).then((ok) => {
          if (!ok) return;
          void api
            .gitRebaseBackupDelete(repoRoot, bk.name)
            .then(() => {
              show('success', 'バックアップブランチを削除しました');
              if (tab === 'branches')
                api.gitBranches(repoRoot).then((r) => setBranches(r.branches)).catch(toastError);
            })
            .catch(toastError);
        }),
    });
    const buildMenu = (backupItems: MenuItem[]): MenuItem[] => [
      {
        label: '変更をすべて破棄…',
        danger: true,
        action: () => openDiscardAllDialog(),
      },
      { separator: true },
      {
        label: 'リベースのバックアップを削除',
        submenu: backupItems,
      },
    ];
    void api
      .gitRebaseBackups(repoRoot)
      .then(({ backups }) => {
        const backupItems =
          backups.length > 0
            ? backups.map(deleteItem)
            : [{ label: '(バックアップはありません)', disabled: true }];
        openMenu(x, y, buildMenu(backupItems));
      })
      .catch(() => openMenu(x, y, buildMenu([{ label: '(取得に失敗しました)', disabled: true }])));
  };

  const toggleBranchGroup = (key: string) => {
    setCollapsedBranchGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveGitView(repoRoot, { collapsedBranchGroups: [...next] });
      return next;
    });
  };

  const localBranches = branches.filter((b) => !isRemoteBranch(b));
  const remoteBranches = branches.filter((b) => isRemoteBranch(b));
  const localBranchTree = buildBranchTree(localBranches, 'local');
  const remoteBranchTree = buildBranchTree(remoteBranches, 'remote');
  /** 表示順の行 (キーボード移動用)。ローカル → リモートの順で並ぶ */
  const branchRows = visibleBranchRows([localBranchTree, remoteBranchTree], collapsedBranchGroups);

  const moveBranchSelection = (delta: number) => {
    if (branchRows.length === 0) return;
    const idx = branchRows.findIndex((r) => r.node.key === selectedBranchKey);
    const next =
      idx < 0
        ? delta > 0
          ? 0
          : branchRows.length - 1
        : Math.min(branchRows.length - 1, Math.max(0, idx + delta));
    setSelectedBranchKey(branchRows[next].node.key);
  };

  /** ↑↓ で選択移動、Enter で切替 (フォルダは開閉)、←→ でフォルダの折りたたみ/展開 */
  const branchListKeyDown = (e: React.KeyboardEvent) => {
    const idx = branchRows.findIndex((r) => r.node.key === selectedBranchKey);
    const row = idx >= 0 ? branchRows[idx] : null;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveBranchSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveBranchSelection(-1);
    } else if (e.key === 'Enter') {
      if (!row) return;
      e.preventDefault();
      if (row.node.branch) branchDoubleClick(row.node.branch);
      else toggleBranchGroup(row.node.key);
    } else if (e.key === 'ArrowRight') {
      if (!row || row.node.branch) return;
      e.preventDefault();
      if (collapsedBranchGroups.has(row.node.key)) toggleBranchGroup(row.node.key);
      else if (row.node.children.length > 0) setSelectedBranchKey(row.node.children[0].key);
    } else if (e.key === 'ArrowLeft') {
      if (!row) return;
      e.preventDefault();
      if (!row.node.branch && !collapsedBranchGroups.has(row.node.key)) {
        toggleBranchGroup(row.node.key);
        return;
      }
      // 葉 / 折りたたみ済みフォルダは親フォルダ (直前の浅い行) へ戻る
      for (let i = idx - 1; i >= 0; i--) {
        if (branchRows[i].depth < row.depth) {
          setSelectedBranchKey(branchRows[i].node.key);
          return;
        }
      }
    }
  };

  const renderBranchSection = (title: string, count: number, tree: BranchTreeNode[]) => (
    <div className={cx("branch-section")}>
      <div className={cx("branch-section-title")}>
        {title} ({count})
      </div>
      {tree.length > 0 ? (
        tree.map((node) => renderBranchNode(node))
      ) : (
        <div className={cx("branch-empty")}>ブランチはありません</div>
      )}
    </div>
  );

  const renderBranchNode = (node: BranchTreeNode, depth = 0): React.ReactNode => {
    const indent = 4 + depth * 16;
    const selected = selectedBranchKey === node.key;
    if (node.branch) {
      const b = node.branch;
      return (
        <div
          key={node.key}
          data-branch-key={node.key}
          className={cx(`branch-row branch-leaf${selected ? ' selected' : ''}`)}
          style={{ paddingLeft: `${indent}px` }}
          // マウスダウンで選択 (右クリックでもここで選択されるのでメニューは選択行が対象)
          onMouseDown={() => setSelectedBranchKey(node.key)}
          onDoubleClick={() => branchDoubleClick(b)}
          onContextMenu={(e) => branchMenu(e, b, node.key)}
          title="クリックで選択、右クリックでメニュー、ダブルクリックで操作"
        >
          <span className={cx(`branch-name${b.current ? ' branch-current' : ''}`)} title={b.name}>
            {b.current ? '● ' : '  '}
            {node.label}
            {branchSyncLabel(b)}
          </span>
          <button
            className={cx("branch-copy")}
            title="ブランチ名をコピー"
            aria-label={`${b.name} をコピー`}
            onClick={(e) => {
              e.stopPropagation();
              void copyBranchName(b.name);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
          >
            <span className={cx("branch-copy-icon")} aria-hidden="true" />
          </button>
        </div>
      );
    }

    const collapsed = collapsedBranchGroups.has(node.key);
    return (
      <div key={node.key}>
        <div
          data-branch-key={node.key}
          className={cx(`branch-row branch-folder${selected ? ' selected' : ''}`)}
          style={{ paddingLeft: `${indent}px` }}
          onMouseDown={() => setSelectedBranchKey(node.key)}
          onClick={() => toggleBranchGroup(node.key)}
          onContextMenu={(e) => e.preventDefault()}
          title={collapsed ? 'クリックで展開' : 'クリックで折りたたみ'}
        >
          <button className={cx("branch-toggle")} tabIndex={-1}>
            {collapsed ? '▶' : '▼'}
          </button>
          <span className={cx("branch-folder-name")} title={node.key}>{node.label}</span>
        </div>
        {!collapsed && node.children.map((child) => renderBranchNode(child, depth + 1))}
      </div>
    );
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

  // --- ログタブの 3 ペイン (グラフ / コミット詳細 / 差分プレビュー) ---

  const logGraphPane = (
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
  );

  const commitDetailPane = commitDetail ? (
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
      {/* 差分ファイル一覧: クリックでプレビュー、ダブルクリックで 2 ペイン差分タブ、右クリックでメニュー */}
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
                    ? `クリックでプレビュー / ダブルクリックで ${diffTools[defaultTool].label} / 右クリックでメニュー`
                    : 'クリックでプレビュー / ダブルクリックで差分を表示 / 右クリックでメニュー'
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
          表示上限 {filesLimit} 件 (該当 {matchedFiles.length} 件)。上限は config.json の commitFilesLimit
          で変更できます
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
  );

  // フィルタや別コミットの選択で一覧から消えたファイルはプレビューしない
  const previewPath =
    commitDetail && focusedFile && commitDetail.files.some((f) => f.path === focusedFile) ? focusedFile : null;
  const previewPane =
    commitDetail && previewPath ? (
      <CommitFileDiff repo={repoRoot} hash={commitDetail.hash} path={previewPath} />
    ) : (
      <div className={cx("empty-hint")}>ファイルを選択すると差分を表示します</div>
    );

  /** 分割ハンドル。方向によってカーソル (col-resize / row-resize) を変える */
  const resizeHandle = (dir: LogLayoutDir) => (
    <PanelResizeHandle
      className={cx(dir === 'horizontal' ? 'resize-handle-col' : 'resize-handle-row')}
      // ドラッグ中は ref だけ更新し、確定時にまとめて保存する
      onDragging={(dragging) => {
        if (!dragging) persistLogLayout();
      }}
    />
  );
  const innerDir: LogLayoutDir = logDir === 'horizontal' ? 'vertical' : 'horizontal';

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
        <button
          className={cx("status-btn")}
          title="リベース用バックアップの管理など"
          onClick={openToolsMenu}
        >
          🧰 ツール ▾
        </button>
        {!repositories.includes(repoRoot) && (
          <button className={cx("status-btn")} onClick={() => addRepository(repoRoot)} title="サイドバーに登録">
            ★ 登録
          </button>
        )}
        <span className={cx("status-spacer")} />
        {/* ログタブの分割方向 (sessionStorage に保持) */}
        {tab === 'log' && (
          <>
            <button
              className={cx(`status-btn${logDir === 'horizontal' ? ' on' : ''}`)}
              title="左右に分割 (右下に差分プレビュー)"
              onClick={() => changeLogDir('horizontal')}
            >
              ⬌ 左右
            </button>
            <button
              className={cx(`status-btn${logDir === 'vertical' ? ' on' : ''}`)}
              title="上下に分割 (右下に差分プレビュー)"
              onClick={() => changeLogDir('vertical')}
            >
              ⬍ 上下
            </button>
          </>
        )}
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

      {tab === 'log' ? (
        // ログタブ: グラフ + コミット詳細 + 差分プレビューの 3 ペイン。
        // 分割方向を変えたら保存済みサイズを読み直したいので key で作り直す
        <PanelGroup
          key={logDir}
          direction={logDir}
          className={cx("git-body")}
          onLayout={(sizes) => {
            logSizes.current[logDir].main = sizes[0];
          }}
        >
          <Panel defaultSize={logSizes.current[logDir].main} minSize={15}>
            {/* スクロールは .graph-rows 側に持たせる (スクロール位置の保存/復元のため) */}
            <div className={cx("log-pane")}>{logGraphPane}</div>
          </Panel>
          {resizeHandle(logDir)}
          <Panel minSize={20}>
            <PanelGroup
              direction={innerDir}
              onLayout={(sizes) => {
                logSizes.current[logDir].detail = sizes[0];
              }}
            >
              <Panel defaultSize={logSizes.current[logDir].detail} minSize={15}>
                <div className={cx("log-pane log-pane-scroll")}>{commitDetailPane}</div>
              </Panel>
              {resizeHandle(innerDir)}
              <Panel minSize={15}>
                <div className={cx("log-pane log-pane-scroll")}>{previewPane}</div>
              </Panel>
            </PanelGroup>
          </Panel>
        </PanelGroup>
      ) : (
        <div className={cx("git-body")}>
          <div className={cx(`git-left${tab === 'branches' ? ' branch-host' : ''}`)}>
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
                    ref={commitMessageRef}
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

            {tab === 'branches' && (
              <div className={cx("git-branches")}>
                {/* 作成ボタンは固定 (一覧だけがスクロールする) */}
                <div className={cx("branch-toolbar")}>
                  <button className={cx("btn")} onClick={openCreateBranchDialog}>
                    ＋ ブランチ作成
                  </button>
                </div>
                <div
                  className={cx("branch-list")}
                  ref={branchListRef}
                  tabIndex={0}
                  onKeyDown={branchListKeyDown}
                >
                  {renderBranchSection('ローカルブランチ', localBranches.length, localBranchTree)}
                  {renderBranchSection('リモートブランチ', remoteBranches.length, remoteBranchTree)}
                </div>
              </div>
            )}
          </div>

          <div className={cx("git-right")}>
            {tab === 'changes' ? (
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
      )}
    </div>
  );
}
