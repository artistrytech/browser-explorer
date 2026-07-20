import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { useGit } from '../../stores/git';
import { toastError, useToast } from '../../stores/toast';
import styles from './AuthDialog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * リポジトリ単位の認証設定 (A 案)。
 * このアプリはパスフレーズやトークンといった秘密情報を保持せず、
 * 「どの認証を使うか」(SSH 鍵ファイルのパス / HTTPS の資格情報ヘルパー名) だけを保存する。
 * 実際の解錠は ssh-agent / OS の資格情報マネージャーに委ねる。
 */

interface AuthDialogStore {
  open: boolean;
  show: () => void;
  close: () => void;
}

export const useAuthDialog = create<AuthDialogStore>((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));

export function openAuthDialog(): void {
  useAuthDialog.getState().show();
}

export function AuthDialog() {
  const { open, close } = useAuthDialog();
  const repoRoot = useGit((s) => s.repoRoot);
  const show = useToast((s) => s.show);
  const [sshKey, setSshKey] = useState('');
  const [helper, setHelper] = useState('');
  const [keys, setKeys] = useState<string[]>([]);
  const [remotes, setRemotes] = useState<{ name: string; url: string }[]>([]);
  const [remote, setRemote] = useState('origin');
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; command: string; output: string } | null>(null);

  useEffect(() => {
    if (!open || !repoRoot) return;
    setResult(null);
    setLoading(true);
    api
      .gitAuthGet(repoRoot)
      .then((r) => {
        setSshKey(r.auth.sshKey);
        setHelper(r.auth.credentialHelper);
        setKeys(r.sshKeys);
        setRemotes(r.remotes);
        setRemote(r.remotes[0]?.name ?? 'origin');
      })
      .catch(toastError)
      .finally(() => setLoading(false));
  }, [open, repoRoot]);

  if (!open || !repoRoot) return null;

  const save = () =>
    api
      .gitAuthSet(repoRoot, sshKey.trim(), helper.trim())
      .then(() => {
        show('success', '認証設定を保存しました');
        close();
      })
      .catch(toastError);

  // 未保存の設定でテストできるよう、テスト前に保存してから ls-remote する
  const test = () => {
    setTesting(true);
    setResult(null);
    api
      .gitAuthSet(repoRoot, sshKey.trim(), helper.trim())
      .then(() => api.gitAuthTest(repoRoot, remote))
      .then(setResult)
      .catch(toastError)
      .finally(() => setTesting(false));
  };

  const usesSsh = remotes.some((r) => /^(git@|ssh:\/\/)/.test(r.url));

  return (
    <div className={cx("dialog-backdrop")}>
      <div className={cx("dialog auth-dialog")}>
        <div className={cx("dialog-title")}>認証設定 (このリポジトリ)</div>
        {loading ? (
          <div className={cx("empty-hint")}>読み込み中…</div>
        ) : (
          <div className={cx("clone-form")}>
            <div className={cx("auth-note")}>
              秘密情報 (パスフレーズ・トークン) はアプリに保存しません。使用する鍵とヘルパーの指定のみ保存します。
            </div>

            <div className={cx("stash-section-title")}>SSH (git@… / ssh://…)</div>
            <label className={cx("clone-row")}>
              <span className={cx("clone-label wide")}>秘密鍵:</span>
              <select className={cx("clone-input")} value={sshKey} onChange={(e) => setSshKey(e.target.value)}>
                <option value="">(既定の鍵を使う)</option>
                {keys.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
                {sshKey && !keys.includes(sshKey) && <option value={sshKey}>{sshKey}</option>}
              </select>
            </label>
            <label className={cx("clone-row")}>
              <span className={cx("clone-label wide")}>鍵のパス:</span>
              <input
                className={cx("clone-input")}
                value={sshKey}
                placeholder="~/.ssh 以外の鍵は直接パスを入力"
                onChange={(e) => setSshKey(e.target.value)}
              />
            </label>
            {usesSsh && (
              <div className={cx("auth-note")}>
                パスフレーズ付きの鍵は ssh-agent への登録が必要です (未登録だと認証エラーになります)。
              </div>
            )}

            <div className={cx("stash-section-title")}>HTTPS</div>
            <label className={cx("clone-row")}>
              <span className={cx("clone-label wide")}>資格情報ヘルパー:</span>
              <input
                className={cx("clone-input")}
                value={helper}
                placeholder="(空欄で git の既定設定に従う) 例: manager"
                onChange={(e) => setHelper(e.target.value)}
              />
            </label>

            <div className={cx("stash-section-title")}>接続テスト</div>
            <div className={cx("clone-row")}>
              <span className={cx("clone-label wide")}>リモート:</span>
              <select className={cx("clone-input small")} value={remote} onChange={(e) => setRemote(e.target.value)}>
                {remotes.length === 0 && <option value="origin">origin</option>}
                {remotes.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </select>
              <button className={cx("btn")} disabled={testing} onClick={test}>
                {testing ? 'テスト中…' : '接続テスト'}
              </button>
            </div>
            {remotes.find((r) => r.name === remote) && (
              <div className={cx("clone-row auth-note")}>{remotes.find((r) => r.name === remote)?.url}</div>
            )}
            {result && (
              <>
                <div className={cx(`gitcmd-status ${result.ok ? 'ok' : 'error'}`)}>
                  {result.ok ? '✔ 接続に成功しました' : '✖ 接続に失敗しました'}
                </div>
                <pre className={cx(`gitcmd-output${result.ok ? '' : ' failed'}`)}>{result.output || '(出力なし)'}</pre>
              </>
            )}
          </div>
        )}
        <div className={cx("dialog-buttons")}>
          <button className={cx("btn")} onClick={close}>
            キャンセル
          </button>
          <button className={cx("btn primary")} disabled={loading} onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
