import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from '../../api/client';
import { onFsChange } from '../../api/ws';
import { monaco } from '../editor/monacoSetup';
import { useEditor } from '../../stores/editor';
import { useSettings } from '../../stores/settings';
import { switchView, replaceView, useUi } from '../../stores/ui';
import { toastError } from '../../stores/toast';
import { baseName, parentPath, joinPath } from '../../lib/paths';
import styles from './MarkdownTab.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * Markdown プレビュータブ: .md ファイルを HTML に描画して表示する。
 * 差分タブと同じく対象は 1 つ (別のファイルを開くと差し替わる)。開く操作はブラウザ履歴に積まれる。
 * ファイルが外部 (エディタ含む) で保存されたら自動で再描画する。
 */

/** プレビューの対象とする拡張子 (ドット無し・小文字) */
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd']);

export function isMarkdownPath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return path.includes('.') && MARKDOWN_EXTS.has(ext);
}

interface PreviewStore {
  current: string | null;
  /** 全画面モード (ツールバー・タブ・サイドバー等を隠して本文だけを表示)。Esc で解除 */
  fullscreen: boolean;
  open: (path: string) => void;
  close: () => void;
  setFullscreen: (on: boolean) => void;
}

export const usePreviewTab = create<PreviewStore>((set) => ({
  current: null,
  fullscreen: false,
  open: (current) => set({ current }),
  close: () => set({ current: null, fullscreen: false }),
  setFullscreen: (fullscreen) => set({ fullscreen }),
}));

/** URL の ?ppath= からプレビュー対象を復元 */
export function previewPathFromUrl(): string | null {
  return new URLSearchParams(location.search).get('ppath');
}

/** プレビュータブを開く (ブラウザ履歴に追加)。newTab でブラウザの別タブに開く */
export function openMarkdownPreview(path: string, newTab = false): void {
  const params = new URLSearchParams(location.search);
  params.set('view', 'preview');
  params.set('ppath', path);
  if (newTab) {
    window.open(`${location.pathname}?${params}`, '_blank');
    return;
  }
  usePreviewTab.getState().open(path);
  if (location.search !== `?${params}`) {
    history.pushState({ path: params.get('path'), view: 'preview' }, '', `${location.pathname}?${params}`);
  }
  useUi.getState().setView('preview');
  useSettings.getState().addRecent(path, 'file');
}

/** プレビュータブを閉じる。表示中だった場合は「ファイル」タブへ戻す (履歴は積まない) */
export function closePreviewTab(): void {
  usePreviewTab.getState().close();
  const params = new URLSearchParams(location.search);
  params.delete('ppath');
  history.replaceState(history.state, '', `${location.pathname}?${params}`);
  if (useUi.getState().view === 'preview') replaceView('files');
}

/** 見出しのアンカー ID (GitHub 風: 小文字化・空白は '-'・記号除去)。ページ内リンク用 */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

const HEADING_ID_PREFIX = 'md-';

const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // 見出しに ID を付けて「#見出し」形式のリンクで飛べるようにする
    heading({ tokens, depth }) {
      const inner = this.parser.parseInline(tokens);
      const plain = tokens.map((t) => ('text' in t ? String(t.text) : '')).join('');
      return `<h${depth} id="${HEADING_ID_PREFIX}${slugify(plain)}">${inner}</h${depth}>\n`;
    },
  },
});

/** 外部 URL / データ URL など、ファイルシステム相対でない参照か */
function isExternalRef(src: string): boolean {
  return /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src);
}

/** 相対パス参照を Markdown ファイルの親フォルダ基準の絶対パスへ */
function resolveRef(mdPath: string, ref: string): string {
  const clean = decodeURIComponent(ref.split(/[?#]/)[0]);
  if (/^([A-Za-z]:\/|\/)/.test(clean)) return clean;
  let base = parentPath(mdPath);
  const parts = clean.split('/');
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      else base = parentPath(base);
    } else out.push(seg);
  }
  return out.reduce((acc, seg) => joinPath(acc, seg), base);
}

/** Markdown の言語名 → Monaco の言語 ID (colorize 用)。無ければ null (装飾なし) */
function monacoLangFor(name: string): string | null {
  const n = name.toLowerCase();
  const alias: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    yml: 'yaml',
    py: 'python',
    rb: 'ruby',
    cs: 'csharp',
    'c++': 'cpp',
    md: 'markdown',
    ps1: 'powershell',
    text: 'plaintext',
    txt: 'plaintext',
  };
  const id = alias[n] ?? n;
  return monaco.languages.getLanguages().some((l) => l.id === id) ? id : null;
}

interface PreviewData {
  html: string;
  mtime: number;
}

