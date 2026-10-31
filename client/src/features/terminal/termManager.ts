import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { APP_TOKEN } from '../../api/client';
import { getSessionId } from '../../lib/session';
import { useUi } from '../../stores/ui';

/**
 * ターミナルの画面 (xterm.js) と入出力の接続 (WS /ws/terminal) をセッションごとに持つ。
 * React の外に置き、表示位置 (下 / 右 / フローティング) を切り替えても
 * 要素を付け替えるだけにして、画面の内容と接続を保つ。
 */

interface Entry {
  id: number;
  /** 作ったときのサーバの起動ごとの ID (再起動後の同じ id の別のターミナルにつながないよう、接続時に送る) */
  instance: string;
  term: Terminal;
  fit: FitAddon;
  /** xterm を描画する要素 (表示中のパネルの中へ付け替える) */
  el: HTMLDivElement;
  /** term.open() 済みか (フォントの読み込みを待ってから開く) */
  opened: boolean;
  ws: WebSocket | null;
  disposed: boolean;
  /** サーバにセッションが無い / シェルが終了した (再接続しない) */
  gone: boolean;
  retries: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<number, Entry>();
/** 一覧を最後に読んだサーバの起動ごとの ID */
let instance: string | null = null;
/** 次に表示されたときにフォーカスを当てるターミナル */
let focusPending: number | null = null;
/** ページ離脱による切断か (再接続を止める) */
let leaving = false;
let onGone: ((id: number) => void) | null = null;

/** 再接続の間隔と上限 (サーバの再起動中など) */
const RETRY_DELAY = 2000;
const RETRY_MAX = 30;

const FONT_SIZE = 13;
/** 英数字と日本語を 1:2 の幅で表示できる、同梱の UDEV Gothic を使う (styles/global.module.scss) */
const FONT_FAMILY = "'UDEV Gothic', Consolas, Menlo, 'Courier New', monospace";
/** 文字の幅はフォントで測るので、読み込んでから画面を開く */
const fontReady: Promise<unknown> =
  document.fonts?.load(`${FONT_SIZE}px 'UDEV Gothic'`).catch(() => {}) ?? Promise.resolve();

/** シェルが終了した・サーバにセッションが無いと分かったときの通知先 (ストアが一覧を読み直す) */
export function setTerminalGoneListener(fn: (id: number) => void): void {
  onGone = fn;
}

/** アプリのテーマの色を使う。ANSI の色は xterm の既定のまま、背景との差が小さければ自動で濃淡を付ける */
function theme(): ITheme {
  const cs = getComputedStyle(document.body);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    background: v('--bg'),
    foreground: v('--text'),
    cursor: v('--text'),
    cursorAccent: v('--bg'),
    selectionBackground: v('--bg-selected'),
  };
}

// テーマを切り替えたら開いているターミナルにも反映する
new MutationObserver(() => {
  const t = theme();
  for (const e of entries.values()) e.term.options.theme = t;
}).observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });

window.addEventListener('pagehide', () => {
  leaving = true;
  for (const e of entries.values()) e.ws?.close(1000);
});

window.addEventListener('pageshow', (ev) => {
  if (!ev.persisted) return;
  leaving = false;
  for (const e of entries.values()) if (!e.ws && !e.gone) connect(e);
});

function isMac(): boolean {
  return useUi.getState().platform === 'darwin' || /Mac/.test(navigator.platform);
}

function send(e: Entry, msg: object): void {
  if (e.ws?.readyState === WebSocket.OPEN) e.ws.send(JSON.stringify(msg));
}

function sendSize(e: Entry): void {
  send(e, { t: 's', cols: e.term.cols, rows: e.term.rows });
}

function connect(e: Entry): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(
    `${proto}://${location.host}/ws/terminal?token=${APP_TOKEN}&session=${getSessionId()}&id=${e.id}` +
      `&instance=${encodeURIComponent(e.instance)}`,
  );
  e.ws = ws;
  ws.onopen = () => {
    e.retries = 0;
    sendSize(e);
  };
  ws.onerror = () => {
    /* 切断は onclose 側で扱う */
  };
  ws.onmessage = (ev) => {
    let msg: { t?: string; d?: string };
    try {
      msg = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    if (msg.t === 'r') {
      // 接続し直したときも、サーバが控えている出力から描き直す
      e.term.reset();
      e.term.write(msg.d ?? '');
    } else if (msg.t === 'o') {
      e.term.write(msg.d ?? '');
    } else if (msg.t === 'e' || msg.t === 'x') {
      e.gone = true;
    }
  };
  ws.onclose = () => {
    if (e.ws === ws) e.ws = null;
    if (e.disposed || leaving) return;
    if (e.gone || e.retries >= RETRY_MAX) {
      onGone?.(e.id);
      return;
    }
    e.retries++;
    e.retryTimer = setTimeout(() => {
      e.retryTimer = null;
      if (!e.disposed && !e.ws) connect(e);
    }, RETRY_DELAY);
  };
}

async function copySelection(term: Terminal): Promise<void> {
  const text = term.getSelection();
  if (!text) return;
  await navigator.clipboard.writeText(text).catch(() => {});
  term.clearSelection();
}

export async function pasteClipboard(id: number): Promise<void> {
  const e = entries.get(id);
  if (!e) return;
  const text = await navigator.clipboard.readText().catch(() => '');
  if (text) e.term.paste(text);
  e.term.focus();
}

