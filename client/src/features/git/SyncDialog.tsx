import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { useGit } from '../../stores/git';
import { runGitCommands } from './GitCommandDialog';
import styles from './SyncDialog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';
import { useDialogKeys } from '../../lib/dialogKeys';
import type { GitBranch } from '../../types';

const cx = createCssModuleClassNames(styles);

/**
 * 同期ダイアログ: リモートとのやり取りを 1 つにまとめ、タブで操作を分ける。
 * - Push:  現在のブランチを push する
 * - Pull:  現在のブランチに取り込む
 * - Fetch: リモートの状態だけ取得する
 * - 一括:  早送りできるローカルブランチを、チェックアウトせずまとめて更新する
 *          (`git fetch <remote> <remoteRef>:refs/heads/<local>`)
 *
 * 「一括」は git の制約がそのまま UI になっている:
 * - チェックアウト中のブランチへは refspec 付き fetch が拒否されるので、
 *   現在のブランチだけは `merge --ff-only` で早送りする
 * - 早送りできない (分岐した) ブランチは強制更新すると履歴を失うため、
 *   チェック不可にして理由を出すだけに留める (手動マージ/リベースに任せる)
 */

type SyncTab = 'push' | 'pull' | 'fetch' | 'bulk';

const TABS: { key: SyncTab; label: string }[] = [
  { key: 'push', label: 'Push' },
  { key: 'pull', label: 'Pull' },
  { key: 'fetch', label: 'Fetch' },
  { key: 'bulk', label: '一括' },
];

/** 実行結果ダイアログのタイトル */
const RUN_TITLE: Record<SyncTab, string> = {
  push: 'Push',
  pull: 'Pull',
  fetch: 'Fetch',
  bulk: '一括同期',
};

/** ブランチごとの同期可否 (一括タブ) */
type SyncState = 'ff' | 'diverged' | 'up-to-date' | 'no-upstream';

interface SyncRow {
  branch: GitBranch;
  state: SyncState;
}

/** 一覧の並び順。更新できるものを上に、手当てが要るものを次に置く */
const STATE_ORDER: Record<SyncState, number> = {
  ff: 0,
  diverged: 1,
  'up-to-date': 2,
  'no-upstream': 3,
};

interface SyncDialogStore {
  open: boolean;
  tab: SyncTab;
  /** 対象を 1 ブランチに絞る (ブランチ一覧の「リモートから更新」用)。null なら全ローカルブランチ */
  onlyBranch: string | null;
  show: (onlyBranch: string | null) => void;
  setTab: (tab: SyncTab) => void;
  close: () => void;
}

export const useSyncDialog = create<SyncDialogStore>((set) => ({
  open: false,
  // 初回は Push。以降は前回開いたタブを覚えておく (同じ操作を続けるとき選び直さずに済む)
  tab: 'push',
  onlyBranch: null,
  show: (onlyBranch) =>
    // ブランチ指定で開くのは一括同期の用途なので、そのときだけタブを固定する
    set((s) => ({ open: true, onlyBranch, tab: onlyBranch ? 'bulk' : s.tab })),
  setTab: (tab) => set({ tab }),
  close: () => set({ open: false }),
}));

/** ブランチ名を渡すと「一括」タブをそのブランチだけに絞って開く */
export function openSyncDialog(onlyBranch?: string): void {
  useSyncDialog.getState().show(onlyBranch ?? null);
}

function classify(b: GitBranch): SyncState {
  if (!b.upstream || !b.upstreamRemote || !b.upstreamRef) return 'no-upstream';
  const behind = b.behind ?? 0;
  if (behind === 0) return 'up-to-date';
  return (b.ahead ?? 0) > 0 ? 'diverged' : 'ff';
}

function stateLabel(row: SyncRow): string {
  switch (row.state) {
    case 'ff':
      return row.branch.current ? '早送り (現在のブランチ)' : '早送り';
    case 'diverged':
      return '分岐 — 手動でマージ/リベースが必要';
    case 'up-to-date':
      return '取り込む更新なし';
    default:
      return '追跡なし';
  }
}

