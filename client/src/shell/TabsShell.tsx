import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { api } from '../api/client';
import { ContextMenuHost, useContextMenu } from '../components/ContextMenu';
import { DialogHost } from '../components/DialogHost';
import { confirmDialog } from '../stores/dialog';
import {
  clearTabSession,
  frameNameOf,
  isCommandPaletteKey,
  newTabId,
  tabCommandFromKey,
  TAB_MESSAGE_TYPE,
  type AppTabWindow,
  type TabCommand,
  type TabToShellMessage,
} from '../lib/appTabs';
import {
  EMPTY_REPO_GROUPS,
  normalizeRepoGroups,
  onRepoGroupsChanged,
  repoBadgeOf,
  REPO_GROUPS_KEY,
  textColorOn,
} from '../lib/repoGroups';
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
  /** 開いているリポジトリのルート (タブ側から通知される。グループの色・短縮名に使う) */
  repo: string | null;
}

interface SavedState {
  tabs: { id: string; url: string; title: string; repo?: string | null }[];
  activeId: string | null;
}

const STATE_KEY = 'tabsShell:state';
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

function makeTab(url: string, id = newTabId(), title = DEFAULT_TITLE, repo: string | null = null): ShellTab {
  return { id, src: url, url, title, repo };
}

function loadSaved(): { tabs: ShellTab[]; activeId: string } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null') as SavedState | null;
    const tabs = (saved?.tabs ?? [])
      .filter((t) => typeof t.id === 'string' && typeof t.url === 'string' && isAppUrl(t.url))
      .map((t) => makeTab(t.url, t.id, t.title || DEFAULT_TITLE, typeof t.repo === 'string' ? t.repo : null));
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
  /** リポジトリのグループ分け (タブの色・短縮名)。ダイアログで変更されたらタブ側から知らされる */
  const [repoGroups, setRepoGroups] = useState(EMPTY_REPO_GROUPS);
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  /** 閉じたタブの ID (sessionStorage の片付け待ち) */
  const closedIds = useRef<string[]>([]);
  const openMenu = useContextMenu((s) => s.open);
  const stateRef = useRef({ tabs, activeId });
  stateRef.current = { tabs, activeId };

  useEffect(() => onPromotedToPrimary(() => setPrimary(true)), []);

  useEffect(() => {
    let alive = true;
    api
      .getState()
      .then((s) => {
        if (alive) setRepoGroups(normalizeRepoGroups(s.settings[REPO_GROUPS_KEY]));
      })
      .catch(() => {});
    const off = onRepoGroupsChanged(setRepoGroups);
    return () => {
      alive = false;
      off();
    };
  }, []);

  // 保存 (再起動後の復元用)。主ウィンドウだけが保存する
  useEffect(() => {
    if (!primary) return;
    try {
      const saved: SavedState = {
        tabs: tabs.map(({ id, url, title, repo }) => ({ id, url, title, repo })),
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

  /**
   * タブをまとめて閉じる。エディタに未保存の変更があるタブを含むときは 1 回だけ確認し、
   * キャンセルしたらどのタブも閉じない
   */
  const closeTabs = useCallback(async (ids: string[]) => {
    const unsaved = ids.filter((id) => {
      const frameWin = frames.current.get(id)?.contentWindow as AppTabWindow | null | undefined;
      try {
        return frameWin?.ebTabHasUnsaved?.() ?? false;
      } catch {
        /* 読み込み途中などで呼べないときは未保存なしとして扱う */
        return false;
      }
    });
    if (unsaved.length > 0) {
      const titleOf = (id: string) => stateRef.current.tabs.find((t) => t.id === id)?.title ?? DEFAULT_TITLE;
      // 1 つだけなら、そのタブを表示して確認する
      if (unsaved.length === 1) setActiveId(unsaved[0]);
      const ok = await confirmDialog(
        ids.length > 1 ? 'タブをまとめて閉じる' : 'タブを閉じる',
        unsaved.length === 1
          ? `「${titleOf(unsaved[0])}」のエディタに未保存の変更があります。破棄して閉じますか?`
          : `次のタブのエディタに未保存の変更があります。破棄して閉じますか?\n${unsaved
              .map((id) => `・${titleOf(id)}`)
              .join('\n')}`,
        true,
      );
      if (!ok) return;
    }
    const { tabs: cur, activeId: curActive } = stateRef.current;
    const closing = new Set(ids.filter((id) => cur.some((t) => t.id === id)));
    if (closing.size === 0) return;
    let rest = cur.filter((t) => !closing.has(t.id));
    let nextActive = curActive;
    if (rest.length === 0) {
      // 最後のタブを閉じたら、同じフォルダで新しいタブを開き直す (シェルを空にしない)
      const fresh = makeTab(newTabUrlFrom(cur.find((t) => t.id === curActive) ?? cur[0]));
      rest = [fresh];
      setFrameOrder((prev) => [...prev, fresh.id]);
      nextActive = fresh.id;
    } else if (closing.has(curActive)) {
      // ブラウザと同じく右隣 (無ければ左隣) の残るタブを表示する
      const i = cur.findIndex((t) => t.id === curActive);
      const right = cur.slice(i + 1).find((t) => !closing.has(t.id));
      const left = cur.slice(0, i).reverse().find((t) => !closing.has(t.id));
      nextActive = (right ?? left)!.id;
    }
    setTabs(rest);
    setActiveId(nextActive);
    setFrameOrder((prev) => prev.filter((f) => !closing.has(f)));
    closedIds.current.push(...closing);
  }, []);

  const closeTab = useCallback((id: string) => closeTabs([id]), [closeTabs]);

  /** タブの右クリックメニュー */
  const openTabMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === id);
    const others = tabs.filter((t) => t.id !== id).map((t) => t.id);
    const right = tabs.slice(i + 1).map((t) => t.id);
    openMenu(e.clientX, e.clientY, [
      { label: '新しいタブ', action: () => addTab(newTabUrlFrom(tabs[i]), id) },
      { separator: true },
      { label: 'タブを閉じる', action: () => void closeTab(id) },
      { label: '他のタブをすべて閉じる', disabled: others.length === 0, action: () => void closeTabs(others) },
      { label: '右側のタブを閉じる', disabled: right.length === 0, action: () => void closeTabs(right) },
    ]);
  };

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
          prev.map((t) =>
            t.id === from ? { ...t, url: msg.url, title: msg.title || DEFAULT_TITLE, repo: msg.repo ?? null } : t,
          ),
        );
        // シェルの配色をタブに合わせる (控えの保存はタブ側の App が行う。起動直後の配色は tabs.html で付ける)
        if (msg.theme) document.body.dataset.theme = msg.theme;
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
      // コマンドパレットは表示中のタブ (アプリ) 側で開く
      if (isCommandPaletteKey(e)) {
        e.preventDefault();
        const win = frames.current.get(stateRef.current.activeId)?.contentWindow as AppTabWindow | null | undefined;
        win?.focus();
        win?.ebOpenCommandPalette?.();
        return;
      }
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
        {tabs.map((t) => {
          const badge = repoBadgeOf(repoGroups, t.repo);
          return (
            <div
              key={t.id}
              className={cx(
                'tab',
                t.id === activeId && 'active',
                badge && 'grouped',
                t.id === dragId && 'dragging',
                dropMark?.id === t.id && (dropMark.after ? 'drop-after' : 'drop-before'),
              )}
              title={t.title}
              // グループの色を背景に混ぜる (TabsShell.module.scss の .grouped)
              style={badge ? ({ '--group-color': badge.color } as CSSProperties) : undefined}
              draggable
              onClick={() => setActiveId(t.id)}
              onContextMenu={(e) => openTabMenu(e, t.id)}
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
              {badge?.short && (
                <span
                  className={cx('tab-chip')}
                  style={{ background: badge.color, color: textColorOn(badge.color) }}
                >
                  {badge.short}
                </span>
              )}
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
          );
        })}
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
      <ContextMenuHost />
      <DialogHost />
    </div>
  );
}
