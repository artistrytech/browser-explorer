/**
 * アプリ内タブ (tabs.html のシェル) との連携。
 *
 * シェルは各タブを同一オリジンの iframe で開き、iframe の name に `ebtab-<id>` を付ける。
 * iframe ごとに JS の実行環境 (ストア・history・WebSocket) は分かれるが、sessionStorage だけは
 * トップレベルのウィンドウ単位なので全タブで共有される。そのためタブ単位の記憶は
 * tabSession を通して `tab:<id>:` のプレフィックス付きで読み書きする。
 * シェル外 (通常のブラウザのタブ) ではプレフィックス無しで、これまでと同じキーになる。
 */

const FRAME_NAME_PREFIX = 'ebtab-';
/** postMessage の識別子 (シェル ⇄ タブ) */
export const TAB_MESSAGE_TYPE = 'eb-tabs';

/** シェル内のタブとして動いているときのタブ ID (それ以外は null) */
export const appTabId: string | null = (() => {
  try {
    if (window.parent === window) return null;
    return window.name.startsWith(FRAME_NAME_PREFIX) ? window.name.slice(FRAME_NAME_PREFIX.length) : null;
  } catch {
    return null;
  }
})();

export function frameNameOf(id: string): string {
  return FRAME_NAME_PREFIX + id;
}

export function newTabId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function storagePrefixOf(id: string): string {
  return `tab:${id}:`;
}

const prefix = appTabId ? storagePrefixOf(appTabId) : '';

/**
 * タブ単位の sessionStorage。sessionStorage が使えない環境では例外を投げるので、
 * 呼び出し側でこれまでどおり try/catch する。
 */
export const tabSession = {
  getItem(key: string): string | null {
    return sessionStorage.getItem(prefix + key);
  },
  setItem(key: string, value: string): void {
    sessionStorage.setItem(prefix + key, value);
  },
  removeItem(key: string): void {
    sessionStorage.removeItem(prefix + key);
  },
  /** このタブのキー一覧 (プレフィックスを除いた形) */
  keys(): string[] {
    const out: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key === null || !key.startsWith(prefix)) continue;
      out.push(key.slice(prefix.length));
    }
    return out;
  },
};

/** タブを閉じたとき、そのタブの sessionStorage を片付ける (シェルから呼ぶ) */
export function clearTabSession(id: string): void {
  try {
    const p = storagePrefixOf(id);
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(p)) keys.push(key);
    }
    for (const key of keys) sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** 新しいタブへ引き継がない記憶 (セッション ID はタブごとに振り直す。lib/session.ts の KEY) */
const NOT_INHERITED = new Set(['appSessionId']);

/**
 * タブの sessionStorage を別タブへ複製する。
 * ブラウザの window.open が開き元の sessionStorage を新しいタブへ複製するのと同じ扱いにするため
 * (呼び出し元は「開く直前に記憶を書き換える」前提のコードがあるので、同期で複製する)。
 */
function copyTabSession(from: string, to: string): void {
  try {
    const src = storagePrefixOf(from);
    const dst = storagePrefixOf(to);
    const entries: [string, string][] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key?.startsWith(src) || NOT_INHERITED.has(key.slice(src.length))) continue;
      entries.push([key.slice(src.length), sessionStorage.getItem(key) ?? '']);
    }
    for (const [k, v] of entries) sessionStorage.setItem(dst + k, v);
  } catch {
    /* ignore */
  }
}

/** タブ → シェル */
export type TabToShellMessage =
  | { type: typeof TAB_MESSAGE_TYPE; kind: 'state'; url: string; title: string; theme: string | null }
  | { type: typeof TAB_MESSAGE_TYPE; kind: 'open'; id: string; url: string }
  | { type: typeof TAB_MESSAGE_TYPE; kind: 'command'; command: TabCommand };

/** タブの操作 (ショートカット) */
export type TabCommand =
  | { kind: 'new' }
  | { kind: 'close' }
  | { kind: 'next' }
  | { kind: 'prev' }
  /** index は 0 始まり。-1 は最後のタブ */
  | { kind: 'select'; index: number };

