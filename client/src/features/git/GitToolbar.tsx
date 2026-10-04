import type { ReactNode } from 'react';
import { api } from '../../api/client';
import { useContextMenu, MenuItem } from '../../components/ContextMenu';
import { useGit } from '../../stores/git';
import { useSettings } from '../../stores/settings';
import { useToast, toastError } from '../../stores/toast';
import { confirmDialog } from '../../stores/dialog';
import { openConflictResolver, operationLabel } from '../../stores/conflict';
import { runGitCommands } from './GitCommandDialog';
import { openSyncDialog } from './SyncDialog';
import { openStashDialog } from './StashDialog';
import { openAuthDialog } from './AuthDialog';
import { openDiscardAllDialog } from './DiscardAllDialog';
import { backupBranchRegex } from '../../lib/backupBranch';
import type { RebaseBackup } from '../../types';
import styles from './GitPanel.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * Git タブ群とファイルタブで共通のツールバー (現在のブランチ・同期・Stash・認証・ツール・登録)。
 * リポジトリ外では何も出さない。
 */
export function GitToolbar({
  busy = false,
  lockBranchOps = false,
  onBackupDeleted,
  children,
}: {
  /** 操作実行中 (同期/Stash を止める) */
  busy?: boolean;
  /** ブランチに影響する操作を止める (ブランチの一括削除モード中など) */
  lockBranchOps?: boolean;
  /** バックアップブランチを削除した後に呼ぶ (ブランチ一覧の再読込など) */
  onBackupDeleted?: () => void;
  /** 右端に並べる追加ボタン */
  children?: ReactNode;
}) {
  const repoRoot = useGit((s) => s.repoRoot);
  const status = useGit((s) => s.status);
  const repositories = useSettings((s) => s.repositories);
  const addRepository = useSettings((s) => s.addRepository);
  const backupPattern = useSettings((s) => s.settings.backupBranchPattern);
  const show = useToast((s) => s.show);
  const openMenu = useContextMenu((s) => s.open);

  if (!repoRoot) return null;

  /**
   * 「ツール」メニュー: 変更の一括破棄 / バックアップブランチの削除。
   * バックアップは設定の名前パターンに一致するもの (+ 旧方式の backup/rebase/*)
   */
  const openToolsMenu = (e: React.MouseEvent) => {
    const { clientX: x, clientY: y } = e;
    const pattern = backupBranchRegex(backupPattern)?.source ?? '';
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
            .gitRebaseBackupDelete(repoRoot, bk.name, pattern)
            .then(() => {
              show('success', 'バックアップブランチを削除しました');
              onBackupDeleted?.();
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
        label: 'バックアップブランチを削除',
        submenu: backupItems,
      },
    ];
    void api
      .gitRebaseBackups(repoRoot, pattern)
      .then(({ backups }) => {
        const backupItems =
          backups.length > 0
            ? backups.map(deleteItem)
            : [{ label: '(バックアップはありません)', disabled: true }];
        openMenu(x, y, buildMenu(backupItems));
      })
      .catch(() => openMenu(x, y, buildMenu([{ label: '(取得に失敗しました)', disabled: true }])));
  };

  return (
    <div className={cx("git-header")}>
      <span className={cx("git-repo-name")} title={repoRoot}>
        🌿 {status?.branch ?? '?'}
        {status?.tracking ? ` ↑${status.ahead}↓${status.behind}` : ''}
      </span>
      {/* リモートとのやり取り (Push/Pull/Fetch/一括同期) は「同期」ダイアログにまとめ、
          そこでタブを選んで実行する。Stash と同じく即時実行はしない */}
      <button
        className={cx("status-btn")}
        disabled={busy || lockBranchOps}
        title="Push / Pull / Fetch / ブランチの一括同期"
        onClick={() => openSyncDialog()}
      >
        ⟳ 同期
      </button>
      <button className={cx("status-btn")} disabled={busy || lockBranchOps} onClick={openStashDialog}>
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
        title="バックアップブランチの削除など"
        disabled={lockBranchOps}
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
      {children}
    </div>
  );
}

/** 進行中の操作 (merge/rebase/cherry-pick) や未解決の競合 (stash 復元 / cherry-pick --no-commit) を知らせる帯 */
export function GitMergeBanner() {
  const repoRoot = useGit((s) => s.repoRoot);
  const mergeState = useGit((s) => s.mergeState);

  if (!repoRoot || !(mergeState.inProgress || mergeState.conflicted.length > 0)) return null;

  return (
    <div className={cx("merge-banner")}>
      {mergeState.inProgress ? (
        <>
          ⚠ {operationLabel(mergeState.inProgress)}が進行中です
          {mergeState.conflicted.length > 0 && ` (競合 ${mergeState.conflicted.length} 件)`}
        </>
      ) : (
        <>
          ⚠ 未解決の競合が {mergeState.conflicted.length} 件あります (stash の復元 / cherry-pick
          --no-commit など)
        </>
      )}
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
          void confirmDialog(
            '中止',
            mergeState.inProgress
              ? '進行中の操作を中止して開始前の状態へ戻します。よろしいですか?'
              : '適用された変更と競合の解決結果を取り消し、HEAD の状態へ戻します (git reset --merge)。\n' +
                  'stash から復元した場合、退避は残るのでやり直せます。よろしいですか?',
            true,
          ).then((ok) => {
            if (ok)
              void runGitCommands(
                repoRoot,
                [
                  mergeState.inProgress === 'merge'
                    ? ['merge', '--abort']
                    : mergeState.inProgress === 'rebase'
                      ? ['rebase', '--abort']
                      : mergeState.inProgress === 'cherry-pick'
                        ? ['cherry-pick', '--abort']
                        : ['reset', '--merge'],
                ],
                '中止',
              );
          })
        }
      >
        {mergeState.inProgress ? '中止' : '取り消す'}
      </button>
    </div>
  );
}