export function SyncDialog() {
  const { open, tab, onlyBranch, setTab, close } = useSyncDialog();
  const repoRoot = useGit((s) => s.repoRoot);
  const status = useGit((s) => s.status);
  const branch = status?.branch ?? '';
  const tracking = status?.tracking ?? null;

  // --- Push タブ ---
  const [remote, setRemote] = useState('origin');
  const [remoteBranch, setRemoteBranch] = useState('');
  const [forceWithLease, setForceWithLease] = useState(false);

  // --- Fetch タブ (Prune は既定で ON: 不要になった追跡ブランチを残さない) ---
  const [prune, setPrune] = useState(true);

  // --- 一括タブ ---
  const [phase, setPhase] = useState<'idle' | 'fetching' | 'ready' | 'failed'>('idle');
  const [fetchError, setFetchError] = useState('');
  const [rows, setRows] = useState<SyncRow[]>([]);
  const [targets, setTargets] = useState<Set<string>>(new Set());
  /**
   * 取得の世代番号。取得中に閉じたり「再取得」を連打したりしたときに、
   * 古いレスポンスが新しい結果を上書きしないようにする
   */
  const reqId = useRef(0);

  /** リモートを取得し、取得後の ahead/behind でブランチ一覧を組み直す (一括タブ) */
  const reload = useCallback(async () => {
    if (!repoRoot) return;
    const id = ++reqId.current;
    const stale = () => id !== reqId.current;
    setPhase('fetching');
    setFetchError('');
    setRows([]);
    setTargets(new Set());
    try {
      const r = await api.gitExec(repoRoot, ['fetch', '--prune']);
      if (stale()) return;
      if (!r.ok) {
        setFetchError(r.output || '(出力なし)');
        setPhase('failed');
        return;
      }
      const { branches } = await api.gitBranches(repoRoot);
      if (stale()) return;
      const only = useSyncDialog.getState().onlyBranch;
      const next = branches
        .filter((b) => !b.name.startsWith('remotes/'))
        .filter((b) => !only || b.name === only)
        .map<SyncRow>((b) => ({ branch: b, state: classify(b) }))
        .sort(
          (a, z) =>
            STATE_ORDER[a.state] - STATE_ORDER[z.state] || a.branch.name.localeCompare(z.branch.name),
        );
      setRows(next);
      // 早送りできるものは最初からチェックしておく (それ以外は選べない)
      setTargets(new Set(next.filter((r2) => r2.state === 'ff').map((r2) => r2.branch.name)));
      setPhase('ready');
      // ヘッダの ↑↓ 表示も取得後の値にそろえる
      void useGit.getState().refreshStatus();
    } catch (e) {
      if (stale()) return;
      setFetchError(e instanceof Error ? e.message : String(e));
      setPhase('failed');
    }
  }, [repoRoot]);

  /** 閉じたら進行中の取得結果は捨てる (fetch 自体は無害なので中断はしない) */
  const closeDialog = useCallback(() => {
    reqId.current++;
    close();
  }, [close]);

  // 開くたびに各タブの入力を初期化する。
  // 一括タブの取得中に refreshStatus が走っても入力が巻き戻らないよう、
  // 依存は open だけにして追跡先はその時点のストアから読む
  useEffect(() => {
    if (!open) return;
    const t = useGit.getState().status?.tracking ?? null;
    if (t && t.includes('/')) {
      const slash = t.indexOf('/');
      setRemote(t.slice(0, slash));
      setRemoteBranch(t.slice(slash + 1));
    } else {
      setRemote('origin');
      setRemoteBranch('');
    }
    setForceWithLease(false);
    setPrune(true);
    setPhase('idle');
    setFetchError('');
    setRows([]);
    setTargets(new Set());
  }, [open]);

  // 一括タブを開いたときだけ fetch する (Push/Pull/Fetch を使うだけなら通信しない)
  useEffect(() => {
    if (open && tab === 'bulk' && phase === 'idle') void reload();
  }, [open, tab, phase, reload]);

  const syncable = rows.filter((r) => r.state === 'ff');
  const targetRows = syncable.filter((r) => targets.has(r.branch.name));

  const toggleTarget = (name: string) => {
    const next = new Set(targets);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setTargets(next);
  };

  /**
   * 一括タブで実行するコマンド列。
   * refspec fetch はリモートごとに 1 コマンドへまとめ、
   * 現在のブランチだけは早送りマージにする (refspec fetch が使えないため)。
   */
  const buildBulkCommands = (): string[][] => {
    const byRemote = new Map<string, string[]>();
    let currentRow: SyncRow | null = null;
    for (const row of targetRows) {
      if (row.branch.current) {
        currentRow = row;
        continue;
      }
      const rem = row.branch.upstreamRemote as string;
      const specs = byRemote.get(rem) ?? [];
      specs.push(`${row.branch.upstreamRef}:refs/heads/${row.branch.name}`);
      byRemote.set(rem, specs);
    }
    const cmds = [...byRemote].map(([rem, specs]) => ['fetch', rem, ...specs]);
    if (currentRow) cmds.push(['merge', '--ff-only', currentRow.branch.upstream as string]);
    return cmds;
  };

  /** Push タブで実行するコマンド (空欄のリモートブランチはローカルと同名) */
  const buildPushCommands = (): string[][] => {
    if (!branch) return [];
    const args = ['push'];
    if (forceWithLease) args.push('--force-with-lease');
    if (!tracking) args.push('-u'); // 初回 push はトラッキングを設定
    args.push(remote.trim() || 'origin');
    const target = remoteBranch.trim();
    args.push(target && target !== branch ? `${branch}:${target}` : branch);
    return [args];
  };

  const commands: string[][] =
    tab === 'push'
      ? buildPushCommands()
      : tab === 'pull'
        ? [['pull']]
        : tab === 'fetch'
          ? [['fetch', ...(prune ? ['--prune'] : [])]]
          : phase === 'ready'
            ? buildBulkCommands()
            : [];

  const canRun = commands.length > 0;

  const doRun = () => {
    if (!repoRoot || !canRun) return;
    closeDialog();
    void runGitCommands(repoRoot, commands, RUN_TITLE[tab], {
      // 一括は 1 件失敗しても残りを続け、結果をまとめて見せる
      continueOnError: tab === 'bulk',
    });
  };

  // 取得は時間がかかることがあるので、実行中でも閉じられるようにしておく
  const dialogRef = useDialogKeys({
    enabled: open,
    onEnter: canRun ? doRun : null,
    onEscape: closeDialog,
  });

  if (!open || !repoRoot) return null;

  return (
    <div ref={dialogRef} className={cx('dialog-backdrop')}>
      <div className={cx('dialog sync-dialog')}>
        <div className={cx('dialog-title')}>{onlyBranch ? `同期: ${onlyBranch}` : '同期'}</div>

        <div className={cx('sync-tabs')} role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={cx(`sync-tab${tab === t.key ? ' on' : ''}`)}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className={cx('sync-body')}>
          {tab === 'push' && (
            <div className={cx('sync-form')}>
              <div className={cx('sync-row')}>
                <span className={cx('sync-label')}>ローカル:</span>
                <b>{branch || '(不明)'}</b>
              </div>
              <label className={cx('sync-row')}>
                <span className={cx('sync-label')}>リモート:</span>
                <input
                  className={cx('sync-input small')}
                  value={remote}
                  onChange={(e) => setRemote(e.target.value)}
                />
              </label>
              <label className={cx('sync-row')}>
                <span className={cx('sync-label')}>リモートブランチ:</span>
                <input
                  className={cx('sync-input')}
                  value={remoteBranch}
                  placeholder={branch ? `(空欄で ${branch} と同名)` : ''}
                  onChange={(e) => setRemoteBranch(e.target.value)}
                />
              </label>
              {tracking && (
                <div className={cx('sync-row sync-note')}>現在のトラッキング先: {tracking}</div>
              )}
              <label className={cx('sync-row')}>
                <input
                  type="checkbox"
                  checked={forceWithLease}
                  onChange={(e) => setForceWithLease(e.target.checked)}
                />
                <span>force with lease (--force-with-lease)</span>
              </label>
            </div>
          )}

          {tab === 'pull' && (
            <div className={cx('sync-form')}>
              <div className={cx('sync-row')}>
                リモートの最新状態を取得し、現在のブランチに取り込みます (git pull)。
              </div>
              <div className={cx('sync-row sync-dim')}>
                {branch || '(不明)'}
                {tracking ? ` ← ${tracking}` : ' (追跡先なし)'}
              </div>
            </div>
          )}

          {tab === 'fetch' && (
            <div className={cx('sync-form')}>
              <div className={cx('sync-row')}>リモートの最新状態を取得します (git fetch)。</div>
              <label className={cx('sync-row')}>
                <input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} />
                <span>Prune: リモートで削除されたブランチの追跡情報も削除 (--prune)</span>
              </label>
            </div>
          )}

          {tab === 'bulk' && (
            <div className={cx('sync-form')}>
              <div className={cx('sync-row')}>
                <span>
                  早送りできるローカルブランチを、切り替えずにまとめて更新します。
                </span>
                <span className={cx('sync-actions')}>
                  {syncable.length > 0 && (
                    <>
                      <button
                        className={cx('btn small')}
                        onClick={() => setTargets(new Set(syncable.map((r) => r.branch.name)))}
                      >
                        すべて選択
                      </button>
                      <button className={cx('btn small')} onClick={() => setTargets(new Set())}>
                        解除
                      </button>
                    </>
                  )}
                  <button className={cx('btn small')} disabled={phase === 'fetching'} onClick={() => void reload()}>
                    再取得
                  </button>
                </span>
              </div>

              {(phase === 'idle' || phase === 'fetching') && (
                <div className={cx('sync-row sync-dim')}>
                  <span className={cx('spinner-ring small')} /> git fetch --prune 実行中…
                </div>
              )}
              {phase === 'failed' && <pre className={cx('sync-error')}>{fetchError}</pre>}

              {phase === 'ready' && (
                <>
                  <div className={cx('sync-list')}>
                    {rows.length === 0 && (
                      <div className={cx('sync-dim')}>ローカルブランチがありません</div>
                    )}
                    {rows.map((row) => {
                      const on = row.state === 'ff';
                      const { ahead = 0, behind = 0 } = row.branch;
                      return (
                        <label
                          key={row.branch.name}
                          className={cx(`sync-item${on ? '' : ' disabled'}`)}
                          title={on ? '' : stateLabel(row)}
                        >
                          <input
                            type="checkbox"
                            disabled={!on}
                            checked={on && targets.has(row.branch.name)}
                            onChange={() => toggleTarget(row.branch.name)}
                          />
                          <span className={cx(`sync-name${row.branch.current ? ' current' : ''}`)}>
                            {row.branch.name}
                          </span>
                          <span className={cx('sync-upstream')}>
                            {row.branch.upstream ? `← ${row.branch.upstream}` : ''}
                          </span>
                          <span className={cx('sync-counts')}>
                            {ahead > 0 ? `↑${ahead}` : ''}
                            {behind > 0 ? `↓${behind}` : ''}
                          </span>
                          <span className={cx(`sync-state st-${row.state}`)}>{stateLabel(row)}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div className={cx('sync-preview')}>
                    {commands.length > 0 ? (
                      <pre>{commands.map((c) => `git ${c.join(' ')}`).join('\n')}</pre>
                    ) : (
                      <span className={cx('sync-dim')}>更新するブランチがありません</span>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className={cx('dialog-buttons')}>
          <button className={cx('btn')} onClick={closeDialog}>
            キャンセル
          </button>
          <button className={cx('btn primary')} disabled={!canRun} onClick={doRun}>
            実行
          </button>
        </div>
      </div>
    </div>
  );
}
