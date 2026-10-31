import { create } from 'zustand';
import { api } from '../../api/client';
import { onWsEvent } from '../../api/ws';
import { useExplorer } from '../../stores/explorer';
import { toastError, useToast } from '../../stores/toast';
import type { TerminalInfo, TerminalShell } from '../../types';
import {
  focusTerminal,
  isTerminalFocused,
  setTerminalGoneListener,
  setTerminalInstance,
  syncTerminals,
} from './termManager';

/**
 * アプリ内のターミナルの状態。セッション (シェル) はサーバにあり、全タブで共有する。
 * 一覧の変化は WS の terminal:list で届く。表示位置は下 / 右のパネルへの固定か、フローティング。
 * 開いているかどうかはタブごと (sessionStorage) に持ち、読み込み直したときに開き直す。
 */

export type TerminalPosition = 'bottom' | 'right' | 'float';

const POSITION_KEY = 'terminal:position';
const ACTIVE_KEY = 'terminal:active';
const OPEN_KEY = 'terminal:open';
const SIZE_KEYS: Record<'bottom' | 'right', string> = { bottom: 'terminal:bottomSize', right: 'terminal:rightSize' };
/** パネルの大きさ (下 = メイン領域の高さ、右 = メイン領域全体の幅に対する %) の既定値 */
const DEFAULT_SIZES: Record<'bottom' | 'right', number> = { bottom: 35, right: 35 };

function loadPosition(): TerminalPosition {
  try {
    const v = localStorage.getItem(POSITION_KEY);
    return v === 'right' || v === 'float' ? v : 'bottom';
  } catch {
    return 'bottom';
  }
}

