import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { useContextMenu } from '../../components/ContextMenu';
import { useCommitDraft } from '../../stores/commitDraft';
import { useConflictResolver } from '../../stores/conflict';
import { useExplorer } from '../../stores/explorer';
import { useGit } from '../../stores/git';
import { useRebase } from '../../stores/rebase';
import { useReview } from '../../stores/review';
import { useSettings } from '../../stores/settings';
import { switchView, WORKTREE_REVIEW_ID } from '../../stores/ui';
import { openSyncDialog, openSyncDialogTab, type SyncTab } from '../git/SyncDialog';
import { useRebaseDialog } from '../git/Rebase';
import { openBackupBranchDialog, openCreateBranchDialog, openRenameBranchDialog } from '../git/BranchDialog';
import { runGitCommands } from '../git/GitCommandDialog';
import { openUndoCommitDialog } from '../git/UndoCommitDialog';
import { openRepoGroupsDialog } from '../../app/RepoGroupsDialog';
import { openAiChat } from '../aichat/aiChatStore';
import { openTerminal, openTerminalAt } from '../terminal/terminalStore';
import { useSideBar } from '../../stores/sideBar';
import { appTabId, isCommandPaletteKey, type AppTabWindow } from '../../lib/appTabs';
import { backupBranchRegex } from '../../lib/backupBranch';
import { isDialogOpen } from '../../lib/dialogKeys';
import { matchText } from '../../lib/fuzzyMatch';
import { extractArchiveToTemp } from '../../lib/gitArchive';
import { openLocation } from '../../lib/openLocation';
import { baseName } from '../../lib/paths';
import type { GitBranch } from '../../types';
import styles from './CommandPalette.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * コマンドパレット (VSCode と同じく Ctrl+Shift+P / ⌘+Shift+P)。
 * コマンドの一覧から選んで実行する。「リポジトリ」「クイックアクセス」は続けて開く先を、
 * 「ブランチ切り替え」は続けて切り替え先のブランチを選ぶ。
 * コマンドは日本語名のほか英語名 (右側に薄く出す) でも絞り込める。
 */

/** 表示中の一覧: コマンド / リポジトリ / クイックアクセス (newTab は別タブで開く) / 切り替え先のブランチ */
type Page = { kind: 'commands' } | { kind: 'branches' } | { kind: 'repos' | 'quick'; newTab: boolean };

interface PaletteItem {
  key: string;
  label: string;
  /** 右側に薄く出す補足 (コマンドの英語名・フォルダのパス) */
  detail?: string;
  /** detail でも絞り込むか (コマンドの英語名) */
  matchDetail?: boolean;
  /** 実行できない理由 (あれば選べない) */
  disabled?: string;
  /** 選んだら続けて開く一覧 */
  next?: Page;
  /** 選んだときの動作 (パレットを閉じてから呼ぶ) */
  run?: () => void;
}

interface PaletteStore {
  open: boolean;
  page: Page;
  /** 開く前にフォーカスがあった要素 (取り消しで閉じたら戻す) */
  restore: Element | null;
  setPage: (page: Page) => void;
  close: () => void;
}

const usePalette = create<PaletteStore>((set) => ({
  open: false,
  page: { kind: 'commands' },
  restore: null,
  setPage: (page) => set({ page }),
  close: () => set({ open: false }),
}));

/**
 * 他の操作の途中か (ダイアログ・競合の解消・リベース中の全画面ロック)。
 * その間はパレットから別の操作を始めさせない
 */
function isBusy(): boolean {
  const repoRoot = useGit.getState().repoRoot;
  const session = useRebase.getState().session;
  return (
    isDialogOpen() ||
    useRebaseDialog.getState().open ||
    useConflictResolver.getState().open ||
    (repoRoot !== null && session?.repo === repoRoot)
  );
}

export function openCommandPalette(): void {
  if (isBusy()) return;
  useContextMenu.getState().close();
  const { open } = usePalette.getState();
  usePalette.setState({
    open: true,
    page: { kind: 'commands' },
    ...(open ? {} : { restore: document.activeElement }),
  });
}

const NEED_REPO = 'Git リポジトリ内でのみ使えます';

