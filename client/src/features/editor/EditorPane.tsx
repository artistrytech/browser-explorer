import { useEffect, useRef } from 'react';
import { monaco, languageForPath } from './monacoSetup';
import { useEditor } from '../../stores/editor';
import { useSettings, PREVIEW_ZOOM_MIN, PREVIEW_ZOOM_MAX } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { confirmDialog, promptDialog } from '../../stores/dialog';
import { useContextMenu, type MenuItem } from '../../components/ContextMenu';
import { api } from '../../api/client';
import { copyPathItems } from '../../lib/copyPath';
import { openCodeMap } from '../codemap/codeMapStore';
import { parentPath, joinPath } from '../../lib/paths';
import {
  MarkdownPreview,
  isMarkdownPath,
  useMarkdownPreview,
  setPreviewZoom,
  zoomPreviewBy,
} from '../preview/MarkdownPreview';
import styles from './EditorPane.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** root 配下の p を root からの相対パスにする (配下でなければ null)。Windows のドライブパスは大文字小文字を区別しない */
function relativeTo(p: string, root: string): string | null {
  const fold = (v: string) => (/^[A-Za-z]:/.test(v) ? v.toLowerCase() : v);
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return fold(p).startsWith(fold(prefix)) ? p.slice(prefix.length) : null;
}

/** タブ名の右クリックメニュー。リポジトリ内のファイルなら相対パスのコピーも (先に) 出す */
async function openTabMenu(e: React.MouseEvent, path: string): Promise<void> {
  e.preventDefault();
  const { clientX, clientY } = e;
  const items: MenuItem[] = [];
  try {
    const { isRepo, root } = await api.isRepo(parentPath(path));
    const rel = isRepo && root ? relativeTo(path, root) : null;
    if (rel) items.push(...copyPathItems('相対パスをコピー', rel));
  } catch {
    // リポジトリか判定できなければ「パスをコピー」のみ出す
  }
  items.push(...copyPathItems('パスをコピー', path));
  useContextMenu.getState().open(clientX, clientY, items);
}

