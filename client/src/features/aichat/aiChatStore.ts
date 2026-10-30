import { create } from 'zustand';
import { api } from '../../api/client';
import { onWsEvent } from '../../api/ws';
import { confirmDialog } from '../../stores/dialog';
import { useExplorer } from '../../stores/explorer';
import { toastError } from '../../stores/toast';
import { baseName } from '../../lib/paths';
import type { AiAgent, AiAgentsResult, AiBox, AiBoxPrefs, AiTurn } from '../../types';

/**
 * AI チャット (Codex / Claude) の状態。Box と会話はサーバの DB にあり、
 * 実行中の出力は WS (ai:turn / ai:boxes) で全タブへ届く。
 */

export const AI_LABELS: Record<AiAgent, string> = { codex: 'Codex', claude: 'Claude' };

/**
 * 送信欄の選択 (AI・AI ごとのモデル / effort / 権限)。空 = 既定。
 * Box ごとに保存して開いたときに復元する。ここに持つのは最後に使った選択で、
 * まだ選択を保存していない Box (新しい Box 等) の初期値にする
 */
export type ComposerPrefs = AiBoxPrefs;

const PREFS_KEY = 'aichat:composer';
const BOX_KEY = 'aichat:box';

function loadPrefs(): ComposerPrefs {
  const none = { codex: '', claude: '' };
  const fallback: ComposerPrefs = { agent: 'codex', model: none, effort: none, permission: none };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<ComposerPrefs>;
    return {
      agent: p.agent === 'claude' ? 'claude' : 'codex',
      model: { ...fallback.model, ...p.model },
      effort: { ...fallback.effort, ...p.effort },
      permission: { ...fallback.permission, ...p.permission },
    };
  } catch {
    return fallback;
  }
}

function savePrefs(p: ComposerPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage full 等は無視 */
  }
}