export function MarkdownTab() {
  const current = usePreviewTab((s) => s.current);
  const fullscreen = usePreviewTab((s) => s.fullscreen);
  const setFullscreen = usePreviewTab((s) => s.setFullscreen);
  const theme = useSettings((s) => s.settings.theme);
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 画像用に生成した object URL (差し替え/アンマウント時に解放する) */
  const blobUrls = useRef<string[]>([]);

  const load = async (path: string) => {
    try {
      const r = await api.read(path);
      const raw = md.parse(r.content, { async: false });
      const html = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
      setData({ html, mtime: r.mtime });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    }
  };

  useEffect(() => {
    setData(null);
    setError(null);
    if (!current) return;
    void load(current);
  }, [current]);

  // ファイルが保存されたら再描画 (エディタで編集 → 保存 → プレビューに反映)
  useEffect(() => {
    if (!current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return onFsChange((e) => {
      if (e.path !== current) return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(current), 200);
    });
  }, [current]);

  // 全画面モード中は Esc で解除 (ダイアログ等が手前にある場合はそちらの Esc を優先させるため、
  // 既に処理済み (defaultPrevented) のイベントは無視する)
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen, setFullscreen]);

  // Monaco のテーマ CSS を確実に注入する (コードブロックの colorize 結果の色付け用)
  useEffect(() => {
    monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs');
  }, [theme]);

  // 描画後の後処理: 相対パス画像を API 経由で取得して差し替え / コードブロックの色付け
  useEffect(() => {
    const host = bodyRef.current;
    if (!host || !data || !current) return;
    let cancelled = false;

    blobUrls.current.forEach((u) => URL.revokeObjectURL(u));
    blobUrls.current = [];

    // 同じ HTML 文字列で再描画されたときは React が innerHTML を差し替えないため、
    // 前回の後処理で書き換えた DOM が残っている。元の参照/本文は data-* に保持して使い回す。
    host.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
      const src = img.dataset.src ?? img.getAttribute('src') ?? '';
      if (!src || isExternalRef(src)) return;
      img.dataset.src = src;
      const abs = resolveRef(current, src);
      img.removeAttribute('src');
      img.title ||= abs;
      api
        .readBlob(abs)
        .then((blob) => {
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          blobUrls.current.push(url);
          img.src = url;
        })
        .catch(() => {
          if (!cancelled) img.alt = `(画像を読み込めません: ${src})`;
        });
    });

    host.querySelectorAll<HTMLElement>('pre > code[class*="language-"]').forEach((code) => {
      const m = /language-([\w+#.-]+)/.exec(code.className);
      const lang = m ? monacoLangFor(m[1]) : null;
      if (!lang || lang === 'plaintext') return;
      // 色付け後の DOM は <br/> で改行しているため textContent から改行が消える。元本文を保持する
      const text = code.dataset.src ?? code.textContent ?? '';
      code.dataset.src = text;
      monaco.editor
        .colorize(text, lang, { tabSize: 4 })
        .then((html) => {
          if (!cancelled) code.innerHTML = html;
        })
        .catch(() => {});
    });

    return () => {
      cancelled = true;
    };
  }, [data, current]);

  useEffect(() => {
    return () => {
      blobUrls.current.forEach((u) => URL.revokeObjectURL(u));
      blobUrls.current = [];
      // 全画面のまま別ビューへ移った (Alt+← 等) 場合、次に開いたとき通常表示に戻す
      usePreviewTab.getState().setFullscreen(false);
    };
  }, []);

  /**
   * リンククリック: ページ内アンカーはスクロール、相対パスの Markdown はプレビューで開く、
   * 外部 URL は別タブで開く (アプリ自体が遷移してしまうのを防ぐ)
   */
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a || !current) return;
    const href = a.getAttribute('href') ?? '';
    if (!href) return;
    e.preventDefault();
    if (href.startsWith('#')) {
      const id = `${HEADING_ID_PREFIX}${slugify(decodeURIComponent(href.slice(1)))}`;
      const target = bodyRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
      target?.scrollIntoView({ block: 'start' });
      return;
    }
    if (isExternalRef(href)) {
      window.open(href, '_blank', 'noopener');
      return;
    }
    const abs = resolveRef(current, href);
    if (isMarkdownPath(abs)) openMarkdownPreview(abs, e.ctrlKey || e.metaKey);
    else void useEditor.getState().open(abs);
  };

  if (!current) return null;

  return (
    <div className={cx(`md-tab${fullscreen ? ' fullscreen' : ''}`)}>
      {fullscreen && (
        <button
          className={cx('md-fs-exit')}
          title="全画面モードを終了 (Esc)"
          onClick={() => setFullscreen(false)}
        >
          ✕ 全画面を終了
        </button>
      )}
      <div className={cx('md-tab-head')}>
        <span className={cx('md-tab-icon')}>📝</span>
        <b className={cx('md-tab-path')} title={current}>
          {baseName(current)}
        </b>
        <span className={cx('md-tab-dir')} title={current}>
          {parentPath(current)}
        </span>
        <span className={cx('status-spacer')} />
        <button
          className={cx('status-btn')}
          title="このファイルをエディタで開く"
          onClick={() => void useEditor.getState().open(current)}
        >
          エディタで開く
        </button>
        <button className={cx('status-btn')} title="再読込" onClick={() => void load(current)}>
          ⟳
        </button>
        <button className={cx('status-btn')} title="全画面モード (Esc で終了)" onClick={() => setFullscreen(true)}>
          ⛶ 全画面
        </button>
        <button className={cx('dialog-close')} title="プレビュータブを閉じる" onClick={closePreviewTab}>
          ✕
        </button>
      </div>
      {error ? (
        <div className={cx('empty-hint')}>{error}</div>
      ) : !data ? (
        <div className={cx('empty-hint')}>読み込み中…</div>
      ) : (
        <div className={cx('md-tab-scroll')}>
          <div
            ref={bodyRef}
            className={cx('md-body')}
            onClick={onClick}
            // marked → DOMPurify でサニタイズ済みの HTML
            dangerouslySetInnerHTML={{ __html: data.html }}
          />
        </div>
      )}
    </div>
  );
}
