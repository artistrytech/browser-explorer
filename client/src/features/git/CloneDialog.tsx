import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { onWsEvent } from '../../api/ws';
import { useExplorer } from '../../stores/explorer';
import { useSettings } from '../../stores/settings';
import { useToast, toastError } from '../../stores/toast';
import { joinPath } from '../../lib/paths';

/** Git Clone ダイアログ (002.md §3): TortoiseGit のクローンダイアログに倣った UI */

interface CloneDialogStore {
  open: boolean;
  baseDir: string;
  show: (baseDir: string) => void;
  close: () => void;
}

export const useCloneDialog = create<CloneDialogStore>((set) => ({
  open: false,
  baseDir: '',
  show: (baseDir) => set({ open: true, baseDir }),
  close: () => set({ open: false }),
}));

export function openCloneDialog(baseDir: string): void {
  useCloneDialog.getState().show(baseDir);
}

function repoNameFromUrl(url: string): string {
  const last = url.replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  return last.replace(/\.git$/, '') || 'repo';
}

interface ProgressMsg {
  id: string;
  line?: string;
  done?: boolean;
  ok?: boolean;
  error?: string;
}

export function CloneDialog() {
  const { open, baseDir, close } = useCloneDialog();
  const [url, setUrl] = useState('');
  const [dir, setDir] = useState('');
  const [dirTouched, setDirTouched] = useState(false);
  const [useBranch, setUseBranch] = useState(false);
  const [branch, setBranch] = useState('main');
  const [useDepth, setUseDepth] = useState(false);
  const [depth, setDepth] = useState(1);
  const [recursive, setRecursive] = useState(true);
  const [openAfter, setOpenAfter] = useState(true);
  const [cloneId, setCloneId] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const optsRef = useRef({ dir: '', openAfter: true });

  // ダイアログを開くたびに初期化
  useEffect(() => {
    if (open) {
      setUrl('');
      setDir('');
      setDirTouched(false);
      setCloneId(null);
      setLog([]);
      setFailed(false);
    }
  }, [open]);

  // URL 入力から保存先を補完 (§3.3: 既定は右クリックしたフォルダ配下に repo 名)
  useEffect(() => {
    if (!dirTouched && url) setDir(joinPath(baseDir, repoNameFromUrl(url)));
  }, [url, baseDir, dirTouched]);

  // 進捗ストリーム購読 (§3.4)
  useEffect(() => {
    if (!cloneId) return;
    return onWsEvent('git:clone-progress', (data) => {
      const msg = data as ProgressMsg;
      if (msg.id !== cloneId) return;
      if (msg.line) {
        setLog((l) => [...l.slice(-200), msg.line!]);
        requestAnimationFrame(() => {
          logRef.current?.scrollTo(0, logRef.current.scrollHeight);
        });
      }
      if (msg.done) {
        setCloneId(null);
        if (msg.ok) {
          const { dir: d, openAfter: oa } = optsRef.current;
          useToast.getState().show('success', 'clone が完了しました');
          useSettings.getState().addRepository(d);
          useCloneDialog.getState().close();
          if (oa) void useExplorer.getState().navigate(d);
          else void useExplorer.getState().refresh();
        } else {
          setFailed(true);
          setLog((l) => [
            ...l,
            msg.error ?? 'clone に失敗しました',
            '認証が必要な場合は、ターミナルで一度認証を通してください (アプリは資格情報を持ちません)。',
          ]);
        }
      }
    });
  }, [cloneId]);

  if (!open) return null;

  const busy = cloneId !== null;

  const startClone = async () => {
    if (!url.trim() || !dir.trim()) return;
    setLog([]);
    setFailed(false);
    optsRef.current = { dir: dir.trim(), openAfter };
    try {
      const r = await api.gitClone({
        url: url.trim(),
        dir: dir.trim(),
        branch: useBranch ? branch.trim() : undefined,
        depth: useDepth ? depth : undefined,
        recursive,
      });
      setCloneId(r.id);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="dialog-backdrop">
      <div className="dialog clone-dialog">
        <div className="dialog-title">Git Clone</div>
        <div className="clone-form">
          <label className="clone-row">
            <span className="clone-label">URL:</span>
            <input
              className="clone-input"
              autoFocus
              placeholder="https://github.com/user/repo.git"
              value={url}
              disabled={busy}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label className="clone-row">
            <span className="clone-label">保存先:</span>
            <input
              className="clone-input"
              value={dir}
              disabled={busy}
              onChange={(e) => {
                setDirTouched(true);
                setDir(e.target.value);
              }}
            />
          </label>
          <div className="clone-options-title">オプション</div>
          <label className="clone-row">
            <input type="checkbox" checked={useBranch} disabled={busy} onChange={(e) => setUseBranch(e.target.checked)} />
            <span>ブランチ指定</span>
            <input
              className="clone-input small"
              value={branch}
              disabled={busy || !useBranch}
              onChange={(e) => setBranch(e.target.value)}
            />
          </label>
          <label className="clone-row">
            <input type="checkbox" checked={useDepth} disabled={busy} onChange={(e) => setUseDepth(e.target.checked)} />
            <span>Shallow (depth)</span>
            <input
              className="clone-input tiny"
              type="number"
              min={1}
              value={depth}
              disabled={busy || !useDepth}
              onChange={(e) => setDepth(Math.max(1, Number(e.target.value) || 1))}
            />
          </label>
          <label className="clone-row">
            <input type="checkbox" checked={recursive} disabled={busy} onChange={(e) => setRecursive(e.target.checked)} />
            <span>サブモジュールも取得 (--recursive)</span>
          </label>
          <label className="clone-row">
            <input type="checkbox" checked={openAfter} disabled={busy} onChange={(e) => setOpenAfter(e.target.checked)} />
            <span>クローン後に開く</span>
          </label>
        </div>

        {(busy || log.length > 0) && (
          <pre ref={logRef} className={`clone-log${failed ? ' failed' : ''}`}>
            {busy && log.length === 0 ? 'clone を開始しています…' : log.join('\n')}
          </pre>
        )}

        <div className="dialog-buttons">
          <button className="btn" disabled={busy} onClick={close}>
            キャンセル
          </button>
          <button className="btn primary" disabled={busy || !url.trim() || !dir.trim()} onClick={() => void startClone()}>
            {busy ? 'Clone 中…' : 'Clone'}
          </button>
        </div>
      </div>
    </div>
  );
}