function loadSelectedBox(): number | null {
  try {
    const id = Number(localStorage.getItem(BOX_KEY));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function saveSelectedBox(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(BOX_KEY);
    else localStorage.setItem(BOX_KEY, String(id));
  } catch {
    /* storage full 等は無視 */
  }
}

const DOCKED_KEY = 'aichat:docked';
const DOCK_SIZE_KEY = 'aichat:dockSize';
/** 右パネルの幅 (メイン領域全体に対する %) の既定値 */
const DEFAULT_DOCK_SIZE = 32;

function loadDocked(): boolean {
  try {
    return localStorage.getItem(DOCKED_KEY) === '1';
  } catch {
    return false;
  }
}

/** 右パネルの幅 (%)。パネルの最小〜最大の範囲に収める */
export function loadDockSize(min: number, max: number): number {
  try {
    const n = Number(localStorage.getItem(DOCK_SIZE_KEY));
    if (Number.isFinite(n) && n > 0) return Math.min(max, Math.max(min, n));
  } catch {
    /* 読めなければ既定の幅 */
  }
  return DEFAULT_DOCK_SIZE;
}

export function saveDockSize(size: number): void {
  try {
    localStorage.setItem(DOCK_SIZE_KEY, String(Math.round(size * 10) / 10));
  } catch {
    /* storage full 等は無視 */
  }
}

const COMPOSER_HEIGHT_KEY = 'aichat:composerHeight';

/** 送信欄の高さ (px)。null = 既定の高さ */
function loadComposerHeight(): number | null {
  try {
    const n = Number(localStorage.getItem(COMPOSER_HEIGHT_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function saveComposerHeight(h: number | null): void {
  try {
    if (h === null) localStorage.removeItem(COMPOSER_HEIGHT_KEY);
    else localStorage.setItem(COMPOSER_HEIGHT_KEY, String(Math.round(h)));
  } catch {
    /* storage full 等は無視 */
  }
}

/** パスの比較用の表記 (区切り・末尾の / の違いを無視し、Windows のパスは大文字小文字を区別しない) */
function pathKey(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/(?<=.)\/+$/, '');
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s;
}

/** dir が path と同じフォルダか、その親 (祖先) のフォルダか。どちらも pathKey の表記 */
function containsPath(dir: string, path: string): boolean {
  return path === dir || path.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
}

/**
 * cwd を開くときに選ぶ Box。ベースフォルダが cwd か、その親のフォルダの Box のうち、
 * 最も近いフォルダ (cwd に一致するものが最優先) の、最後に使ったもの
 */
function latestBoxFor(boxes: AiBox[], cwd: string): AiBox | null {
  const target = pathKey(cwd);
  let best: { box: AiBox; depth: number } | null = null;
  for (const b of boxes) {
    const dir = pathKey(b.cwd);
    if (!containsPath(dir, target)) continue;
    const depth = dir.length;
    if (!best || depth > best.depth || (depth === best.depth && b.lastActiveAt > best.box.lastActiveAt)) {
      best = { box: b, depth };
    }
  }
  return best?.box ?? null;
}

/** 1 回に読み込む会話の件数 (古いものは「さらに読み込む」で遡る) */
export const TURNS_PAGE_SIZE = 10;

/**
 * AI の出力を折り畳んで表示するか。明示的に開閉したものはその状態、それ以外は最新以外を折り畳む
 * (Box を開いたときは最新だけを展開し、新しい依頼を送ると前のものは折り畳まれる)
 */
export function isTurnCollapsed(
  collapsed: Record<number, boolean>,
  turns: AiTurn[],
  turnId: number,
): boolean {
  return collapsed[turnId] ?? turnId !== turns[turns.length - 1]?.id;
}

interface AiChatStore {
  open: boolean;
  /** 右パネルに固定して表示するか (false はフローティングウィンドウ) */
  docked: boolean;
  agents: AiAgentsResult | null;
  boxes: AiBox[];
  boxesLoaded: boolean;
  selectedId: number | null;
  /** 新しい Box の作成フォームを表示中か */
  creating: boolean;
  /** 読み込み済みの Box の会話 (Box ID → ターン) */
  turns: Record<number, AiTurn[]>;
  /** さらに古い会話が残っているか (Box ID → 有無) */
  hasMore: Record<number, boolean>;
  /** AI の出力を明示的に開閉した状態 (ターン ID → 折り畳むか)。無ければ isTurnCollapsed の既定 */
  collapsed: Record<number, boolean>;
  /** 送信欄の入力 (Box ごと。送信するまで保持) */
  drafts: Record<number, string>;
  /** 最後に使った送信欄の選択 (選択を保存していない Box の初期値) */
  prefs: ComposerPrefs;
  /** 送信欄の高さ (px。会話との境界のドラッグで変える)。null = 既定の高さ */
  composerHeight: number | null;
  setOpen: (open: boolean) => void;
  setDocked: (docked: boolean) => void;
  setCreating: (creating: boolean) => void;
  refreshAgents: (force?: boolean) => Promise<void>;
  /** Box の一覧を読み込む。cwd を渡すと、そのフォルダの最後に使った Box があれば選ぶ */
  loadBoxes: (opts?: { cwd?: string }) => Promise<void>;
  select: (id: number | null) => void;
  /** 最新の会話を読み込み直す (開閉の状態も既定に戻す) */
  loadTurns: (id: number) => Promise<void>;
  /** 読み込み済みより古い会話を読み足す */
  loadMoreTurns: (id: number) => Promise<void>;
  /** 削除した会話を一覧から除く (older = それより古いものもまとめて消した) */
  removeTurns: (boxId: number, ids: number[], older: boolean) => void;
  /** 開閉の状態を既定 (最新以外を折り畳む) に戻す */
  resetCollapsed: (boxId: number) => void;
  setDraft: (id: number, text: string) => void;
  /** Box の送信欄の選択を変えて保存する (最後に使った選択としても覚える) */
  setBoxPrefs: (box: AiBox, patch: Partial<ComposerPrefs>) => void;
  /** 送信欄の高さを変える (save = 保存もする。ドラッグ中は保存しない) */
  setComposerHeight: (h: number | null, save: boolean) => void;
  toggleCollapsed: (turnId: number) => void;
  /** Box の出力をまとめて開閉する (exceptId のターンはそのまま) */
  setAllCollapsed: (boxId: number, collapsed: boolean, exceptId?: number) => void;
  applyTurn: (turn: AiTurn) => void;
  applyBox: (box: AiBox) => void;
}

export const useAiChat = create<AiChatStore>((set, get) => ({
  open: false,
  docked: loadDocked(),
  agents: null,
  boxes: [],
  boxesLoaded: false,
  selectedId: loadSelectedBox(),
  creating: false,
  turns: {},
  hasMore: {},
  collapsed: {},
  drafts: {},
  prefs: loadPrefs(),
  composerHeight: loadComposerHeight(),

  setOpen: (open) => set({ open }),

  setDocked: (docked) => {
    set({ docked });
    try {
      if (docked) localStorage.setItem(DOCKED_KEY, '1');
      else localStorage.removeItem(DOCKED_KEY);
    } catch {
      /* storage full 等は無視 */
    }
  },
  setCreating: (creating) => set({ creating }),

  refreshAgents: async (force = false) => {
    try {
      set({ agents: await api.aiAgents(force) });
    } catch (e) {
      toastError(e);
    }
  },

  loadBoxes: async (opts = {}) => {
    try {
      const { boxes } = await api.aiBoxes();
      const { selectedId } = get();
      // 指定のフォルダ (またはその親のフォルダ) の Box を優先し、無ければ選択中のまま (消えていたら先頭を選ぶ)
      const preferred = opts.cwd ? latestBoxFor(boxes, opts.cwd) : null;
      const next =
        preferred?.id ?? (boxes.some((b) => b.id === selectedId) ? selectedId : (boxes[0]?.id ?? null));
      set({ boxes, boxesLoaded: true, creating: get().creating || boxes.length === 0 });
      if (next !== selectedId) get().select(next);
      else if (next !== null && !get().turns[next]) void get().loadTurns(next);
    } catch (e) {
      toastError(e);
    }
  },

  select: (id) => {
    set({ selectedId: id, creating: false });
    saveSelectedBox(id);
    if (id !== null) void get().loadTurns(id);
  },

  loadTurns: async (id) => {
    try {
      const { box, turns, hasMore } = await api.aiBox(id, { limit: TURNS_PAGE_SIZE });
      get().resetCollapsed(id);
      set((s) => ({ turns: { ...s.turns, [id]: turns }, hasMore: { ...s.hasMore, [id]: hasMore } }));
      get().applyBox(box);
    } catch (e) {
      toastError(e);
    }
  },

  loadMoreTurns: async (id) => {
    const loaded = get().turns[id];
    if (!loaded || loaded.length === 0) return;
    try {
      const r = await api.aiBox(id, { limit: TURNS_PAGE_SIZE, before: loaded[0].id });
      set((s) => {
        const cur = s.turns[id] ?? [];
        // 読み込み中に届いた更新と重ならないよう、既にあるものは除いて前に足す
        const older = r.turns.filter((t) => !cur.some((c) => c.id === t.id));
        return { turns: { ...s.turns, [id]: [...older, ...cur] }, hasMore: { ...s.hasMore, [id]: r.hasMore } };
      });
    } catch (e) {
      toastError(e);
    }
  },

  removeTurns: (boxId, ids, older) =>
    set((s) => {
      const list = s.turns[boxId];
      if (!list) return {};
      const gone = new Set(ids);
      return {
        turns: { ...s.turns, [boxId]: list.filter((t) => !gone.has(t.id)) },
        // それより古いものもまとめて消したなら、もう遡れる会話は無い
        hasMore: { ...s.hasMore, [boxId]: older ? false : s.hasMore[boxId] },
      };
    }),

  resetCollapsed: (boxId) =>
    set((s) => {
      const next = { ...s.collapsed };
      for (const t of s.turns[boxId] ?? []) delete next[t.id];
      return { collapsed: next };
    }),

  setDraft: (id, text) => set((s) => ({ drafts: { ...s.drafts, [id]: text } })),

  setBoxPrefs: (box, patch) => {
    const prefs = { ...(box.prefs ?? get().prefs), ...patch };
    set((s) => ({ prefs, boxes: s.boxes.map((b) => (b.id === box.id ? { ...b, prefs } : b)) }));
    savePrefs(prefs);
    // 画面には先に反映済み。続けて変えたときに古い応答で戻らないよう、応答は反映しない
    api.aiUpdateBox(box.id, { prefs }).catch(toastError);
  },

  setComposerHeight: (h, save) => {
    set({ composerHeight: h });
    if (save) saveComposerHeight(h);
  },

  toggleCollapsed: (turnId) =>
    set((s) => {
      const list = Object.values(s.turns).find((l) => l.some((t) => t.id === turnId)) ?? [];
      return { collapsed: { ...s.collapsed, [turnId]: !isTurnCollapsed(s.collapsed, list, turnId) } };
    }),

  setAllCollapsed: (boxId, collapsed, exceptId) =>
    set((s) => {
      const next = { ...s.collapsed };
      for (const t of s.turns[boxId] ?? []) {
        if (t.id !== exceptId) next[t.id] = collapsed;
      }
      return { collapsed: next };
    }),

  applyTurn: (turn) =>
    set((s) => {
      const boxes = s.boxes.map((b) => (b.id === turn.boxId ? { ...b, running: turn.status === 'running' } : b));
      const list = s.turns[turn.boxId];
      if (!list) return { boxes };
      const i = list.findIndex((t) => t.id === turn.id);
      const next = i >= 0 ? list.map((t) => (t.id === turn.id ? turn : t)) : [...list, turn];
      return { boxes, turns: { ...s.turns, [turn.boxId]: next } };
    }),

  applyBox: (box) => set((s) => ({ boxes: s.boxes.map((b) => (b.id === box.id ? box : b)) })),
}));

let subscribed = false;

/** WS の購読 (初めて開いたときに 1 回だけ) */
function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  onWsEvent('ai:turn', (data) => useAiChat.getState().applyTurn(data as AiTurn));
  onWsEvent('ai:turns-deleted', (data) => {
    const { boxId, ids, older } = data as { boxId: number; ids: number[]; older: boolean };
    useAiChat.getState().removeTurns(boxId, ids, older);
  });
  onWsEvent('ai:boxes', () => {
    if (useAiChat.getState().boxesLoaded) void useAiChat.getState().loadBoxes();
  });
}

export function openAiChat(): void {
  subscribe();
  const s = useAiChat.getState();
  s.setOpen(true);
  // 開き直したときも、最新以外は折り畳んだ状態から表示する
  if (s.selectedId !== null) s.resetCollapsed(s.selectedId);
  void s.refreshAgents();
  // 表示中のフォルダ (無ければその親のフォルダ) で最後に使った Box を開く (無ければ前回の Box のまま)
  void s.loadBoxes({ cwd: useExplorer.getState().path });
}

export function closeAiChat(): void {
  useAiChat.getState().setOpen(false);
}

/** 表示中なら閉じ、閉じていれば開く (ツールバーのアイコン用) */
export function toggleAiChat(): void {
  if (useAiChat.getState().open) closeAiChat();
  else openAiChat();
}

/** 作成日時 (既定の Box 名に使う) */
/**
 * 会話 (依頼と AI の出力) を確認のうえ削除する。older なら、それより古い同じ Box の会話もまとめて削除する。
 * 消えるのはこのアプリの記録だけで、CLI 側の会話の記録 (継続したときの文脈) は残る
 */
export async function deleteTurn(turn: AiTurn, older: boolean): Promise<void> {
  const ok = await confirmDialog(
    older ? 'これより古い会話の削除' : 'メッセージの削除',
    `${older ? 'このメッセージと、これより古い会話をすべて' : 'このメッセージ (依頼と AI の出力) を'}削除します。\n` +
      'AI 側の会話の記録は残るため、「継続」で送ると削除した内容も文脈に含まれます。',
    true,
  );
  if (!ok) return;
  try {
    const r = await api.aiDeleteTurns(turn.boxId, turn.id, older);
    useAiChat.getState().removeTurns(turn.boxId, r.deleted, older);
  } catch (e) {
    toastError(e);
  }
}

export function timestampName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 既定の Box 名: フォルダ名 (リポジトリ内ならリポジトリのルートのフォルダ名) + 作成日時 */
export async function defaultBoxName(cwd: string, stamp: string): Promise<string> {
  let dir = cwd.trim();
  try {
    const r = await api.isRepo(dir);
    if (r.isRepo && r.root) dir = r.root;
  } catch {
    /* 存在しないフォルダ等はそのままの名前を使う */
  }
  const folder = baseName(dir.replace(/\\/g, '/'));
  return folder ? `${folder} ${stamp}` : stamp;
}