export function EditorPane() {
  const { tabs, activePath, activate, close, updateContent, save, saveAll, saveAs, reload, setCursor, setPreview } =
    useEditor();
  const settings = useSettings((s) => s.settings);
  /** プレビューはエディタタブを表示中だけ描く (非表示の間に拡大縮小のキー等を拾わないように) */
  const visible = useUi((s) => s.view === 'editor');
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>());
  const syncingRef = useRef(false);

  const activeTab = tabs.find((t) => t.path === activePath);
  const isMarkdown = !!activeTab && isMarkdownPath(activeTab.path);
  /** Markdown をプレビューで表示中か (Monaco は隠すだけで、モデルや表示位置はそのまま残す) */
  const previewing = isMarkdown && !!activeTab?.preview;

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

    // カーソル位置のシンボルの参照元 / 参照先のマップ (VSCode の呼び出し階層と同じキー)
    editor.addAction({
      id: 'explorer.codeMap',
      label: '参照マップを表示',
      keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyH],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.6,
      run: (ed) => {
        const model = ed.getModel();
        const pos = ed.getPosition();
        const path = useEditor.getState().activePath;
        if (!model || !pos || !path) return;
        openCodeMap({
          path,
          position: { line: pos.lineNumber - 1, character: pos.column - 1 },
          word: model.getWordAtPosition(pos)?.word ?? '',
          content: model.getValue(),
        });
      },
    });

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
    if (!activeTab.preview) editor.focus();
  }, [activeTab?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 編集 / プレビューの切り替え。編集に戻ったらエディタにフォーカスする */
  const togglePreview = (on: boolean) => {
    if (!activeTab) return;
    setPreview(activeTab.path, on);
    if (!on) requestAnimationFrame(() => editorRef.current?.focus());
  };

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

  // コードマップ等からの「この位置を開く」: モデルを表示してからカーソルを移す
  const reveal = useEditor((s) => s.reveal);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !reveal || reveal.path !== activeTab?.path) return;
    if (editor.getModel() !== modelsRef.current.get(reveal.path)) return;
    if (activeTab?.preview) setPreview(reveal.path, false);
    const pos = { lineNumber: reveal.line, column: reveal.column };
    editor.setPosition(pos);
    editor.revealPositionInCenter(pos);
    editor.focus();
    useEditor.getState().clearReveal();
  }, [reveal, activeTab?.path]);

  const doSaveAs = async () => {
    if (!activeTab) return;
    const name = await promptDialog('名前を付けて保存', joinPath(parentPath(activeTab.path), activeTab.name), {
      message: '保存先のフルパスを入力してください',
    });
    if (name) await saveAs(activeTab.path, name.replace(/\\/g, '/'));
  };

  // 保存の隣にあって押し間違えやすいので、編集内容を捨てるときは確認する
  // (エンコーディング・改行・BOM の切り替えだけなら、選んだエンコーディングで開き直すための操作なので確認しない)
  const doReload = async () => {
    if (!activeTab) return;
    if (
      activeTab.content !== activeTab.savedContent &&
      !(await confirmDialog('再読込', `${activeTab.name} の未保存の変更を破棄して読み込み直しますか?`, true))
    ) {
      return;
    }
    await reload(activeTab.path, activeTab.encoding);
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
              {t.preview && isMarkdownPath(t.path) ? '👁 ' : ''}
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
          {isMarkdown && (
            <>
              {/* Markdown: 編集 / プレビューの切り替え */}
              <span className={cx('btn-group')}>
                <button
                  className={cx(`status-btn${previewing ? '' : ' on'}`)}
                  title="編集する"
                  onClick={() => togglePreview(false)}
                >
                  ✎ 編集
                </button>
                <button
                  className={cx(`status-btn${previewing ? ' on' : ''}`)}
                  title="プレビューを表示する"
                  onClick={() => togglePreview(true)}
                >
                  👁 プレビュー
                </button>
              </span>
              {previewing && <PreviewControls />}
              <span className={cx('actions-sep')} />
            </>
          )}
          <button
            className={cx("status-btn")}
            title="ファイルを開き直す (ステータスバーで選んだエンコーディングで読み込む)"
            onClick={() => void doReload()}
          >
            再読込
          </button>
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
      <div className={cx('editor-body')}>
        <div ref={containerRef} className={cx(`monaco-container${previewing ? ' hidden' : ''}`)} />
        {previewing && visible && activeTab && (
          <div className={cx('preview-container')}>
            <MarkdownPreview path={activeTab.path} content={activeTab.content} />
          </div>
        )}
      </div>
    </div>
  );
}

/** プレビュー表示中のツールバー: 拡大率 (−/+ で STEP ずつ、% 表示クリックで 100%) と全画面 */
function PreviewControls() {
  const zoom = useSettings((s) => s.settings.previewZoom);
  const setFullscreen = useMarkdownPreview((s) => s.setFullscreen);
  return (
    <>
      <span className={cx('btn-group')}>
        <button
          className={cx('status-btn')}
          title="縮小 (Ctrl+−)"
          disabled={zoom <= PREVIEW_ZOOM_MIN}
          onClick={() => zoomPreviewBy(-1)}
        >
          −
        </button>
        <button className={cx('status-btn zoom-value')} title="拡大率をリセット (Ctrl+0)" onClick={() => setPreviewZoom(100)}>
          {zoom}%
        </button>
        <button
          className={cx('status-btn')}
          title="拡大 (Ctrl++)"
          disabled={zoom >= PREVIEW_ZOOM_MAX}
          onClick={() => zoomPreviewBy(1)}
        >
          +
        </button>
      </span>
      <button className={cx('status-btn')} title="全画面モード (Esc で終了)" onClick={() => setFullscreen(true)}>
        ⛶ 全画面
      </button>
    </>
  );
}
