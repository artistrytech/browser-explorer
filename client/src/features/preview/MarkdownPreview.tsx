import { useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from '../../api/client';
import { monaco } from '../editor/monacoSetup';
import { useEditor } from '../../stores/editor';
import { useSettings, clampPreviewZoom, PREVIEW_ZOOM_STEP } from '../../stores/settings';
import { parentPath, joinPath } from '../../lib/paths';
import { savePreviewScroll, loadPreviewScroll } from '../../lib/previewViewMemory';
import { renderMermaid } from './mermaid';
import { openInNewTab, wantsNewTab } from '../../lib/appTabs';
import styles from './MarkdownPreview.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * Markdown プレビュー: エディタタブ内で、編集とプレビューを切り替えて表示する (EditorPane が使う)。
 * 描画するのはタブの編集内容 (未保存の変更も反映)。ファイルが外部で保存された場合は、
 * エディタの外部変更の読み直しを通じて再描画される。
 */

/** プレビューの対象とする拡張子 (ドット無し・小文字) */
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd']);

export function isMarkdownPath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return path.includes('.') && MARKDOWN_EXTS.has(ext);
}

interface PreviewStore {
  /**
   * 全画面モード (ツールバー・タブ・サイドバー等を隠して本文だけを表示)。Esc で解除。
   * ブラウザの全画面 (Fullscreen API) も連動して切り替える
   */
  fullscreen: boolean;
  setFullscreen: (on: boolean) => void;
}

/** ブラウザの全画面を切り替える。拒否された (ユーザー操作外など) 場合はアプリ内の全画面だけで続ける */
function setBrowserFullscreen(on: boolean): void {
  if (on) {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  } else if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
}

export const useMarkdownPreview = create<PreviewStore>((set) => ({
  fullscreen: false,
  setFullscreen: (fullscreen) => {
    setBrowserFullscreen(fullscreen);
    set({ fullscreen });
  },
}));

/** URL の ?ppath= (別タブでプレビューを開くときの指定) */
export function previewPathFromUrl(): string | null {
  return new URLSearchParams(location.search).get('ppath');
}

/** Markdown をエディタタブのプレビュー表示で開く。newTab でブラウザの別タブに開く */
export function openMarkdownPreview(path: string, newTab = false): void {
  if (newTab) {
    // 開いた先で (エディタのタブを開き直した後に) エディタタブを開いて履歴に積むので、view は付けない
    const params = new URLSearchParams(location.search);
    params.delete('view');
    params.set('ppath', path);
    openInNewTab(`${location.pathname}?${params}`);
    return;
  }
  void useEditor.getState().open(path, 'preview');
}

/** プレビューの拡大率を指定値に (設定として永続化) */
export function setPreviewZoom(next: number): void {
  const z = clampPreviewZoom(next);
  if (z !== useSettings.getState().settings.previewZoom) useSettings.getState().update({ previewZoom: z });
}