export function copyTerminalSelection(id: number): void {
  const e = entries.get(id);
  if (e) void copySelection(e.term);
}

export function hasTerminalSelection(id: number): boolean {
  return entries.get(id)?.term.hasSelection() ?? false;
}

export function selectAllTerminal(id: number): void {
  entries.get(id)?.term.selectAll();
}

export function clearTerminal(id: number): void {
  const e = entries.get(id);
  e?.term.clear();
  e?.term.focus();
}

function create(id: number): Entry {
  const term = new Terminal({
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    minimumContrastRatio: 4.5,
    theme: theme(),
    // ConPTY は行の折り返しを自前で行うので、xterm 側の再折り返しを合わせる
    ...(useUi.getState().platform === 'win32' ? { windowsPty: { backend: 'conpty' as const } } : {}),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_ev, uri) => window.open(uri, '_blank', 'noopener')));
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';

  // コピー / 貼り付け: 選択中の Ctrl+C (Mac は ⌘C) はコピー、選択が無ければシェルへ (中断)。
  // Ctrl+V (⌘V) はブラウザの貼り付けに任せる (xterm が受け取って送る)。Ctrl+Shift+C / V も使える
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    const mod = isMac() ? ev.metaKey : ev.ctrlKey;
    if (!mod || ev.altKey) return true;
    const k = ev.key.toLowerCase();
    if (k === 'c' && (term.hasSelection() || ev.shiftKey)) {
      ev.preventDefault();
      void copySelection(term);
      return false;
    }
    if (k === 'v') return false;
    return true;
  });

  const el = document.createElement('div');
  el.style.position = 'absolute';
  el.style.inset = '4px 0 0 8px';
  const e: Entry = {
    id,
    instance: instance ?? '',
    term,
    fit,
    el,
    opened: false,
    ws: null,
    disposed: false,
    gone: false,
    retries: 0,
    retryTimer: null,
  };
  term.onData((d) => send(e, { t: 'i', d }));
  term.onBinary((d) => send(e, { t: 'i', d }));
  term.onResize(() => sendSize(e));
  void fontReady.then(() => {
    if (e.disposed) return;
    term.open(el);
    e.opened = true;
    // 複数のタブで開いているときは、操作しているタブの大きさに合わせる
    term.textarea?.addEventListener('focus', () => sendSize(e));
    fitEntry(e);
    if (focusPending === id && el.isConnected) {
      focusPending = null;
      term.focus();
    }
  });
  connect(e);
  entries.set(id, e);
  return e;
}

function fitEntry(e: Entry): void {
  // 非表示 (大きさ 0) のときに合わせると 1 桁などに縮んでしまう
  if (!e.opened || !e.el.isConnected || e.el.clientWidth === 0 || e.el.clientHeight === 0) return;
  try {
    e.fit.fit();
  } catch {
    /* 描画前などは無視 */
  }
}

/**
 * ターミナルの要素を host に並べ、activeId だけを表示する。
 * 別のパネル (下 / 右 / フローティング) の host に移すときもこれで付け替える
 */
export function mountTerminals(host: HTMLElement, ids: number[], activeId: number | null): void {
  for (const id of ids) {
    const e = entries.get(id) ?? create(id);
    if (e.el.parentElement !== host) host.appendChild(e.el);
    e.el.style.display = id === activeId ? '' : 'none';
  }
  if (activeId !== null) fitActive(activeId);
}

/** 表示中のターミナルを領域の大きさに合わせる (表示し直したときは描き直す) */
export function fitActive(id: number): void {
  const e = entries.get(id);
  if (!e) return;
  requestAnimationFrame(() => {
    fitEntry(e);
    if (e.opened) e.term.refresh(0, e.term.rows - 1);
    if (focusPending === id && e.opened && e.el.isConnected) {
      focusPending = null;
      e.term.focus();
    }
  });
}

/** フォーカスを当てる。まだ表示されていなければ表示されたときに当てる */
export function focusTerminal(id: number): void {
  const e = entries.get(id);
  if (e?.opened && e.el.isConnected && e.el.style.display !== 'none') e.term.focus();
  else focusPending = id;
}

/** ターミナルの入力欄にフォーカスがあるか */
export function isTerminalFocused(): boolean {
  const a = document.activeElement;
  return [...entries.values()].some((e) => e.el.contains(a));
}

function dispose(e: Entry): void {
  e.disposed = true;
  if (e.retryTimer) clearTimeout(e.retryTimer);
  e.ws?.close(1000);
  e.term.dispose();
  e.el.remove();
  entries.delete(e.id);
}

/**
 * サーバの起動ごとの ID を控える。前に読んだときから変わっていれば (サーバが再起動した)、
 * 再起動前のターミナルの画面と接続を片付けて true を返す
 */
export function setTerminalInstance(next: string): boolean {
  const restarted = instance !== null && instance !== next;
  instance = next;
  for (const e of [...entries.values()]) if (e.instance !== next) dispose(e);
  return restarted;
}

/** 一覧から消えたセッションの画面と接続を片付ける */
export function syncTerminals(ids: number[]): void {
  const keep = new Set(ids);
  for (const e of [...entries.values()]) if (!keep.has(e.id)) dispose(e);
}
