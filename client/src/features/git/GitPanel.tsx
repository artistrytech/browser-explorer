import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useGit } from '../../stores/git';
import { useExplorer } from '../../stores/explorer';
import { useSettings } from '../../stores/settings';
import { useToast, toastError } from '../../stores/toast';
import { confirmDialog, promptDialog } from '../../stores/dialog';
import { DiffView } from './DiffView';
import type { GitBranch, GitCommit, GitFileStatus } from '../../types';

type GitTab = 'changes' | 'log' | 'branches';

function statusLabel(f: GitFileStatus, staged: boolean): string {
  const c = staged ? f.index : f.workingDir;
  const map: Record<string, string> = {
    M: '変更', A: '追加', D: '削除', R: '名前変更', C: 'コピー', U: '競合', '?': '未追跡',
  };
  return map[c] ?? c;
}

export function GitPanel() {
  const { repoRoot, status, refreshStatus } = useGit();
  const { addRepository, repositories } = useSettings();
  const show = useToast((s) => s.show);
  const [tab, setTab] = useState<GitTab>('changes');
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<{ title: string; text: string } | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [commitDetail, setCommitDetail] = useState<{
    hash: string; author: string; date: string; message: string; patch: string;
  } | null>(null);

  const explorerPath = useExplorer((s) => s.path);

  useEffect(() => {
    if (repoRoot && tab === 'log') {
      api.gitLog(repoRoot).then((r) => setCommits(r.commits)).catch(toastError);
    }
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
          <button
            className="btn"
            onClick={() =>
              void promptDialog('リポジトリを clone', '', { message: 'clone する URL を入力' }).then((url) => {
                if (!url) return;
                const name = url.split('/').pop()?.replace(/\.git$/, '') ?? 'repo';
                api
                  .gitClone(url, `${explorerPath}/${name}`)
                  .then(() => useExplorer.getState().refresh())
                  .then(() => show('success', 'clone しました'))
                  .catch(toastError);
              })
            }
          >
            clone
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

  const showFileDiff = (f: GitFileStatus, stagedSide: boolean) => {
    api
      .gitDiff(repoRoot, f.path, stagedSide)
      .then((r) => setDiff({ title: `${f.path} (${stagedSide ? 'ステージ vs HEAD' : '作業ツリー'})`, text: r.diff }))
      .catch(toastError);
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
        <button className="status-btn" disabled={busy} onClick={() => void run(() => api.gitFetch(repoRoot), 'fetch 完了')}>
          Fetch
        </button>
        <button className="status-btn" disabled={busy} onClick={() => void run(() => api.gitPull(repoRoot), 'pull 完了')}>
          Pull
        </button>
        <button className="status-btn" disabled={busy} onClick={() => void run(() => api.gitPush(repoRoot), 'push 完了')}>
          Push
        </button>
        <button
          className="status-btn"
          disabled={busy}
          onClick={() => void run(() => api.gitStash(repoRoot, 'save'), 'stash しました')}
        >
          Stash
        </button>
        <button
          className="status-btn"
          disabled={busy}
          onClick={() => void run(() => api.gitStash(repoRoot, 'pop'), 'stash pop しました')}
        >
          Pop
        </button>
        {!repositories.includes(repoRoot) && (
          <button className="status-btn" onClick={() => addRepository(repoRoot)} title="サイドバーに登録">
            ★ 登録
          </button>
        )}
        <span className="status-spacer" />
        <div className="git-tabs">
          {(['changes', 'log', 'branches'] as GitTab[]).map((t) => (
            <button
              key={t}
              className={`git-tab${tab === t ? ' active' : ''}`}
              onClick={() => {
                setTab(t);
                setDiff(null);
                setCommitDetail(null);
              }}
            >
              {t === 'changes' ? '変更' : t === 'log' ? 'ログ' : 'ブランチ'}
            </button>
          ))}
        </div>
      </div>

      <div className="git-body">
        <div className="git-left">
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
                      void run(() => api.gitCommit(repoRoot, message, amend), 'コミットしました').then(() => {
                        setMessage('');
                        setAmend(false);
                      })
                    }
                  >
                    Commit
                  </button>{' '}
                  <button
                    className="btn"
                    disabled={busy || (!message.trim() && !amend) || (staged.length === 0 && !amend)}
                    onClick={() =>
                      void run(
                        () => api.gitCommit(repoRoot, message, amend).then(() => api.gitPush(repoRoot)),
                        'コミットして push しました',
                      ).then(() => {
                        setMessage('');
                        setAmend(false);
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
            <div className="git-log">
              {commits.map((c) => (
                <button
                  key={c.hash}
                  className={`log-row${commitDetail?.hash === c.hash ? ' active' : ''}`}
                  onClick={() => api.gitShow(repoRoot, c.hash).then(setCommitDetail).catch(toastError)}
                >
                  <span className="log-graph">{c.parents.split(' ').filter(Boolean).length > 1 ? '⑂' : '●'}</span>
                  <span className="log-message">
                    {c.refs && <span className="log-refs">{c.refs} </span>}
                    {c.message}
                  </span>
                  <span className="log-meta">
                    {c.author} · {c.date.slice(0, 16)} · {c.hash.slice(0, 7)}
                  </span>
                </button>
              ))}
            </div>
          )}

          {tab === 'branches' && (
            <div className="git-branches">
              <button
                className="btn"
                onClick={() =>
                  void promptDialog('新しいブランチ', '', { message: '作成して切り替えるブランチ名' }).then(
                    (name) => {
                      if (name) void run(() => api.gitBranch(repoRoot, 'create', name), `${name} を作成しました`);
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
                        onClick={() => void run(() => api.gitBranch(repoRoot, 'checkout', b.name), `${b.name} に切替`)}
                      >
                        切替
                      </button>
                      <button
                        className="status-btn"
                        onClick={() => void run(() => api.gitMerge(repoRoot, b.name), `${b.name} をマージ`)}
                      >
                        マージ
                      </button>
                      <button
                        className="status-btn danger"
                        onClick={() =>
                          void confirmDialog('ブランチ削除', `${b.name} を削除しますか?`, true).then((ok) => {
                            if (ok) void run(() => api.gitBranch(repoRoot, 'delete', b.name), '削除しました');
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
          {commitDetail ? (
            <div className="commit-detail">
              <div className="commit-detail-head">
                <div>
                  <b>{commitDetail.message.split('\n')[0]}</b>
                </div>
                <div className="log-meta">
                  {commitDetail.author} · {commitDetail.date} · {commitDetail.hash.slice(0, 12)}
                </div>
              </div>
              <DiffView diff={commitDetail.patch} />
            </div>
          ) : diff ? (
            <>
              <div className="diff-title">{diff.title}</div>
              <DiffView diff={diff.text} />
            </>
          ) : (
            <div className="empty-hint">ファイルまたはコミットを選択すると差分を表示します</div>
          )}
        </div>
      </div>
    </div>
  );
}
