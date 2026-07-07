import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { loadGitView, saveGitView } from '../../lib/gitViewMemory';
import { saveEnteredChild } from '../../lib/focusMemory';
import { useContextMenu, MenuItem } from '../../components/ContextMenu';
import { useGit, GitTab } from '../../stores/git';
import { useExplorer } from '../../stores/explorer';
import { useSettings } from '../../stores/settings';
import { useToast, toastError } from '../../stores/toast';
import { confirmDialog, promptDialog } from '../../stores/dialog';
import { DiffView } from './DiffView';
import { GitGraph } from './GitGraph';
import { openCloneDialog } from './CloneDialog';
import { openConflictResolver } from './ConflictResolver';
import { runGitCommands } from './GitCommandDialog';
import { openPushDialog, defaultPushArgs } from './PushDialog';
import { openFetchDialog } from './FetchDialog';
import { openStashDialog } from './StashDialog';
import { openCommitDiff } from './DiffTab';
import type { CommitFile, CommitFilesResult, GitBranch, GitFileStatus } from '../../types';

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
  const [diff, setDiff] = useState<{ title: string; text: string } | null>(null);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [commitDetail, setCommitDetail] = useState<CommitFilesResult | null>(null);
  /** 差分ファイル一覧のフィルタ (パス部分一致)。sessionStorage に保持 */
  const [fileFilter, setFileFilter] = useState('');
  const openMenu = useContextMenu((s) => s.open);

  const explorerPath = useExplorer((s) => s.path);

  /** コミット選択: 詳細を取得しつつ sessionStorage に保持 (タブ復帰時に復元) */
  const selectCommit = (hash: string) => {
    if (!repoRoot) return;
    saveGitView(repoRoot, { hash });
    api.gitCommitFiles(repoRoot, hash).then(setCommitDetail).catch(toastError);
  };

  // タブ復帰/リポジトリ切替時: 保存済みの選択コミット・ファイルフィルタを復元
  useEffect(() => {
    setCommitDetail(null);
    if (!repoRoot) return;
    const saved = loadGitView(repoRoot);
    setFileFilter(saved?.filesFilter ?? '');
    if (saved?.hash) {
      api.gitCommitFiles(repoRoot, saved.hash).then(setCommitDetail).catch(() => {
        saveGitView(repoRoot, { hash: null }); // 消えたコミット (reset 等) は破棄
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
      <div className="git-panel">
        <div className="empty-hint">
          <p>このフォルダは Git リポジトリではありません。</p>
          <button
            className="btn"
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
          <button className="btn" onClick={() => openCloneDialog(explorerPath)}>
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

  // 差分ファイル一覧: パス部分一致フィルタ → 表示上限 (config.json の commitFilesLimit)
  const filterText = fileFilter.trim().toLowerCase();
  const matchedFiles = commitDetail
    ? filterText
      ? commitDetail.files.filter((f) => f.path.toLowerCase().includes(filterText))
      : commitDetail.files
    : [];
  const filesLimit = commitDetail?.limit ?? 100;
  const shownFiles = matchedFiles.slice(0, filesLimit);

  const showFileDiff = (f: GitFileStatus, stagedSide: boolean) => {
    api
      .gitDiff(repoRoot, f.path, stagedSide)
      .then((r) => setDiff({ title: `${f.path} (${stagedSide ? 'ステージ vs HEAD' : '作業ツリー'})`, text: r.diff }))
      .catch(toastError);
  };

  /** 差分ファイル行の右クリックメニュー。存在チェック後に開く (場所に移動の活性判定) */
  const commitFileMenu = (e: React.MouseEvent, f: CommitFile, hash: string) => {
    e.preventDefault();
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

  const fileRow = (f: GitFileStatus, stagedSide: boolean) => (
    <div key={`${stagedSide}-${f.path}`} className="git-file-row">
      <button className="git-file-name" title={f.path} onClick={() => showFileDiff(f, stagedSide)}>
        <span className="git-file-status">{statusLabel(f, stagedSide)}</span> {f.path}
      </button>
      {stagedSide ? (
        <button
          className="status-btn"
          title="ステージ解除"
          onClick={() => void run(() => api.gitUnstage(repoRoot, [f.path]))}
        >
          −
        </button>
      ) : (
        <>
          <button
            className="status-btn"
            title="ステージ"
            onClick={() => void run(() => api.gitStage(repoRoot, [f.path]))}
          >
            ＋
          </button>
          <button
            className="status-btn danger"
            title="変更を破棄"
            onClick={() =>
              void confirmDialog('変更を破棄', `${f.path} の変更を破棄しますか?`, true).then((ok) => {
                if (ok)
                  void run(
                    () => api.gitDiscard(repoRoot, [f.path]).then(() => useExplorer.getState().refresh()),
                    '破棄しました',
                  );
              })
            }
          >
            ↩
          </button>
        </>
      )}
    </div>
  );

  return (
    <div className="git-panel">
      <div className="git-header">
        <span className="git-repo-name" title={repoRoot}>
          🌿 {status?.branch ?? '?'}
          {status?.tracking ? ` ↑${status.ahead}↓${status.behind}` : ''}
        </span>
        {/* Fetch/Pull/Stash は即時実行せず、確認ダイアログを挟む (Push と同じフロー) */}
        <button className="status-btn" disabled={busy} onClick={openFetchDialog}>
          Fetch
        </button>
        <button
          className="status-btn"
          disabled={busy}
          onClick={() =>
            void confirmDialog('Pull', 'git pull を実行しますか?').then((ok) => {
              if (ok) void runGitCommands(repoRoot, [['pull']], 'Pull');
            })
          }
        >
          Pull
        </button>
        <button className="status-btn" disabled={busy} onClick={openPushDialog}>
          Push
        </button>
        <button className="status-btn" disabled={busy} onClick={openStashDialog}>
          Stash
        </button>
        {!repositories.includes(repoRoot) && (
          <button className="status-btn" onClick={() => addRepository(repoRoot)} title="サイドバーに登録">
            ★ 登録
          </button>
        )}
        <span className="status-spacer" />
      </div>

      {mergeState.inProgress && (
        <div className="merge-banner">
          ⚠ {mergeState.inProgress === 'merge' ? 'マージ' : mergeState.inProgress === 'rebase' ? 'リベース' : 'cherry-pick'}
          が進行中です
          {mergeState.conflicted.length > 0 && ` (競合 ${mergeState.conflicted.length} 件)`}
          {mergeState.conflicted.length > 0 ? (
            <button className="btn" onClick={() => openConflictResolver('')}>
              競合を解消…
            </button>
          ) : (
            <button
              className="btn"
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
            className="btn danger"
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

      <div className="git-body">
        {/* ログタブはスクロールを .graph-rows 側に持たせる (スクロール位置の保存/復元のため) */}
        <div className={`git-left${tab === 'log' ? ' graph-host' : ''}`}>
          {tab === 'changes' && (
            <>
              <div className="git-section-title">
                ステージ済み ({staged.length})
                {staged.length > 0 && (
                  <button
                    className="status-btn"
                    onClick={() => void run(() => api.gitUnstage(repoRoot, staged.map((f) => f.path)))}
                  >
                    すべて解除
                  </button>
                )}
              </div>
              {staged.map((f) => fileRow(f, true))}
              <div className="git-section-title">
                変更 ({unstaged.length})
                {unstaged.length > 0 && (
                  <button
                    className="status-btn"
                    onClick={() => void run(() => api.gitStage(repoRoot, unstaged.map((f) => f.path)))}
                  >
                    すべてステージ
                  </button>
                )}
              </div>
              {unstaged.map((f) => fileRow(f, false))}

              <div className="commit-box">
                <textarea
                  className="commit-message"
                  placeholder="コミットメッセージ"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
                <label className="amend-label">
                  <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} />
                  amend (直前のコミットを修正)
                </label>
                <div>
                  <button
                    className="btn primary"
                    disabled={busy || (!message.trim() && !amend) || (staged.length === 0 && !amend)}
                    onClick={() =>
                      void runGitCommands(repoRoot, [commitArgs(message, amend)], 'Commit').then((ok) => {
                        if (ok) {
                          setMessage('');
                          setAmend(false);
                        }
                      })
                    }
                  >
                    Commit
                  </button>{' '}
                  <button
                    className="btn"
                    disabled={busy || (!message.trim() && !amend) || (staged.length === 0 && !amend)}
                    onClick={() =>
                      void runGitCommands(
                        repoRoot,
                        [commitArgs(message, amend), defaultPushArgs(status ?? { branch: null, tracking: null })],
                        'Commit & Push',
                      ).then((ok) => {
                        if (ok) {
                          setMessage('');
                          setAmend(false);
                        }
                      })
                    }
                  >
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
                <div className="log-filter-bar">
                  <span className="log-filter-path" title={logFilter.path}>
                    {logFilter.path} の履歴{logFilter.follow ? ' (リネーム追跡)' : ''}
                  </span>
                  <button className="status-btn" onClick={() => useGit.getState().showLogFor('', false)}>
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
            <div className="git-branches">
              <button
                className="btn"
                onClick={() =>
                  void promptDialog('新しいブランチ', '', { message: '作成して切り替えるブランチ名' }).then(
                    (name) => {
                      if (name) void runGitCommands(repoRoot, [['checkout', '-b', name]], 'ブランチ作成');
                    },
                  )
                }
              >
                ＋ ブランチ作成
              </button>
              {branches.map((b) => (
                <div key={b.name} className="branch-row">
                  <span className={b.current ? 'branch-current' : ''}>
                    {b.current ? '● ' : '  '}
                    {b.name}
                  </span>
                  {!b.current && !b.name.startsWith('remotes/') && (
                    <>
                      <button
                        className="status-btn"
                        onClick={() => void runGitCommands(repoRoot, [['checkout', b.name]], 'ブランチ切替')}
                      >
                        切替
                      </button>
                      <button
                        className="status-btn"
                        onClick={() => void runGitCommands(repoRoot, [['merge', b.name]], 'マージ')}
                      >
                        マージ
                      </button>
                      <button
                        className="status-btn danger"
                        onClick={() =>
                          void confirmDialog('ブランチ削除', `${b.name} を削除しますか?`, true).then((ok) => {
                            if (ok) void runGitCommands(repoRoot, [['branch', '-d', b.name]], 'ブランチ削除');
                          })
                        }
                      >
                        削除
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="git-right">
          {/* 差分ファイル一覧はログタブ選択時のみ表示 (変更/ブランチでは非表示) */}
          {tab === 'log' ? (
            commitDetail ? (
              <div className="commit-detail">
                <div className="commit-detail-head">
                  <div>
                    <b>{commitDetail.message.split('\n')[0]}</b>
                  </div>
                  <div className="log-meta">
                    {commitDetail.author} · {commitDetail.date} · {commitDetail.hash.slice(0, 12)}
                  </div>
                </div>
                <div className="cf-filter-bar">
                  <input
                    className="cf-filter"
                    type="text"
                    placeholder="パスで絞り込み (部分一致)"
                    value={fileFilter}
                    onChange={(e) => changeFileFilter(e.target.value)}
                  />
                  <span className="cf-count">
                    {matchedFiles.length}/{commitDetail.files.length} 件
                  </span>
                </div>
                {/* 差分ファイル一覧: ダブルクリックで 2 ペイン差分タブ、右クリックでメニュー */}
                <table className="commit-files">
                  <thead>
                    <tr>
                      <th>ステータス</th>
                      <th>ファイル</th>
                      <th className="num">追加</th>
                      <th className="num">削除</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownFiles.map((f) => {
                      const st = COMMIT_FILE_STATUS[f.status] ?? { label: f.status, cls: 'st-mod' };
                      return (
                        <tr
                          key={f.path}
                          title="ダブルクリックで差分を表示 / 右クリックでメニュー"
                          onDoubleClick={() =>
                            openCommitDiff({
                              repo: repoRoot,
                              hash: commitDetail.hash,
                              path: f.path,
                              subject: commitDetail.message.split('\n')[0],
                            })
                          }
                          onContextMenu={(e) => commitFileMenu(e, f, commitDetail.hash)}
                        >
                          <td className={`cf-status ${st.cls}`}>{st.label}</td>
                          <td className="cf-path" title={f.path}>{f.path}</td>
                          <td className="num cf-added">{f.binary ? '–' : `+${f.added ?? 0}`}</td>
                          <td className="num cf-deleted">{f.binary ? '–' : `−${f.deleted ?? 0}`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {commitDetail.files.length === 0 && <div className="empty-hint">変更ファイルはありません</div>}
                {commitDetail.files.length > 0 && matchedFiles.length === 0 && (
                  <div className="empty-hint">フィルタに一致するファイルがありません</div>
                )}
                {matchedFiles.length > shownFiles.length && (
                  <div className="commit-files-hint">
                    表示上限 {filesLimit} 件 (該当 {matchedFiles.length} 件)。上限は config.json の
                    commitFilesLimit で変更できます
                  </div>
                )}
                <div className="commit-files-hint">行をダブルクリックすると 2 ペインの差分を表示します</div>
              </div>
            ) : (
              <div className="empty-hint">コミットを選択すると差分ファイル一覧を表示します</div>
            )
          ) : diff ? (
            <>
              <div className="diff-title">{diff.title}</div>
              <DiffView diff={diff.text} />
            </>
          ) : (
            <div className="empty-hint">ファイルを選択すると差分を表示します</div>
          )}
        </div>
      </div>
    </div>
  );
}
