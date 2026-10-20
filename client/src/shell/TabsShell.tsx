import { useCallback, useEffect, useRef, useState } from 'react';
import { DialogHost } from '../components/DialogHost';
import { confirmDialog } from '../stores/dialog';
import {
  clearTabSession,
  frameNameOf,
  newTabId,
  tabCommandFromKey,
  TAB_MESSAGE_TYPE,
  type AppTabWindow,
  type TabCommand,
  type TabToShellMessage,
} from '../lib/appTabs';
import { isAppUrl, onLaunch, onOpenRequest, onPromotedToPrimary } from './shellWindow';
import styles from './TabsShell.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * アプリ内タブのシェル (tabs.html)。PWA の起動先で、アプリ (/) をタブごとに iframe で開く。
 * iframe ごとに JS の実行環境が分かれるので、アプリ側は 1 タブ = 1 インスタンスのまま動く
 * (タブ単位の sessionStorage の分離などアプリ側の対応は lib/appTabs.ts)。
 */

interface ShellTab {
  id: string;
  /** iframe の src。作成後に変えると読み込み直しになるので固定する */
  src: string;
  /** 現在の URL (タブ側から通知される。復元に使う) */
  url: string;
  title: string;
}

interface SavedState {
  tabs: { id: string; url: string; title: string }[];
  activeId: string | null;
}

const STATE_KEY = 'tabsShell:state';
const THEME_KEY = 'tabsShell:theme';
const DEFAULT_URL = '/';
const DEFAULT_TITLE = 'Explorer';

/** URL の view からタブのアイコンを決める (App の表示切替タブと同じ絵文字) */
const VIEW_ICONS: Record<string, string> = {
  files: '📁',
  editor: '📝',
  preview: '👁',
  commit: '🌿',
  log: '📜',
  branches: '🔀',
  review: '🔍',
  applog: '🩺',
  diff: '±',
};

function iconOf(url: string): string {
  const view = new URLSearchParams(url.split('?')[1] ?? '').get('view') ?? 'files';
  return VIEW_ICONS[view] ?? '📁';
}

function makeTab(url: string, id = newTabId(), title = DEFAULT_TITLE): ShellTab {
  return { id, src: url, url, title };
}

function loadSaved(): { tabs: ShellTab[]; activeId: string } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null') as SavedState | null;
    const tabs = (saved?.tabs ?? [])
      .filter((t) => typeof t.id === 'string' && typeof t.url === 'string' && isAppUrl(t.url))
      .map((t) => makeTab(t.url, t.id, t.title || DEFAULT_TITLE));
    if (tabs.length > 0) {
      const activeId = tabs.some((t) => t.id === saved?.activeId) ? saved!.activeId! : tabs[0].id;
      return { tabs, activeId };
    }
  } catch {
    /* 壊れた保存値は捨てて初期状態にする */
  }
  return null;
}

/**
 * 初期のタブ。主ウィンドウは保存したタブを復元し、2 つ目以降のウィンドウは新しいタブ 1 つで始める
 * (同じタブが複数のウィンドウに並ばないように)。initialOpen があれば、そのタブを開いて表示する
 */
function initialState(primary: boolean, initialOpen: string | null): { tabs: ShellTab[]; activeId: string } {
  const saved = primary ? loadSaved() : null;
  if (initialOpen) {
    const tab = makeTab(initialOpen);
    return { tabs: [...(saved?.tabs ?? []), tab], activeId: tab.id };
  }
  if (saved) return saved;
  const tab = makeTab(DEFAULT_URL);
  return { tabs: [tab], activeId: tab.id };
}

function applyTheme(theme: string): void {
  document.body.dataset.theme = theme;
}

/** 新しいタブは表示中のタブと同じフォルダで開く */
function newTabUrlFrom(tab: ShellTab | undefined): string {
  const path = tab ? new URLSearchParams(tab.url.split('?')[1] ?? '').get('path') : null;
  return path ? `/?path=${encodeURIComponent(path)}` : DEFAULT_URL;
}

