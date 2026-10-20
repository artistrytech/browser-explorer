/**
 * シェルのウィンドウが複数開いたときの調停。
 *
 * PWA では起動・リンクの取り込み・「アプリで開く」などで、シェルのウィンドウが複数開くことがある。
 * タブの構成は 1 つしか保存しないので、保存・復元を受け持つ「主ウィンドウ」を Web Locks で 1 つに決める。
 * - 主ウィンドウ: 保存したタブを復元し、構成を保存する。他のウィンドウから「このタブを開いて」を受け取る
 * - 2 つ目以降: 開く URL があれば主ウィンドウへ渡して自分は閉じる。無ければ (「新しいウィンドウ」等)
 *   新しいタブ 1 つで始め、保存はしない。主ウィンドウが閉じたら主を引き継ぐ
 */

const LOCK_NAME = 'tabsShell:primary';
const CHANNEL_NAME = 'tabsShell';

interface ShellChannelMessage {
  kind: 'open';
  url: string;
}

let primary = false;
const promotedListeners = new Set<() => void>();

export function isPrimaryShell(): boolean {
  return primary;
}

/** 主ウィンドウを引き継いだときに呼ばれる */
export function onPromotedToPrimary(cb: () => void): () => void {
  promotedListeners.add(cb);
  return () => promotedListeners.delete(cb);
}

/** 主ウィンドウかどうかを決める。ロックはウィンドウを閉じるまで持ち続ける */
export function acquirePrimary(): Promise<boolean> {
  if (!navigator.locks) {
    primary = true;
    return Promise.resolve(true);
  }
  const holdForever = () => new Promise<void>(() => {});
  return new Promise((resolve) => {
    void navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
      if (lock) {
        primary = true;
        resolve(true);
        return holdForever();
      }
      resolve(false);
      // 主ウィンドウが閉じたらロックが空くので、そこで主を引き継ぐ
      void navigator.locks.request(LOCK_NAME, () => {
        primary = true;
        for (const cb of promotedListeners) cb();
        return holdForever();
      });
      return undefined;
    });
  });
}

/** アプリ内の URL か (/ 始まりの同一オリジン。// で始まる別ホスト指定は除く) */
export function isAppUrl(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//');
}

/**
 * 起動時に開く URL。`/tabs.html?open=<アプリの URL>` で渡される
 * (PWA のウィンドウで / が直接開いたとき、lib/appTabs.ts の enterShellIfStandalone が付ける)。
 * 読んだら URL から外す (リロードで同じタブが増えないように)
 */
export function takeOpenParam(): string | null {
  const params = new URLSearchParams(location.search);
  const open = params.get('open');
  if (open === null) return null;
  params.delete('open');
  const rest = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}`);
  return isAppUrl(open) ? open : null;
}

/** 主ウィンドウへ「このタブを開いて」を送る */
export function sendOpenToPrimary(url: string): void {
  const ch = new BroadcastChannel(CHANNEL_NAME);
  ch.postMessage({ kind: 'open', url } satisfies ShellChannelMessage);
  ch.close();
}

/** 他のウィンドウからの「このタブを開いて」を受け取る (主ウィンドウのときだけ呼ばれる) */
export function onOpenRequest(cb: (url: string) => void): () => void {
  const ch = new BroadcastChannel(CHANNEL_NAME);
  ch.onmessage = (e: MessageEvent<ShellChannelMessage>) => {
    if (primary && e.data?.kind === 'open' && isAppUrl(e.data.url)) cb(e.data.url);
  };
  return () => ch.close();
}

interface LaunchParams {
  readonly targetURL?: string;
}
interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

/**
 * PWA の起動 (manifest の launch_handler: focus-existing) で、既存のウィンドウに渡された URL を受け取る。
 * アイコンからの起動 (/tabs.html) は前面に出すだけで、アプリの URL (リンクの取り込み等) はタブで開く
 */
export function onLaunch(cb: (url: string) => void): void {
  const queue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue;
  queue?.setConsumer((params) => {
    if (!params.targetURL) return;
    const u = new URL(params.targetURL);
    if (u.origin !== location.origin) return;
    if (u.pathname === location.pathname) {
      const open = u.searchParams.get('open');
      if (open && isAppUrl(open)) cb(open);
      return;
    }
    cb(u.pathname + u.search);
  });
}