/** currentBranch は現在のブランチ (detached HEAD なら null) */
function buildCommands(inRepo: boolean, currentBranch: string | null): PaletteItem[] {
  const repoOnly = inRepo ? undefined : NEED_REPO;
  const sync = (tab: SyncTab, label: string, en: string): PaletteItem => ({
    key: `sync.${tab}`,
    label: `同期: ${label}`,
    detail: `Sync: ${en}`,
    disabled: repoOnly,
    run: () => openSyncDialogTab(tab),
  });
  const commands: PaletteItem[] = [
    // 「同期」ボタンと同じ (前回開いたタブで開く)
    { key: 'sync', label: '同期', detail: 'Sync', disabled: repoOnly, run: () => openSyncDialog() },
    sync('pull', 'Pull', 'Pull'),
    sync('push', 'Push', 'Push'),
    sync('fetch', 'Fetch', 'Fetch'),
    sync('bulk', '一括', 'Bulk Update'),
    sync('remote', 'リモート', 'Remotes'),
    {
      key: 'branch.checkout',
      label: 'ブランチ切り替え',
      detail: 'Git: Checkout to Branch',
      disabled: repoOnly,
      next: { kind: 'branches' },
    },
    // 以下 3 つはブランチタブのヘッダのボタンと同じ
    {
      key: 'branch.create',
      label: 'ブランチ作成',
      detail: 'Git: Create Branch',
      disabled: repoOnly,
      run: () => openCreateBranchDialog(),
    },
    {
      key: 'branch.rename',
      label: 'ブランチ名変更',
      detail: 'Git: Rename Branch',
      disabled: repoOnly ?? (currentBranch ? undefined : 'ブランチをチェックアウトしていません (detached HEAD)'),
      run: () => currentBranch && openRenameBranchDialog(currentBranch),
    },
    {
      key: 'branch.backup',
      label: 'ブランチのバックアップ',
      detail: 'Git: Backup Branch',
      disabled: repoOnly,
      run: () => openBackupBranchDialog(currentBranch ?? ''),
    },
    {
      // Git タブの「ツール」メニューと同じ
      key: 'archive.extract',
      label: '一時フォルダに展開',
      detail: 'Git: Extract HEAD to Temp Folder',
      disabled: repoOnly,
      run: () => {
        const repo = useGit.getState().repoRoot;
        if (repo) void extractArchiveToTemp(repo);
      },
    },
    {
      // Git タブの「ツール」メニューと同じ
      key: 'commit.undo',
      label: '直前のコミットを取り消す',
      detail: 'Git: Undo Last Commit',
      disabled: repoOnly ?? (currentBranch ? undefined : 'ブランチをチェックアウトしていません (detached HEAD)'),
      run: openUndoCommitDialog,
    },
    { key: 'repo', label: 'リポジトリ', detail: 'Repository: Open', next: { kind: 'repos', newTab: false } },
    {
      key: 'repo.newtab',
      label: 'リポジトリ (別タブ)',
      detail: 'Repository: Open in New Tab',
      next: { kind: 'repos', newTab: true },
    },
    { key: 'repo.groups', label: 'リポジトリ: グループ分け', detail: 'Repository: Groups', run: openRepoGroupsDialog },
    { key: 'quick', label: 'クイックアクセス', detail: 'Quick Access: Open', next: { kind: 'quick', newTab: false } },
    {
      key: 'quick.newtab',
      label: 'クイックアクセス (別タブ)',
      detail: 'Quick Access: Open in New Tab',
      next: { kind: 'quick', newTab: true },
    },
    {
      // レビュータブの「未コミットの変更」を開くのと同じ
      key: 'review.worktree',
      label: 'レビュー (未コミット)',
      detail: 'Review: Uncommitted Changes',
      disabled: repoOnly,
      run: () => useReview.getState().open(WORKTREE_REVIEW_ID),
    },
    {
      // コミットタブを開いてメッセージ欄にフォーカスする
      key: 'commit',
      label: 'コミット',
      detail: 'Commit',
      disabled: repoOnly,
      run: () => {
        switchView('commit');
        useCommitDraft.getState().requestFocus();
      },
    },
    { key: 'ai', label: 'AI チャット', detail: 'AI Chat: Codex / Claude', run: openAiChat },
    {
      key: 'sidebar.toggle',
      label: '左パネルの表示 / 非表示',
      detail: 'View: Toggle Primary Side Bar Visibility',
      run: () => useSideBar.getState().toggle(),
    },
    { key: 'search', label: '名前で検索', detail: 'Search: Find Files by Name', run: () => useSideBar.getState().focusSearch() },
    { key: 'terminal', label: 'ターミナル', detail: 'Terminal', run: () => void openTerminal() },
    {
      // 表示中のフォルダで開く
      key: 'terminal.new',
      label: '新しいターミナル',
      detail: 'Terminal: New',
      run: () => void openTerminalAt(useExplorer.getState().path),
    },
  ];
  return commands.map((c) => ({ ...c, matchDetail: true }));
}

