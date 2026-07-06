import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { monaco, languageForPath } from '../editor/monacoSetup';
import { useSettings } from '../../stores/settings';
import { switchView } from '../../stores/ui';
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
}

export const useDiffTab = create<DiffViewStore>((set) => ({
  current: null,
  open: (current) => set({ current }),
  close: () => set({ current: null }),
}));

/** 差分タブを開く (ブラウザ履歴に追加) */
export function openCommitDiff(target: CommitDiffTarget): void {
  useDiffTab.getState().open(target);
  switchView('diff');
}

interface DiffData {
  before: string | null;
  after: string | null;
  binary: boolean;
}

export function DiffTab() {
  const current = useDiffTab((s) => s.current);
  const theme = useSettings((s) => s.settings.theme);
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
