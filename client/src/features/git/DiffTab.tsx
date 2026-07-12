import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { monaco, languageForPath } from '../editor/monacoSetup';
import { useSettings } from '../../stores/settings';
import { switchView, replaceView, useUi } from '../../stores/ui';
import { toastError } from '../../stores/toast';

/**
 * コミット差分タブ: 選択ファイルのコミット前後を Monaco DiffEditor で
 * 2 ペイン (side-by-side) 表示する。開く操作はブラウザ履歴に積まれる。
 */

export interface CommitDiffTarget {
  repo: string;
  hash: string;
  path: string;
  subject: string;
}

interface DiffViewStore {
  current: CommitDiffTarget | null;
  open: (t: CommitDiffTarget) => void;
  close: () => void;
  setSubject: (subject: string) => void;
}

export const useDiffTab = create<DiffViewStore>((set) => ({
  current: null,
  open: (current) => set({ current }),
  close: () => set({ current: null }),
  setSubject: (subject) => set((s) => (s.current ? { current: { ...s.current, subject } } : s)),
}));

/** 差分タブの対象を URL パラメータへ (リロード/別タブでも復元できるように) */
function diffParams(target: CommitDiffTarget): URLSearchParams {
  const params = new URLSearchParams(location.search);
  params.set('view', 'diff');
  params.set('drepo', target.repo);
  params.set('dhash', target.hash);
  params.set('dpath', target.path);
  return params;
}

/** URL の ?drepo=&dhash=&dpath= から差分タブの対象を復元 (subject は後から取得) */
export function diffTargetFromUrl(): CommitDiffTarget | null {
  const params = new URLSearchParams(location.search);
  const repo = params.get('drepo');
  const hash = params.get('dhash');
  const path = params.get('dpath');
  return repo && hash && path ? { repo, hash, path, subject: '' } : null;
}

/** 差分タブを開く (ブラウザ履歴に追加)。newTab でブラウザの別タブに開く */
export function openCommitDiff(target: CommitDiffTarget, newTab = false): void {
  const params = diffParams(target);
  if (newTab) {
    window.open(`${location.pathname}?${params}`, '_blank');
    return;
  }
  useDiffTab.getState().open(target);
  history.pushState({ path: params.get('path'), view: 'diff' }, '', `${location.pathname}?${params}`);
  useUi.getState().setView('diff');
}

/** 差分タブを閉じる。表示中だった場合は「ログ」タブへ戻す (履歴は積まない) */
export function closeDiffTab(): void {
  useDiffTab.getState().close();
  const params = new URLSearchParams(location.search);
  ['drepo', 'dhash', 'dpath'].forEach((k) => params.delete(k));
  history.replaceState(history.state, '', `${location.pathname}?${params}`);
  if (useUi.getState().view === 'diff') replaceView('log');
}

interface DiffData {
  before: string | null;
  after: string | null;
  binary: boolean;
}

export function DiffTab() {
  const current = useDiffTab((s) => s.current);
  const theme = useSettings((s) => s.settings.theme);
  const diffTools = useUi((s) => s.diffTools);
  const [data, setData] = useState<DiffData | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<monaco.editor.ITextModel[]>([]);

  useEffect(() => {
    setData(null);
    if (!current) return;
    api
      .gitCommitFileDiff(current.repo, current.hash, current.path)
      .then(setData)
      .catch(toastError);
  }, [current]);

  // URL から復元した場合はコミットの件名が無いので取得する
  useEffect(() => {
    if (!current || current.subject) return;
    api
      .gitCommitFiles(current.repo, current.hash)
      .then((r) => useDiffTab.getState().setSubject(r.message.split('\n')[0]))
      .catch(() => {});
  }, [current]);

  const isText = data !== null && !data.binary && (data.before !== null || data.after !== null);

  useEffect(() => {
    if (!isText || !current || !hostRef.current) return;
    const editor = monaco.editor.createDiffEditor(hostRef.current, {
      readOnly: true,
      renderSideBySide: true,
      automaticLayout: true,
      minimap: { enabled: false },
      theme: theme === 'dark' ? 'vs-dark' : 'vs',
    });
    const lang = languageForPath(current.path);
    const original = monaco.editor.createModel(data.before ?? '', lang);
    const modified = monaco.editor.createModel(data.after ?? '', lang);
    editor.setModel({ original, modified });
    editorRef.current = editor;
    modelsRef.current = [original, modified];
    return () => {
      editor.dispose();
      modelsRef.current.forEach((m) => m.dispose());
      modelsRef.current = [];
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isText, data, current]);

  useEffect(() => {
    monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs');
  }, [theme]);

  if (!current) return null;

  const short = current.hash.slice(0, 7);

  return (
    <div className="diff-tab">
      <div className="diff-tab-head">
        <span className="graph-hash">{short}</span>
        <b className="diff-tab-path" title={current.path}>
          {current.path}
        </b>
        <span className="diff-tab-subject" title={current.subject}>
          {current.subject}
        </span>
        <span className="status-spacer" />
        <span className="diff-tab-legend">
          左: {short}^ (変更前) / 右: {short} (変更後)
        </span>
        {/* 外部差分ツール (config.jsonc の diffTools) で同じ比較を開く */}
        {diffTools.map((t, i) => (
          <button
            key={t.label}
            className="status-btn"
            title={`${t.label} でこの差分を開く`}
            onClick={() =>
              void api.gitDiffTool(i, current.repo, current.path, 'commit', current.hash).catch(toastError)
            }
          >
            {t.label}
          </button>
        ))}
        <button className="dialog-close" title="差分タブを閉じる" onClick={closeDiffTab}>
          ✕
        </button>
      </div>
      {!data ? (
        <div className="empty-hint">読み込み中…</div>
      ) : data.binary ? (
        <div className="empty-hint">バイナリファイルのため差分を表示できません</div>
      ) : !isText ? (
        <div className="empty-hint">内容を取得できませんでした</div>
      ) : (
        <div className="diff-tab-editor" ref={hostRef} />
      )}
    </div>
  );
}