/** プレビューの拡大率を STEP 単位で増減 */
export function zoomPreviewBy(dir: 1 | -1): void {
  setPreviewZoom(useSettings.getState().settings.previewZoom + dir * PREVIEW_ZOOM_STEP);
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

/** mermaid 記法のコードブロックに付けるクラス (描画後処理の目印。CSS Modules を通さない素のクラス名) */
const MERMAID_CLASS = 'md-mermaid';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
    // ```mermaid ブロックは描画後処理で SVG に置き換える (それ以外は false を返して既定のコードブロック描画へ)
    code({ text, lang }) {
      const name = (lang ?? '').trim().split(/\s+/)[0].toLowerCase();
      if (name !== 'mermaid') return false;
      return `<pre class="${MERMAID_CLASS}">${escapeHtml(text)}</pre>\n`;
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

export function MarkdownPreview({ path: current, content }: { path: string; content: string }) {
  const fullscreen = useMarkdownPreview((s) => s.fullscreen);
  const setFullscreen = useMarkdownPreview((s) => s.setFullscreen);
  const theme = useSettings((s) => s.settings.theme);
  const zoom = useSettings((s) => s.settings.previewZoom);
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 画像用に生成した object URL (差し替え/アンマウント時に解放する) */
  const blobUrls = useRef<string[]>([]);
  /**
   * 復元待ちのスクロール位置 (sessionStorage 由来)。描画直後に適用し、
   * その後に画像が読み込まれて高さが変わった場合も、ユーザーがまだ動かしていなければ再適用する
   */
  const pendingScroll = useRef<{ target: number; applied: number | null } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  const html = useMemo(() => {
    const raw = md.parse(content, { async: false });
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [content]);

  useEffect(() => {
    const saved = loadPreviewScroll(current);
    pendingScroll.current = saved !== null && saved > 0 ? { target: saved, applied: null } : null;
    return () => {
      // 別ファイルへの切替・編集への切替 (アンマウント) 時に最終位置を保存
      clearTimeout(saveTimer.current);
      const el = scrollRef.current;
      if (el) savePreviewScroll(current, el.scrollTop);
    };
  }, [current]);

  /** 保存済みのスクロール位置を適用 (まだ動かされていない場合のみ) */
  const applyPendingScroll = () => {
    const el = scrollRef.current;
    const pending = pendingScroll.current;
    if (!el || !pending) return;
    if (pending.applied !== null && Math.abs(el.scrollTop - pending.applied) > 1) {
      // ユーザーがスクロールした → 以後は復元しない
      pendingScroll.current = null;
      return;
    }
    el.scrollTop = pending.target;
    pending.applied = el.scrollTop;
  };

  // 描画直後にスクロール位置を復元 (再読込時も同じ位置を保つ)
  useEffect(() => {
    applyPendingScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => savePreviewScroll(current, top), 150);
  };

  // Ctrl+ホイールで拡大縮小 (ブラウザ自体のズームは抑止)。passive にできないので addEventListener で登録
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      if (e.deltaY !== 0) zoomPreviewBy(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Ctrl + / Ctrl - / Ctrl 0 で拡大縮小/リセット (プレビュー表示中のみ。入力欄にフォーカスがある間は対象外)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.defaultPrevented) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el?.closest('.monaco-editor')) return;
      // '+' は US/JIS どちらの配列でも Shift が必要なので shiftKey は '+' のときだけ許容する
      if (e.key === '+' || (e.key === '=' && !e.shiftKey)) zoomPreviewBy(1);
      else if (e.key === '-' && !e.shiftKey) zoomPreviewBy(-1);
      else if (e.key === '0' && !e.shiftKey) setPreviewZoom(100);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 全画面モード中は Esc で解除 (ダイアログ等が手前にある場合はそちらの Esc を優先させるため、
  // 既に処理済み (defaultPrevented) のイベントは無視する)。
  // ブラウザの全画面中の Esc はブラウザが消費して keydown が届かないため、全画面の解除 (fullscreenchange) でも解除する
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setFullscreen(false);
    };
    const onBrowserFsChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onBrowserFsChange);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onBrowserFsChange);
    };
  }, [fullscreen, setFullscreen]);

  // Monaco のテーマ CSS を確実に注入する (コードブロックの colorize 結果の色付け用)
  useEffect(() => {
    monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs');
  }, [theme]);

  // 描画後の後処理: 相対パス画像を API 経由で取得して差し替え / コードブロックの色付け
  useEffect(() => {
    const host = bodyRef.current;
    if (!host) return;
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
          // 画像の高さ分だけ本文が伸びるので、復元位置がずれないよう読み込み後に再適用
          img.onload = applyPendingScroll;
          img.src = url;
        })
        .catch(() => {
          if (!cancelled) img.alt = `(画像を読み込めません: ${src})`;
        });
    });

    // mermaid 図: ソースを data-src に保持したまま SVG に描き替える。失敗したらエラー文言とソースを表示
    host.querySelectorAll<HTMLElement>(`pre.${MERMAID_CLASS}`).forEach((block) => {
      const source = block.dataset.src ?? block.textContent ?? '';
      block.dataset.src = source;
      renderMermaid(source, theme === 'dark' ? 'dark' : 'default')
        .then(({ svg, bindFunctions }) => {
          if (cancelled) return;
          // mermaid (securityLevel: strict) がラベルをサニタイズ済みの SVG
          block.innerHTML = svg;
          bindFunctions?.(block);
          block.classList.add(`${MERMAID_CLASS}-rendered`);
          block.classList.remove(`${MERMAID_CLASS}-error`);
          // 図の高さ分だけ本文が伸びるので、復元位置がずれないよう描画後に再適用
          applyPendingScroll();
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          const msg = document.createElement('div');
          msg.textContent = `mermaid 図を描画できません: ${e instanceof Error ? e.message : String(e)}`;
          const code = document.createElement('code');
          code.textContent = source;
          block.replaceChildren(msg, code);
          block.classList.add(`${MERMAID_CLASS}-error`);
          block.classList.remove(`${MERMAID_CLASS}-rendered`);
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
    // テーマ切替時は mermaid 図を配色に合わせて描き直す (画像・コード色付けも再実行されるが data-src から復元されるだけ)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, current, theme]);

  useEffect(() => {
    return () => {
      blobUrls.current.forEach((u) => URL.revokeObjectURL(u));
      blobUrls.current = [];
      // 全画面のまま別ビューへ移った (Alt+← 等) 場合、次に開いたとき通常表示に戻す
      useMarkdownPreview.getState().setFullscreen(false);
    };
  }, []);

  /**
   * リンククリック: ページ内アンカーはスクロール、相対パスの Markdown はエディタタブのプレビューで開く、
   * 外部 URL は別タブで開く (アプリ自体が遷移してしまうのを防ぐ)。
   * Markdown へのリンクは Ctrl+クリック (mac は ⌘) / 中クリックで別タブのプレビューに開く
   */
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
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
    if (isMarkdownPath(abs)) openMarkdownPreview(abs, wantsNewTab(e));
    else void useEditor.getState().open(abs);
  };

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
      <div className={cx('md-tab-scroll')} ref={scrollRef} onScroll={onScroll}>
        <div
          ref={bodyRef}
          className={cx('md-body')}
          style={{ zoom: zoom / 100 }}
          onClick={onClick}
          // リンクの中クリックはブラウザの既定 (ブラウザの別タブで開く) にせず、クリックと同じ処理に渡す
          onAuxClick={(e) => {
            if (e.button === 1) onClick(e);
          }}
          // marked → DOMPurify でサニタイズ済みの HTML
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}