export function TabsShell(props: { primary: boolean; initialOpen: string | null }) {
  const [initial] = useState(() => initialState(props.primary, props.initialOpen));
  /** タブの構成を保存するウィンドウか (shellWindow.ts。主ウィンドウが閉じたら引き継ぐ) */
  const [primary, setPrimary] = useState(props.primary);
  const [tabs, setTabs] = useState<ShellTab[]>(initial.tabs);
  const [activeId, setActiveId] = useState(initial.activeId);
  /** iframe の並び。タブの並べ替えで iframe を DOM 上で動かすと読み込み直しになるため、作成順で固定する */
  const [frameOrder, setFrameOrder] = useState<string[]>(() => initial.tabs.map((t) => t.id));
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropMark, setDropMark] = useState<{ id: string; after: boolean } | null>(null);
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  /** 閉じたタブの ID (sessionStorage の片付け待ち) */
  const closedIds = useRef<string[]>([]);
  const stateRef = useRef({ tabs, activeId });
  stateRef.current = { tabs, activeId };

  useEffect(() => onPromotedToPrimary(() => setPrimary(true)), []);

  // 保存 (再起動後の復元用)。主ウィンドウだけが保存する
  useEffect(() => {
    if (!primary) return;
    try {
      const saved: SavedState = {
        tabs: tabs.map(({ id, url, title }) => ({ id, url, title })),
        activeId,
      };
      localStorage.setItem(STATE_KEY, JSON.stringify(saved));
    } catch {
      /* ignore */
    }
  }, [tabs, activeId, primary]);

  // ウィンドウのタイトルは表示中のタブに合わせる
  const activeTitle = tabs.find((t) => t.id === activeId)?.title ?? DEFAULT_TITLE;
  useEffect(() => {
    document.title = activeTitle;
  }, [activeTitle]);

  // 切り替えたタブにフォーカスを移す。タブ側は window の focus で一覧・Git の状態を取り直す
  useEffect(() => {
    const raf = requestAnimationFrame(() => frames.current.get(activeId)?.contentWindow?.focus());
    return () => cancelAnimationFrame(raf);
  }, [activeId]);

  const addTab = useCallback((url: string, afterId: string | null, id?: string) => {
    const tab = makeTab(url, id);
    setTabs((prev) => {
      const i = afterId ? prev.findIndex((t) => t.id === afterId) : -1;
      const next = [...prev];
      next.splice(i < 0 ? next.length : i + 1, 0, tab);
      return next;
    });
    setFrameOrder((prev) => [...prev, tab.id]);
    setActiveId(tab.id);
  }, []);

  const closeTab = useCallback(async (id: string) => {
    const frameWin = frames.current.get(id)?.contentWindow as AppTabWindow | null | undefined;
    let unsaved = false;
    try {
      unsaved = frameWin?.ebTabHasUnsaved?.() ?? false;
    } catch {
      /* 読み込み途中などで呼べないときは未保存なしとして扱う */
    }
    if (unsaved) {
      setActiveId(id);
      const tab = stateRef.current.tabs.find((t) => t.id === id);
      const ok = await confirmDialog(
        'タブを閉じる',
        `「${tab?.title ?? DEFAULT_TITLE}」のエディタに未保存の変更があります。破棄して閉じますか?`,
        true,
      );
      if (!ok) return;
    }
    const { tabs: cur, activeId: curActive } = stateRef.current;
    const i = cur.findIndex((t) => t.id === id);
    if (i < 0) return;
    let rest = cur.filter((t) => t.id !== id);
    let nextActive = curActive;
    if (rest.length === 0) {
      // 最後のタブを閉じたら、同じフォルダで新しいタブを開き直す (シェルを空にしない)
      const fresh = makeTab(newTabUrlFrom(cur[i]));
      rest = [fresh];
      setFrameOrder((prev) => [...prev, fresh.id]);
      nextActive = fresh.id;
    } else if (curActive === id) {
      // ブラウザと同じく右隣 (無ければ左隣) を表示する
      nextActive = rest[Math.min(i, rest.length - 1)].id;
    }
    setTabs(rest);
    setActiveId(nextActive);
    setFrameOrder((prev) => prev.filter((f) => f !== id));
    closedIds.current.push(id);
  }, []);

  // 閉じたタブの sessionStorage を片付ける。iframe を外すとタブ側の pagehide で記憶が書き込まれるため、
  // 外し終わった (コミット後の) タイミングで消す
  useEffect(() => {
    for (const id of closedIds.current.splice(0)) clearTabSession(id);
  }, [frameOrder]);

  const runCommand = useCallback(
    (command: TabCommand, sourceId: string) => {
      const { tabs: cur, activeId: curActive } = stateRef.current;
      const i = cur.findIndex((t) => t.id === curActive);
      switch (command.kind) {
        case 'new':
          addTab(newTabUrlFrom(cur[i]), curActive);
          break;
        case 'close':
          void closeTab(sourceId);
          break;
        case 'next':
          setActiveId(cur[(i + 1) % cur.length].id);
          break;
        case 'prev':
          setActiveId(cur[(i - 1 + cur.length) % cur.length].id);
          break;
        case 'select': {
          const target = command.index < 0 ? cur[cur.length - 1] : cur[command.index];
          if (target) setActiveId(target.id);
          break;
        }
      }
    },
    [addTab, closeTab],
  );

  // タブ (iframe) からの通知
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin) return;
      const msg = e.data as TabToShellMessage | null;
      if (!msg || msg.type !== TAB_MESSAGE_TYPE) return;
      let sourceId: string | null = null;
      for (const [id, frame] of frames.current) {
        if (frame.contentWindow === e.source) sourceId = id;
      }
      if (!sourceId) return;
      const from = sourceId;
      if (msg.kind === 'state') {
        setTabs((prev) =>
          prev.map((t) => (t.id === from ? { ...t, url: msg.url, title: msg.title || DEFAULT_TITLE } : t)),
        );
        if (msg.theme && msg.theme !== document.body.dataset.theme) {
          applyTheme(msg.theme);
          try {
            localStorage.setItem(THEME_KEY, msg.theme);
          } catch {
            /* ignore */
          }
        }
      } else if (msg.kind === 'open') {
        if (isAppUrl(msg.url)) addTab(msg.url, from, msg.id);
      } else if (msg.kind === 'command') {
        runCommand(msg.command, from);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [addTab, runCommand]);

  // 別のシェルのウィンドウから渡されたタブ (2 つ目のウィンドウは渡したあと閉じる) と、
  // PWA の起動で既存のウィンドウに渡された URL (リンクの取り込み等) をタブで開く
  useEffect(() => {
    const open = (url: string) => {
      addTab(url, stateRef.current.activeId);
      window.focus();
    };
    onLaunch(open);
    return onOpenRequest(open);
  }, [addTab]);

  // シェル自体 (タブバー) にフォーカスがあるときのショートカット
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const command = tabCommandFromKey(e);
      if (!command) return;
      e.preventDefault();
      runCommand(command, stateRef.current.activeId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runCommand]);

  const onDrop = (targetId: string, after: boolean) => {
    if (!dragId || dragId === targetId) return;
    setTabs((prev) => {
      const moving = prev.find((t) => t.id === dragId);
      if (!moving) return prev;
      const rest = prev.filter((t) => t.id !== dragId);
      const j = rest.findIndex((t) => t.id === targetId);
      rest.splice(after ? j + 1 : j, 0, moving);
      return rest;
    });
  };

  const tabById = new Map(tabs.map((t) => [t.id, t]));

  return (
    <div className={cx('shell')}>
      <div
        className={cx('tab-bar')}
        onDoubleClick={(e) => {
          // タブ以外の余白のダブルクリックで新しいタブ
          if (e.target === e.currentTarget) runCommand({ kind: 'new' }, activeId);
        }}
      >
        {tabs.map((t) => (
          <div
            key={t.id}
            className={cx(
              'tab',
              t.id === activeId && 'active',
              t.id === dragId && 'dragging',
              dropMark?.id === t.id && (dropMark.after ? 'drop-after' : 'drop-before'),
            )}
            title={t.title}
            draggable
            onClick={() => setActiveId(t.id)}
            onMouseDown={(e) => {
              // 中クリックで閉じる
              if (e.button === 1) {
                e.preventDefault();
                void closeTab(t.id);
              }
            }}
            onDragStart={(e) => {
              setDragId(t.id);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', t.title);
            }}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              const after = e.clientX > rect.left + rect.width / 2;
              if (dropMark?.id !== t.id || dropMark.after !== after) setDropMark({ id: t.id, after });
            }}
            onDragLeave={() => setDropMark((m) => (m?.id === t.id ? null : m))}
            onDrop={(e) => {
              e.preventDefault();
              if (dropMark) onDrop(dropMark.id, dropMark.after);
              setDropMark(null);
            }}
            onDragEnd={() => {
              setDragId(null);
              setDropMark(null);
            }}
          >
            <span className={cx('tab-icon')}>{iconOf(t.url)}</span>
            <span className={cx('tab-label')}>{t.title}</span>
            <button
              className={cx('tab-close')}
              title="タブを閉じる (Ctrl+W)"
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(t.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          className={cx('tab-add')}
          title="新しいタブ (Ctrl+T)"
          onClick={() => runCommand({ kind: 'new' }, activeId)}
        >
          ＋
        </button>
      </div>
      <div className={cx('frames')}>
        {frameOrder.map((id) => {
          const t = tabById.get(id);
          if (!t) return null;
          return (
            <iframe
              key={id}
              ref={(el) => {
                if (el) frames.current.set(id, el);
                else frames.current.delete(id);
              }}
              name={frameNameOf(id)}
              src={t.src}
              title={t.title}
              className={cx('frame', id === activeId && 'active')}
              // 全画面プレビュー (Fullscreen API) とクリップボードへのコピーを iframe 内で使えるようにする
              allow="fullscreen; clipboard-read; clipboard-write"
            />
          );
        })}
        {/* タブのドラッグ中に iframe の上へ落としても、アプリ側のドロップ処理に渡らないよう板を敷く */}
        {dragId && <div className={cx('drag-guard')} />}
      </div>
      <DialogHost />
    </div>
  );
}

/** 起動時のテーマ。タブが読み込まれて設定を通知してくるまでの間、前回の配色で表示する */
export function applySavedTheme(): void {
  try {
    applyTheme(localStorage.getItem(THEME_KEY) ?? 'light');
  } catch {
    applyTheme('light');
  }
}