const PLACEHOLDER: Record<Page['kind'], string> = {
  commands: 'コマンドを入力 (英語名でも絞り込めます)',
  repos: '開くリポジトリを選択 (名前で絞り込み)',
  quick: '開くフォルダを選択 (名前で絞り込み)',
  branches: '切り替えるブランチを選択 (名前で絞り込み)',
};

const EMPTY: Record<Page['kind'], string> = {
  commands: '一致するコマンドはありません',
  repos: '一致するリポジトリはありません',
  quick: '一致する項目はありません',
  branches: '一致するブランチはありません',
};

const TITLE: Record<Exclude<Page['kind'], 'commands'>, string> = {
  repos: 'リポジトリ',
  quick: 'クイックアクセス',
  branches: 'ブランチ切り替え',
};

/**
 * 切り替え先のローカルブランチ (バックアップブランチは除く)。
 * 他のワークツリーでチェックアウト中のブランチは git が切替を拒否するので、選んだらそのワークツリーを開く
 */
function buildBranchItems(repo: string, branches: GitBranch[], backupPattern: string): PaletteItem[] {
  const backupRe = backupBranchRegex(backupPattern);
  return branches
    .filter((b) => !b.name.startsWith('remotes/') && !backupRe?.test(b.name))
    .map((b) => {
      const worktree = b.worktree;
      if (b.current) return { key: b.name, label: b.name, disabled: '現在のブランチ' };
      if (worktree) {
        return {
          key: b.name,
          label: b.name,
          detail: `他のワークツリーで使用中 (選ぶとそのワークツリーを開く): ${worktree}`,
          run: () => openLocation(worktree, { keepView: true }),
        };
      }
      return {
        key: b.name,
        label: b.name,
        detail: b.upstream,
        run: () => void runGitCommands(repo, [['checkout', b.name]], 'ブランチ切替'),
      };
    });
}

/** 一致した文字を強調する */
function Highlight({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const hit = new Set(indices);
  const parts: ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const on = hit.has(i);
    let j = i;
    while (j < text.length && hit.has(j) === on) j++;
    const s = text.slice(i, j);
    parts.push(on ? <mark key={i} className={cx('cp-hit')}>{s}</mark> : <Fragment key={i}>{s}</Fragment>);
    i = j;
  }
  return <>{parts}</>;
}

export function CommandPalette() {
  const open = usePalette((s) => s.open);
  const page = usePalette((s) => s.page);

  // キャプチャで拾い、Monaco などフォーカス中の要素より先に受け取る
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isCommandPaletteKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      openCommandPalette();
    };
    window.addEventListener('keydown', onKey, true);
    if (appTabId) (window as AppTabWindow).ebOpenCommandPalette = openCommandPalette;
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!open) return null;
  // 一覧を切り替えたら入力と選択を初期化する
  return <PaletteBody key={'newTab' in page ? `${page.kind}:${page.newTab}` : page.kind} page={page} />;
}