function loadOpen(): boolean {
  try {
    return sessionStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function saveOpen(open: boolean): void {
  try {
    if (open) sessionStorage.setItem(OPEN_KEY, '1');
    else sessionStorage.removeItem(OPEN_KEY);
  } catch {
    /* storage full 等は無視 */
  }
}

/** サーバが再起動して、このタブで開いていたターミナルが終了したことを知らせる */
function notifyRestarted(): void {
  useToast.getState().show('info', 'サーバが再起動したため、ターミナルは終了しました');
}

function loadActive(): number | null {
  try {
    const id = Number(localStorage.getItem(ACTIVE_KEY));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function saveActive(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, String(id));
  } catch {
    /* storage full 等は無視 */
  }
}

/** パネルの大きさ (%)。パネルの最小〜最大の範囲に収める */
export function loadPanelSize(pos: 'bottom' | 'right', min: number, max: number): number {
  try {
    const n = Number(localStorage.getItem(SIZE_KEYS[pos]));
    if (Number.isFinite(n) && n > 0) return Math.min(max, Math.max(min, n));
  } catch {
    /* 読めなければ既定の大きさ */
  }
  return DEFAULT_SIZES[pos];
}

export function savePanelSize(pos: 'bottom' | 'right', size: number): void {
  try {
    localStorage.setItem(SIZE_KEYS[pos], String(Math.round(size * 10) / 10));
  } catch {
    /* storage full 等は無視 */
  }
}

interface TerminalStore {
  open: boolean;
  position: TerminalPosition;
  terminals: TerminalInfo[];
  shells: TerminalShell[];
  /** 「＋」で開くシェル (設定の既定のシェル) */
  defaultShell: string;
  loaded: boolean;
  /** サーバの起動ごとの ID (再起動すると同じ id でも別のターミナルなので、画面を作り直す) */
  instance: string | null;
  activeId: number | null;
  setOpen: (open: boolean) => void;
  setPosition: (position: TerminalPosition) => void;
  /** 一覧を読み直す (消えたセッションの画面も片付ける) */
  load: () => Promise<void>;
  /** シェルを起動して選ぶ (cwd 省略 = 表示中のフォルダ、shellId 省略 = 既定のシェル) */
  create: (opts?: { cwd?: string; shellId?: string }) => Promise<void>;
  select: (id: number) => void;
  rename: (id: number, name: string) => Promise<void>;
  /** シェルを終了してタブを閉じる */
  kill: (id: number) => Promise<void>;
}

export const useTerminal = create<TerminalStore>((set, get) => ({
  open: false,
  position: loadPosition(),
  terminals: [],
  shells: [],
  defaultShell: '',
  loaded: false,
  instance: null,
  activeId: loadActive(),

  setOpen: (open) => set({ open }),

  setPosition: (position) => {
    set({ position });
    try {
      localStorage.setItem(POSITION_KEY, position);
    } catch {
      /* storage full 等は無視 */
    }
    const { activeId } = get();
    if (activeId !== null) focusTerminal(activeId);
  },

  load: async () => {
    try {
      const r = await api.terminals();
      const had = get().terminals.length > 0;
      if (setTerminalInstance(r.instance) && had) notifyRestarted();
      const { activeId } = get();
      const nextActive = r.terminals.some((t) => t.id === activeId)
        ? activeId
        : (r.terminals[r.terminals.length - 1]?.id ?? null);
      syncTerminals(r.terminals.map((t) => t.id));
      set({
        terminals: r.terminals,
        shells: r.shells,
        defaultShell: r.defaultShell,
        loaded: true,
        instance: r.instance,
        activeId: nextActive,
        // 最後のターミナルを閉じたら (exit で終了したときも) パネルも閉じる
        open: get().open && !(had && r.terminals.length === 0),
      });
      if (nextActive !== activeId) saveActive(nextActive);
    } catch (e) {
      toastError(e);
    }
  },

  create: async (opts = {}) => {
    try {
      const { instance, ...t } = await api.terminalCreate({
        cwd: opts.cwd ?? useExplorer.getState().path,
        shellId: opts.shellId,
      });
      // 一覧を読んだ後にサーバが再起動していたら、一覧にあったターミナルはもう無い
      const restarted = setTerminalInstance(instance);
      if (restarted && get().terminals.length > 0) notifyRestarted();
      set((s) => ({
        terminals: restarted ? [t] : s.terminals.some((x) => x.id === t.id) ? s.terminals : [...s.terminals, t],
        instance,
      }));
      get().select(t.id);
    } catch (e) {
      toastError(e);
    }
  },

  select: (id) => {
    set({ activeId: id });
    saveActive(id);
    focusTerminal(id);
  },

  rename: async (id, name) => {
    set((s) => ({ terminals: s.terminals.map((t) => (t.id === id ? { ...t, name } : t)) }));
    try {
      await api.terminalRename(id, name);
    } catch (e) {
      toastError(e);
    }
  },

  kill: async (id) => {
    const { terminals, activeId } = get();
    const i = terminals.findIndex((t) => t.id === id);
    const rest = terminals.filter((t) => t.id !== id);
    // 閉じたタブの隣 (右、無ければ左) を選ぶ
    const next = activeId === id ? (rest[Math.min(i, rest.length - 1)]?.id ?? null) : activeId;
    syncTerminals(rest.map((t) => t.id));
    set({ terminals: rest, activeId: next, open: get().open && rest.length > 0 });
    saveActive(next);
    if (next !== null) focusTerminal(next);
    try {
      await api.terminalKill(id);
    } catch (e) {
      toastError(e);
    }
  },
}));

useTerminal.subscribe((s, prev) => {
  if (s.open !== prev.open) saveOpen(s.open);
});

let subscribed = false;

/** WS の購読 (初めて開いたときに 1 回だけ) */
function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  onWsEvent('terminal:list', () => void useTerminal.getState().load());
  setTerminalGoneListener(() => void useTerminal.getState().load());
}

/** 開く。ターミナルが 1 つも無ければ、表示中のフォルダで既定のシェルを起動する */
export async function openTerminal(): Promise<void> {
  subscribe();
  useTerminal.getState().setOpen(true);
  await useTerminal.getState().load();
  const s = useTerminal.getState();
  if (s.terminals.length === 0) await s.create();
  else if (s.activeId !== null) focusTerminal(s.activeId);
}

/** 指定のフォルダ (ファイルならその親のフォルダ) で新しいターミナルを開く */
export async function openTerminalAt(cwd: string): Promise<void> {
  subscribe();
  useTerminal.getState().setOpen(true);
  if (!useTerminal.getState().loaded) await useTerminal.getState().load();
  await useTerminal.getState().create({ cwd });
}

/** 読み込み直す前にこのタブで開いていたら、ターミナルが残っていれば開き直す (起動時に 1 回) */
export async function restoreTerminal(): Promise<void> {
  if (!loadOpen()) return;
  subscribe();
  await useTerminal.getState().load();
  if (useTerminal.getState().terminals.length > 0) useTerminal.getState().setOpen(true);
  else saveOpen(false);
}

export function closeTerminal(): void {
  useTerminal.getState().setOpen(false);
}

/** 表示中なら閉じ、閉じていれば開く (ツールバーのアイコン用) */
export function toggleTerminal(): void {
  if (useTerminal.getState().open) closeTerminal();
  else void openTerminal();
}

/**
 * Ctrl+` (日本語キーボードは Ctrl+@ も): 閉じていれば開く。開いていれば、
 * ターミナルを操作中なら閉じ、そうでなければターミナルにフォーカスを移す。
 * キャプチャで拾い、エディタ (Monaco) やターミナル自身より先に受け取る
 */
window.addEventListener(
  'keydown',
  (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || (e.key !== '`' && e.key !== '@')) return;
    e.preventDefault();
    e.stopPropagation();
    const s = useTerminal.getState();
    if (!s.open) void openTerminal();
    else if (isTerminalFocused()) closeTerminal();
    else if (s.activeId !== null) focusTerminal(s.activeId);
  },
  true,
);
