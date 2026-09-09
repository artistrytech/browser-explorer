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
 * 同期ダイアログ (ブランチの一括同期):
 * ① 開いた時点で `git fetch [--prune]` を実行し、最新の ahead/behind を取り出す
 * ② 早送りできるローカルブランチを、チェックアウトせずまとめて更新する
 *    (`git fetch <remote> <remoteRef>:refs/heads/<local>`)
 *
 * git の制約が UI をそのまま決めている:
 * - チェックアウト中のブランチへは refspec 付き fetch が拒否されるので、
 *   現在のブランチだけは `merge --ff-only` で早送りする
 * - 早送りできない (分岐した) ブランチは強制更新すると履歴を失うため、
 *   チェック不可にして理由を出すだけに留める (手動マージ/リベースに任せる)
 */

/** ブランチごとの同期可否 */
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
  /** 対象を 1 ブランチに絞る (ブランチ一覧の「リモートから更新」用)。null なら全ローカルブランチ */
  onlyBranch: string | null;
  show: (onlyBranch: string | null) => void;
  close: () => void;
}

export const useSyncDialog = create<SyncDialogStore>((set) => ({
  open: false,
  onlyBranch: null,
  show: (onlyBranch) => set({ open: true, onlyBranch }),
  close: () => set({ open: false }),
}));

/** ブランチ名を渡すとそのブランチだけを対象にする */
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
  const { open, onlyBranch, close } = useSyncDialog();
  const repoRoot = useGit((s) => s.repoRoot);
  // Prune は既定で ON (不要になった追跡ブランチを残さない)
  const [prune, setPrune] = useState(true);
  const [phase, setPhase] = useState<'fetching' | 'ready' | 'failed'>('fetching');
  const [fetchError, setFetchError] = useState('');
  const [rows, setRows] = useState<SyncRow[]>([]);
  const [targets, setTargets] = useState<Set<string>>(new Set());
  /**
   * 取得の世代番号。取得中に閉じたり「再取得」を連打したりしたときに、
   * 古いレスポンスが新しい結果を上書きしないようにする
   */
  const reqId = useRef(0);

  /** ① リモートを取得し、取得後の ahead/behind でブランチ一覧を組み直す */
  const reload = useCallback(
    async (usePrune: boolean) => {
      if (!repoRoot) return;
      const id = ++reqId.current;
      const stale = () => id !== reqId.current;
      setPhase('fetching');
      setFetchError('');
      setRows([]);
      setTargets(new Set());
      try {
        const r = await api.gitExec(repoRoot, ['fetch', ...(usePrune ? ['--prune'] : [])]);
        if (stale()) return;
        if (!r.ok) {
          setFetchError(r.output || '(出力なし)');
          setPhase('failed');
          return;
        }
        const { branches } = await api.gitBranches(repoRoot);
        if (stale()) return;
        const next = branches
          .filter((b) => !b.name.startsWith('remotes/'))
          .filter((b) => !onlyBranch || b.name === onlyBranch)
          .map<SyncRow>((branch) => ({ branch, state: classify(branch) }))
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
    },
    [repoRoot, onlyBranch],
  );

  /** 閉じたら進行中の取得結果は捨てる (fetch 自体は無害なので中断はしない) */
  const closeDialog = useCallback(() => {
    reqId.current++;
    close();
  }, [close]);

  // 開いたら自動で ① を実行する (fetch は破壊的でないので確認は挟まない)
  useEffect(() => {
    if (!open) return;
    setPrune(true);
    void reload(true);
  }, [open, reload]);

  const syncable = rows.filter((r) => r.state === 'ff');
  const targetRows = syncable.filter((r) => targets.has(r.branch.name));

  const toggleTarget = (name: string) => {
    const next = new Set(targets);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setTargets(next);
  };

  /**
   * 実行するコマンド列。
   * refspec fetch はリモートごとに 1 コマンドへまとめ、
   * 現在のブランチだけは早送りマージにする (refspec fetch が使えないため)。
   */
  const buildCommands = (): string[][] => {
    const byRemote = new Map<string, string[]>();
    let currentRow: SyncRow | null = null;
    for (const row of targetRows) {
      if (row.branch.current) {
        currentRow = row;
        continue;
      }
      const remote = row.branch.upstreamRemote as string;
      const specs = byRemote.get(remote) ?? [];
      specs.push(`${row.branch.upstreamRef}:refs/heads/${row.branch.name}`);
      byRemote.set(remote, specs);
    }
    const commands = [...byRemote].map(([remote, specs]) => ['fetch', remote, ...specs]);
    if (currentRow) commands.push(['merge', '--ff-only', currentRow.branch.upstream as string]);
    return commands;
  };

  const commands = phase === 'ready' ? buildCommands() : [];
  const canSync = phase === 'ready' && commands.length > 0;

  const doSync = () => {
    if (!repoRoot || !canSync) return;
    closeDialog();
    void runGitCommands(repoRoot, commands, '同期', { continueOnError: true });
  };

  // 取得は時間がかかることがあるので、実行中でも閉じられるようにしておく
  const dialogRef = useDialogKeys({
    enabled: open,
    onEnter: canSync ? doSync : null,
    onEscape: closeDialog,
  });

  if (!open || !repoRoot) return null;

  return (
    <div ref={dialogRef} className={cx('dialog-backdrop')}>
      <div className={cx('dialog sync-dialog')}>
        <div className={cx('dialog-title')}>{onlyBranch ? `同期: ${onlyBranch}` : '同期'}</div>

        {/* ① リモートの取得 */}
        <div className={cx('sync-section')}>
          <div className={cx('sync-step')}>① リモートの状態を取得</div>
          <div className={cx('sync-row')}>
            <label className={cx('sync-inline')}>
              <input
                type="checkbox"
                checked={prune}
                disabled={phase === 'fetching'}
                onChange={(e) => setPrune(e.target.checked)}
              />
              <span>Prune: リモートで削除されたブランチの追跡情報も削除 (--prune)</span>
            </label>
            <button
              className={cx('btn small')}
              disabled={phase === 'fetching'}
              onClick={() => void reload(prune)}
            >
              再取得
            </button>
          </div>
          {phase === 'fetching' && (
            <div className={cx('sync-row sync-dim')}>
              <span className={cx('spinner-ring small')} /> git fetch 実行中…
            </div>
          )}
          {phase === 'failed' && <pre className={cx('sync-error')}>{fetchError}</pre>}
        </div>

        {/* ② 更新するローカルブランチ */}
        {phase === 'ready' && (
          <div className={cx('sync-section')}>
            <div className={cx('sync-step')}>
              ② 更新するローカルブランチ
              {syncable.length > 0 && (
                <span className={cx('sync-select-all')}>
                  <button
                    className={cx('btn small')}
                    onClick={() => setTargets(new Set(syncable.map((r) => r.branch.name)))}
                  >
                    すべて選択
                  </button>
                  <button className={cx('btn small')} onClick={() => setTargets(new Set())}>
                    解除
                  </button>
                </span>
              )}
            </div>
            <div className={cx('sync-list')}>
              {rows.length === 0 && <div className={cx('sync-dim')}>ローカルブランチがありません</div>}
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
          </div>
        )}

        <div className={cx('dialog-buttons')}>
          <button className={cx('btn')} onClick={closeDialog}>
            {canSync ? 'キャンセル' : '閉じる'}
          </button>
          <button className={cx('btn primary')} disabled={!canSync} onClick={doSync}>
            同期 ({targetRows.length})
          </button>
        </div>
      </div>
    </div>
  );
}
