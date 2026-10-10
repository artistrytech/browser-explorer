import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import { useGit } from '../../stores/git';
import { toastError, useToast } from '../../stores/toast';
import styles from './SyncDialog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';
import type { GitRemote } from '../../types';

const cx = createCssModuleClassNames(styles);

/**
 * 同期ダイアログの「リモート」タブ: git remote の追加 / 変更 / 削除と接続テスト。
 * 他のタブと違い操作はその場で反映するので、ダイアログ下部の「実行」は使わない。
 * 削除の確認は行内で行う (共通の確認ダイアログは同期ダイアログの背面に出てしまうため)。
 */

interface Props {
  repoRoot: string;
  /** 一覧 (親が持つ。Push タブのリモート候補にも使う) */
  remotes: GitRemote[] | null;
  reload: () => Promise<void>;
  /** 名前を変えたときに親へ知らせる (Push タブのリモート欄を追従させる) */
  onRenamed: (from: string, to: string) => void;
}

interface TestResult {
  name: string;
  ok: boolean;
  output: string;
}

export function SyncRemoteTab({ repoRoot, remotes, reload, onRenamed }: Props) {
  const show = useToast((s) => s.show);
  /** 編集中のリモート名。null なら追加フォーム */
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [pushUrl, setPushUrl] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);

  // 1 件も無いリポジトリでは、追加フォームに origin を入れておく
  useEffect(() => {
    if (remotes && remotes.length === 0 && editing === null && !name) setName('origin');
    // 一覧が届いたときだけ見る (入力中の値は上書きしない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remotes]);

  const resetForm = () => {
    setEditing(null);
    setName('');
    setUrl('');
    setPushUrl('');
  };

  const startEdit = (r: GitRemote) => {
    setConfirmRemove(null);
    setEditing(r.name);
    setName(r.name);
    setUrl(r.fetchUrl);
    setPushUrl(r.pushUrl === r.fetchUrl ? '' : r.pushUrl);
  };

  /** 変更後は一覧と、追跡先の表示 (rename / remove で変わる) を読み直す */
  const afterChange = async (message: string) => {
    show('success', message);
    await reload();
    void useGit.getState().refreshStatus();
  };

  const trimmedName = name.trim();
  const trimmedUrl = url.trim();
  const duplicate =
    !!trimmedName && trimmedName !== editing && (remotes ?? []).some((r) => r.name === trimmedName);
  const canSubmit = !busy && !!trimmedName && !!trimmedUrl && !duplicate;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    const from = editing;
    const req = from
      ? api.gitRemote(repoRoot, {
          action: 'update',
          name: from,
          newName: trimmedName,
          url: trimmedUrl,
          pushUrl: pushUrl.trim(),
        })
      : api.gitRemote(repoRoot, { action: 'add', name: trimmedName, url: trimmedUrl, pushUrl: pushUrl.trim() });
    req
      .then(async () => {
        if (from && from !== trimmedName) onRenamed(from, trimmedName);
        resetForm();
        await afterChange(from ? `リモート ${trimmedName} を更新しました` : `リモート ${trimmedName} を追加しました`);
      })
      .catch(toastError)
      .finally(() => setBusy(false));
  };

  const remove = (target: string) => {
    setBusy(true);
    api
      .gitRemote(repoRoot, { action: 'remove', name: target })
      .then(async () => {
        setConfirmRemove(null);
        if (editing === target) resetForm();
        if (test?.name === target) setTest(null);
        await afterChange(`リモート ${target} を削除しました`);
      })
      .catch(toastError)
      .finally(() => setBusy(false));
  };

  /** 認証設定ダイアログと同じ ls-remote で到達できるか確かめる */
  const runTest = (target: string) => {
    setTesting(target);
    setTest(null);
    api
      .gitAuthTest(repoRoot, target)
      .then((r) => setTest({ name: target, ok: r.ok, output: r.output }))
      .catch(toastError)
      .finally(() => setTesting(null));
  };

  return (
    <div className={cx('sync-form')}>
      <div className={cx('sync-row')}>
        <span>リモートの追加・変更・削除を行います (git remote)。</span>
        <span className={cx('sync-actions')}>
          <button className={cx('btn small')} disabled={busy} onClick={() => void reload()}>
            再読み込み
          </button>
        </span>
      </div>

      <div className={cx('sync-list remote-list')}>
        {remotes === null && <div className={cx('sync-dim')}>読み込み中…</div>}
        {remotes?.length === 0 && <div className={cx('sync-dim')}>リモートがありません</div>}
        {remotes?.map((r) => {
          const removing = confirmRemove === r.name;
          return (
            <div key={r.name} className={cx(`remote-item${editing === r.name ? ' editing' : ''}`)}>
              <span className={cx('remote-name')} title={r.name}>
                {r.name}
              </span>
              <span className={cx('remote-urls')}>
                <span className={cx('remote-url')} title={r.fetchUrl}>
                  {r.fetchUrl}
                </span>
                {r.pushUrl !== r.fetchUrl && (
                  <span className={cx('remote-url push')} title={r.pushUrl}>
                    push: {r.pushUrl}
                  </span>
                )}
              </span>
              <span className={cx('remote-buttons')}>
                {removing ? (
                  <>
                    <span className={cx('remote-confirm')}>削除しますか?</span>
                    <button className={cx('btn small danger')} disabled={busy} onClick={() => remove(r.name)}>
                      削除
                    </button>
                    <button className={cx('btn small')} disabled={busy} onClick={() => setConfirmRemove(null)}>
                      やめる
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className={cx('btn small')}
                      disabled={busy || testing !== null}
                      onClick={() => runTest(r.name)}
                    >
                      {testing === r.name ? 'テスト中…' : '接続テスト'}
                    </button>
                    <button className={cx('btn small')} disabled={busy} onClick={() => startEdit(r)}>
                      編集
                    </button>
                    <button className={cx('btn small')} disabled={busy} onClick={() => setConfirmRemove(r.name)}>
                      削除
                    </button>
                  </>
                )}
              </span>
              {removing && (
                <span className={cx('remote-warn')}>
                  追跡ブランチ ({r.name}/*) と、各ブランチの追跡先の設定も削除されます。
                </span>
              )}
            </div>
          );
        })}
      </div>

      {test && (
        <div className={cx('remote-test')}>
          <div className={cx(`remote-test-status${test.ok ? ' ok' : ' error'}`)}>
            {test.ok ? `✔ ${test.name} に接続できました` : `✖ ${test.name} に接続できませんでした`}
          </div>
          {!test.ok && <pre className={cx('sync-error')}>{test.output || '(出力なし)'}</pre>}
        </div>
      )}

      {/* Enter で送信できるよう form にする (このタブでは同期ダイアログの Enter = 実行 を無効にしている) */}
      <form className={cx('remote-editor')} onSubmit={submit}>
        <div className={cx('remote-editor-title')}>
          {editing ? `リモート「${editing}」を編集` : 'リモートを追加'}
        </div>
        <label className={cx('sync-row')}>
          <span className={cx('sync-label')}>名前:</span>
          <input
            className={cx('sync-input small')}
            value={name}
            placeholder="origin"
            onChange={(e) => setName(e.target.value)}
          />
          {duplicate && <span className={cx('remote-invalid')}>同名のリモートがあります</span>}
        </label>
        <label className={cx('sync-row')}>
          <span className={cx('sync-label')}>URL:</span>
          <input
            className={cx('sync-input')}
            value={url}
            placeholder="https://… / git@host:owner/repo.git"
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <label className={cx('sync-row')}>
          <span className={cx('sync-label')}>Push URL:</span>
          <input
            className={cx('sync-input')}
            value={pushUrl}
            placeholder="(空欄で URL と同じ)"
            onChange={(e) => setPushUrl(e.target.value)}
          />
        </label>
        {editing && editing !== trimmedName && trimmedName && !duplicate && (
          <div className={cx('sync-row sync-note')}>
            名前を変えると、追跡ブランチと各ブランチの追跡先も {trimmedName}/… に付け替わります。
          </div>
        )}
        <div className={cx('sync-row remote-editor-buttons')}>
          {editing && (
            <button type="button" className={cx('btn small')} disabled={busy} onClick={resetForm}>
              編集をやめる
            </button>
          )}
          <button type="submit" className={cx('btn small primary')} disabled={!canSubmit}>
            {editing ? '保存' : '追加'}
          </button>
        </div>
      </form>
    </div>
  );
}
