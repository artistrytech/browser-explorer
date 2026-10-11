import { useEffect, useRef } from 'react';
import { monaco, languageForPath } from './monacoSetup';
import { useEditor } from '../../stores/editor';
import { useSettings } from '../../stores/settings';
import { promptDialog } from '../../stores/dialog';
import { useToast, toastError } from '../../stores/toast';
import { useUi } from '../../stores/ui';
import { useContextMenu, type MenuItem } from '../../components/ContextMenu';
import { api } from '../../api/client';
import { copyText } from '../../lib/clipboard';
import { parentPath, joinPath } from '../../lib/paths';
import styles from './EditorPane.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** root 配下の p を root からの相対パスにする (配下でなければ null)。Windows のドライブパスは大文字小文字を区別しない */
function relativeTo(p: string, root: string): string | null {
  const fold = (v: string) => (/^[A-Za-z]:/.test(v) ? v.toLowerCase() : v);
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return fold(p).startsWith(fold(prefix)) ? p.slice(prefix.length) : null;
}

async function copyWithToast(text: string, message: string): Promise<void> {
  try {
    await copyText(text);
    useToast.getState().show('success', message);
  } catch (e) {
    toastError(e);
  }
}

/** メニューに添えるパスの最大文字数。超える場合は先頭と末尾 (ファイル名側) を残して途中を省略する */
const PATH_DETAIL_MAX = 60;

function middleEllipsis(s: string, max = PATH_DETAIL_MAX): string {
  if (s.length <= max) return s;
  const head = Math.floor((max - 1) * 0.4);
  return `${s.slice(0, head)}…${s.slice(s.length - (max - 1 - head))}`;
}

/**
 * パスのコピー項目。コピーされるパスをラベルの下に添える。
 * Windows では区切り文字 "/" と "\" の両方を出す (パスは内部では "/" 区切りで持っている)。
 */
function copyPathItems(label: string, p: string): MenuItem[] {
  const done = `${label}しました`;
  const variants = useUi.getState().platform === 'win32' ? [p, p.replace(/\//g, '\\')] : [p];
  return variants.map((text) => ({
    label,
    detail: middleEllipsis(text),
    title: text.length > PATH_DETAIL_MAX ? text : undefined,
    action: () => void copyWithToast(text, done),
  }));
}

/** タブ名の右クリックメニュー。リポジトリ内のファイルなら相対パスのコピーも出す */
async function openTabMenu(e: React.MouseEvent, path: string): Promise<void> {
  e.preventDefault();
  const { clientX, clientY } = e;
  const items: MenuItem[] = copyPathItems('パスをコピー', path);
  try {
    const { isRepo, root } = await api.isRepo(parentPath(path));
    const rel = isRepo && root ? relativeTo(path, root) : null;
    if (rel) items.push(...copyPathItems('相対パスをコピー', rel));
  } catch {
    // リポジトリか判定できなければ「パスをコピー」のみ出す
  }
  useContextMenu.getState().open(clientX, clientY, items);
}

export function EditorPane() {
  const { tabs, activePath, activate, close, updateContent, save, saveAll, saveAs, setCursor } =
    useEditor();
  const settings = useSettings((s) => s.settings);
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>());
  const syncingRef = useRef(false);

  const activeTab = tabs.find((t) => t.path === activePath);

  // エディタ本体は 1 つだけ生成し、タブ切替でモデルを差し替える
  useEffect(() => {
    if (!containerRef.current || editorRef.current) return;
    const editor = monaco.editor.create(containerRef.current, {
      automaticLayout: true,
      minimap: { enabled: true },
      renderWhitespace: 'selection',
      theme: settings.theme === 'dark' ? 'vs-dark' : 'vs',
      fontSize: settings.fontSize,
      wordWrap: settings.wordWrap ? 'on' : 'off',
    });
    editorRef.current = editor;

    editor.onDidChangeCursorPosition((e) => {
      setCursor(e.position.lineNumber, e.position.column);
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void useEditor.getState().save();
    });
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS,
      () => void useEditor.getState().saveAll(),
    );

    return () => {
      editor.dispose();
      editorRef.current = null;
      for (const m of modelsRef.current.values()) m.dispose();
      modelsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // テーマ・フォント設定の反映
  useEffect(() => {
    editorRef.current?.updateOptions({
      fontSize: settings.fontSize,
      wordWrap: settings.wordWrap ? 'on' : 'off',
    });
    monaco.editor.setTheme(settings.theme === 'dark' ? 'vs-dark' : 'vs');
  }, [settings.fontSize, settings.wordWrap, settings.theme]);

  // 閉じられたタブのモデルを破棄
  useEffect(() => {
    const alive = new Set(tabs.map((t) => t.path));
    for (const [p, m] of modelsRef.current) {
      if (!alive.has(p)) {
        m.dispose();
        modelsRef.current.delete(p);
      }
    }
  }, [tabs]);

  // アクティブタブのモデルをエディタへ
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !activeTab) return;
    let model = modelsRef.current.get(activeTab.path);
    if (!model) {
      model = monaco.editor.createModel(
        activeTab.content,
        languageForPath(activeTab.path),
        monaco.Uri.file(activeTab.path),
      );
      model.onDidChangeContent(() => {
        if (syncingRef.current) return;
        const m = modelsRef.current.get(activeTab.path);
        if (m) updateContent(activeTab.path, m.getValue());
      });
      modelsRef.current.set(activeTab.path, model);
    }
    if (editor.getModel() !== model) editor.setModel(model);
    editor.focus();
  }, [activeTab?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  // 外部からの content 変更 (再読込等) をモデルへ反映
  useEffect(() => {
    if (!activeTab) return;
    const model = modelsRef.current.get(activeTab.path);
    if (model && model.getValue() !== activeTab.content) {
      syncingRef.current = true;
      model.setValue(activeTab.content);
      syncingRef.current = false;
    }
  }, [activeTab?.content, activeTab?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const doSaveAs = async () => {
    if (!activeTab) return;
    const name = await promptDialog('名前を付けて保存', joinPath(parentPath(activeTab.path), activeTab.name), {
      message: '保存先のフルパスを入力してください',
    });
    if (name) await saveAs(activeTab.path, name.replace(/\\/g, '/'));
  };

  return (
    <div className={cx("editor-pane")}>
      <div className={cx("editor-tabs")}>
        {tabs.map((t) => (
          <div
            key={t.path}
            className={cx(`editor-tab${t.path === activePath ? ' active' : ''}`)}
            title={t.path}
            onClick={() => activate(t.path)}
            onContextMenu={(e) => void openTabMenu(e, t.path)}
            onAuxClick={(e) => {
              if (e.button === 1) void close(t.path);
            }}
          >
            <span>
              {t.dirty ? '● ' : ''}
              {t.name}
            </span>
            <button
              className={cx("tab-close")}
              onClick={(e) => {
                e.stopPropagation();
                void close(t.path);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <span className={cx("editor-tab-actions")}>
          <button className={cx("status-btn")} title="上書き保存 (Ctrl+S)" onClick={() => void save()}>
            保存
          </button>
          <button className={cx("status-btn")} title="名前を付けて保存" onClick={() => void doSaveAs()}>
            別名保存
          </button>
          <button className={cx("status-btn")} title="すべて保存 (Ctrl+Shift+S)" onClick={() => void saveAll()}>
            すべて保存
          </button>
        </span>
      </div>
      <div ref={containerRef} className={cx("monaco-container")} />
    </div>
  );
}