/** タブ側の window に生やす、シェルから同期で呼ぶ関数 (同一オリジンなので直接呼べる) */
export interface AppTabWindow extends Window {
  ebTabHasUnsaved?: () => boolean;
}

export function postToShell(msg: TabToShellMessage): void {
  window.parent.postMessage(msg, location.origin);
}

/**
 * 指定 URL (アプリ内の `?path=...` 等) を別タブで開く。
 * シェル内ではアプリ内タブとして開き、それ以外はブラウザの別タブで開く。
 */
export function openInNewTab(url: string): void {
  if (!appTabId) {
    window.open(url, '_blank');
    return;
  }
  const id = newTabId();
  copyTabSession(appTabId, id);
  postToShell({ type: TAB_MESSAGE_TYPE, kind: 'open', id, url });
}

/** シェルのページ */
export const SHELL_PATH = '/tabs.html';

/**
 * PWA のウィンドウで / が直接開いたら (リンクの取り込み・「アプリで開く」など)、シェルへ切り替える。
 * そのままだと別タブで開く操作が window.open になり、タブではなくウィンドウが増えるため。
 * 開いていた URL は ?open= でシェルに渡し、シェル側でタブとして開く。切り替えたら true
 */
export function enterShellIfStandalone(): boolean {
  if (appTabId || window.parent !== window) return false;
  const standalone = ['standalone', 'minimal-ui', 'window-controls-overlay', 'fullscreen'].some(
    (mode) => window.matchMedia(`(display-mode: ${mode})`).matches,
  );
  if (!standalone) return false;
  const open = location.pathname + location.search;
  location.replace(`${SHELL_PATH}?open=${encodeURIComponent(open)}`);
  return true;
}

/** T / W キーか (IME の状態や配列で key が変わっても判定できるよう code も見る) */
function isLetterKey(e: KeyboardEvent, letter: 't' | 'w'): boolean {
  return e.key.toLowerCase() === letter || e.code === `Key${letter.toUpperCase()}`;
}

/**
 * タブ操作のショートカット判定。
 * - Ctrl+T: 新しいタブ / Ctrl+W: タブを閉じる (ブラウザのタブと同じ)。
 *   PWA のウィンドウではブラウザがこれらのキーを予約しないので、ページ側で横取りできる。
 *   通常のブラウザのタブで tabs.html を開いたときはブラウザが先に使うため届かない
 * - Alt+T / Alt+W: 同上の代替 (通常のブラウザのタブでも使える)
 * - Ctrl+Tab, Ctrl+PageDown: 次のタブ / Ctrl+Shift+Tab, Ctrl+PageUp: 前のタブ
 *   (ブラウザが先に使う環境では届かない)
 * - Alt+1〜8: n 番目のタブ / Alt+9: 最後のタブ
 */
export function tabCommandFromKey(e: KeyboardEvent): TabCommand | null {
  if (e.metaKey) return null;
  if (e.altKey && !e.ctrlKey && !e.shiftKey) {
    if (isLetterKey(e, 't')) return { kind: 'new' };
    if (isLetterKey(e, 'w')) return { kind: 'close' };
    if (/^Digit[1-9]$/.test(e.code)) {
      const n = Number(e.code.slice(5));
      return { kind: 'select', index: n === 9 ? -1 : n - 1 };
    }
    return null;
  }
  if (e.ctrlKey && !e.altKey) {
    if (!e.shiftKey && isLetterKey(e, 't')) return { kind: 'new' };
    if (!e.shiftKey && isLetterKey(e, 'w')) return { kind: 'close' };
    if (e.key === 'Tab') return { kind: e.shiftKey ? 'prev' : 'next' };
    if (!e.shiftKey && e.key === 'PageDown') return { kind: 'next' };
    if (!e.shiftKey && e.key === 'PageUp') return { kind: 'prev' };
  }
  return null;
}
