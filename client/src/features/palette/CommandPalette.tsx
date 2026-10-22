import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { useContextMenu } from '../../components/ContextMenu';
import { useCommitDraft } from '../../stores/commitDraft';
import { useConflictResolver } from '../../stores/conflict';
import { useGit } from '../../stores/git';
import { useRebase } from '../../stores/rebase';
import { useReview } from '../../stores/review';
import { useSettings } from '../../stores/settings';
import { switchView, WORKTREE_REVIEW_ID } from '../../stores/ui';
import { openSyncDialog, openSyncDialogTab, type SyncTab } from '../git/SyncDialog';
import { useRebaseDialog } from '../git/Rebase';
import { appTabId, isCommandPaletteKey, type AppTabWindow } from '../../lib/appTabs';
import { isDialogOpen } from '../../lib/dialogKeys';
import { matchText } from '../../lib/fuzzyMatch';
import { openLocation } from '../../lib/openLocation';
import { baseName } from '../../lib/paths';
import styles from './CommandPalette.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * コマンドパレット (VSCode と同じく Ctrl+Shift+P / ⌘+Shift+P)。
 * コマンドの一覧から選んで実行する。「リポジトリ」「クイックアクセス」は続けて開く先を選ぶ。
 * コマンドは日本語名のほか英語名 (右側に薄く出す) でも絞り込める。
 */

/** 表示中の一覧: コマンド / リポジトリ / クイックアクセス (newTab は別タブで開く) */
type Page = { kind: 'commands' } | { kind: 'repos' | 'quick'; newTab: boolean };

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

function buildCommands(inRepo: boolean): PaletteItem[] {
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
    { key: 'repo', label: 'リポジトリ', detail: 'Repository: Open', next: { kind: 'repos', newTab: false } },
    {
      key: 'repo.newtab',
      label: 'リポジトリ (別タブ)',
      detail: 'Repository: Open in New Tab',
      next: { kind: 'repos', newTab: true },
    },
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
  ];
  return commands.map((c) => ({ ...c, matchDetail: true }));
}

const PLACEHOLDER: Record<Page['kind'], string> = {
  commands: 'コマンドを入力 (英語名でも絞り込めます)',
  repos: '開くリポジトリを選択 (名前で絞り込み)',
  quick: '開くフォルダを選択 (名前で絞り込み)',
};

const EMPTY: Record<Page['kind'], string> = {
  commands: '一致するコマンドはありません',
  repos: '一致するリポジトリはありません',
  quick: '一致する項目はありません',
};

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
  return <PaletteBody key={page.kind === 'commands' ? 'commands' : `${page.kind}:${page.newTab}`} page={page} />;
}

function PaletteBody({ page }: { page: Page }) {
  const repoRoot = useGit((s) => s.repoRoot);
  const repositories = useSettings((s) => s.repositories);
  const repoLabels = useSettings((s) => s.settings.repoLabels);
  const favorites = useSettings((s) => s.favorites);
  const [home, setHome] = useState('');
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

  const items = useMemo<PaletteItem[]>(() => {
    if (page.kind === 'commands') return buildCommands(repoRoot !== null);
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
  }, [page, repoRoot, repositories, repoLabels, favorites, home]);

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
    page.kind === 'commands'
      ? null
      : `${page.kind === 'repos' ? 'リポジトリ' : 'クイックアクセス'}${page.newTab ? ' (別タブで開く)' : ''}`;

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
          {rows.length === 0 && (
            <div className={cx('cp-empty')}>
              {items.length === 0
                ? page.kind === 'repos'
                  ? '登録されたリポジトリはありません'
                  : '項目はありません'
                : EMPTY[page.kind]}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