function PaletteBody({ page }: { page: Page }) {
  const repoRoot = useGit((s) => s.repoRoot);
  const currentBranch = useGit((s) => s.status?.branch ?? null);
  const repositories = useSettings((s) => s.repositories);
  const repoLabels = useSettings((s) => s.settings.repoLabels);
  const favorites = useSettings((s) => s.favorites);
  const backupPattern = useSettings((s) => s.settings.backupBranchPattern);
  const [home, setHome] = useState('');
  /** ブランチの一覧 (読み込み中は null) */
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  // クイックアクセスの先頭の Home (サイドバーと同じ並び)
  useEffect(() => {
    if (page.kind !== 'quick') return;
    api
      .volumes()
      .then((r) => setHome(r.home))
      .catch(() => {});
  }, [page.kind]);

  useEffect(() => {
    if (page.kind !== 'branches' || !repoRoot) return;
    let cancelled = false;
    api
      .gitBranches(repoRoot)
      .then((r) => {
        if (!cancelled) setBranches(r.branches);
      })
      .catch((e: unknown) => {
        if (!cancelled) setBranchError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [page.kind, repoRoot]);

  const items = useMemo<PaletteItem[]>(() => {
    if (page.kind === 'commands') return buildCommands(repoRoot !== null, currentBranch);
    if (page.kind === 'branches') return repoRoot ? buildBranchItems(repoRoot, branches ?? [], backupPattern) : [];
    const { newTab } = page;
    if (page.kind === 'repos') {
      return repositories.map((r) => ({
        key: r,
        label: repoLabels[r] || baseName(r),
        detail: r,
        run: () => openLocation(r, { keepView: true, newTab }),
      }));
    }
    const quick = [...(home ? [{ path: home, label: 'Home' }] : []), ...favorites];
    return quick.map((f) => ({
      key: f.path,
      label: f.label,
      detail: f.path,
      run: () => openLocation(f.path, { newTab }),
    }));
  }, [page, repoRoot, currentBranch, repositories, repoLabels, favorites, home, branches, backupPattern]);

  /** 絞り込み結果 (一致の強い順。同点は元の並び) */
  const rows = useMemo(() => {
    const out: { item: PaletteItem; score: number; label: number[]; detail: number[] }[] = [];
    for (const item of items) {
      const l = matchText(query, item.label);
      const d = item.matchDetail && item.detail ? matchText(query, item.detail) : null;
      if (!l && !d) continue;
      // 強調は一致の強かった方だけに付ける
      if (l && (!d || l.score >= d.score)) out.push({ item, score: l.score, label: l.indices, detail: [] });
      else if (d) out.push({ item, score: d.score, label: [], detail: d.indices });
    }
    return out.sort((a, b) => b.score - a.score);
  }, [items, query]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    const el = listRef.current?.children[active];
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' });
  }, [active, rows]);

  const cancel = () => {
    const prev = usePalette.getState().restore;
    usePalette.getState().close();
    if (prev instanceof HTMLElement && prev.isConnected) prev.focus();
  };

  const choose = (item: PaletteItem | undefined) => {
    if (!item || item.disabled) return;
    if (item.next) {
      usePalette.getState().setPage(item.next);
      return;
    }
    usePalette.getState().close();
    item.run?.();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const move = (delta: number) => {
      e.preventDefault();
      if (rows.length > 0) setActive((i) => (i + delta + rows.length) % rows.length);
    };
    switch (e.key) {
      case 'ArrowDown':
        move(1);
        break;
      case 'ArrowUp':
        move(-1);
        break;
      case 'Enter':
        e.preventDefault();
        choose(rows[active]?.item);
        break;
      case 'Escape':
        e.preventDefault();
        cancel();
        break;
      case 'Backspace':
        // 入力が空なら 1 つ前 (コマンドの一覧) に戻る
        if (query === '' && page.kind !== 'commands') {
          e.preventDefault();
          usePalette.getState().setPage({ kind: 'commands' });
        }
        return;
      default:
        return;
    }
    e.stopPropagation();
  };

  const title =
    page.kind === 'commands' ? null : `${TITLE[page.kind]}${'newTab' in page && page.newTab ? ' (別タブで開く)' : ''}`;

  const emptyText = () => {
    if (page.kind === 'branches') {
      if (branchError) return `ブランチの一覧を取得できませんでした: ${branchError}`;
      if (!branches) return '読み込み中…';
    }
    if (items.length > 0) return EMPTY[page.kind];
    if (page.kind === 'repos') return '登録されたリポジトリはありません';
    if (page.kind === 'branches') return 'ブランチはありません';
    return '項目はありません';
  };

  return (
    <div className={cx('cp-layer')} onMouseDown={cancel}>
      <div className={cx('cp-box')} onMouseDown={(e) => e.stopPropagation()}>
        {title && (
          <div className={cx('cp-title')}>
            {title}
            <span className={cx('cp-title-hint')}>Backspace で戻る</span>
          </div>
        )}
        <input
          ref={inputRef}
          className={cx('cp-input')}
          value={query}
          placeholder={PLACEHOLDER[page.kind]}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-activedescendant={rows[active] ? `cp-item-${active}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div ref={listRef} id="command-palette-list" className={cx('cp-list')} role="listbox">
          {rows.map(({ item, label, detail }, i) => (
            <div
              key={item.key}
              id={`cp-item-${i}`}
              role="option"
              aria-selected={i === active}
              aria-disabled={item.disabled ? true : undefined}
              className={cx(`cp-item${i === active ? ' active' : ''}${item.disabled ? ' disabled' : ''}`)}
              title={item.disabled}
              onMouseMove={() => i !== active && setActive(i)}
              onClick={() => choose(item)}
            >
              <span className={cx('cp-label')}>
                <Highlight text={item.label} indices={label} />
                {item.next && <span className={cx('cp-more')}>…</span>}
              </span>
              {item.detail && (
                <span className={cx('cp-detail')}>
                  <Highlight text={item.detail} indices={detail} />
                </span>
              )}
              {item.disabled && <span className={cx('cp-reason')}>{item.disabled}</span>}
            </div>
          ))}
          {rows.length === 0 && <div className={cx('cp-empty')}>{emptyText()}</div>}
        </div>
      </div>
    </div>
  );
}
