import { useEffect, useRef } from 'react';
import { monaco, languageForPath } from './monacoSetup';
import { useEditor } from '../../stores/editor';
import { useSettings } from '../../stores/settings';
import { promptDialog } from '../../stores/dialog';
import { parentPath, joinPath } from '../../lib/paths';

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
    <div className="editor-pane">
      <div className="editor-tabs">
        {tabs.map((t) => (
          <div
            key={t.path}
            className={`editor-tab${t.path === activePath ? ' active' : ''}`}
            title={t.path}
            onClick={() => activate(t.path)}
            onAuxClick={(e) => {
              if (e.button === 1) void close(t.path);
            }}
          >
            <span>
              {t.dirty ? '● ' : ''}
              {t.name}
            </span>
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                void close(t.path);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <span className="editor-tab-actions">
          <button className="status-btn" title="上書き保存 (Ctrl+S)" onClick={() => void save()}>
            保存
          </button>
          <button className="status-btn" title="名前を付けて保存" onClick={() => void doSaveAs()}>
            別名保存
          </button>
          <button className="status-btn" title="すべて保存 (Ctrl+Shift+S)" onClick={() => void saveAll()}>
            すべて保存
          </button>
        </span>
      </div>
      <div ref={containerRef} className="monaco-container" />
    </div>
  );
}
