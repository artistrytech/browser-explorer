import { create } from 'zustand';
import { api } from '../../api/client';
import { onWsEvent } from '../../api/ws';
import { toastError } from '../../stores/toast';
import { baseName } from '../../lib/paths';
import type { AiAgent, AiAgentsResult, AiBox, AiTurn } from '../../types';

/**
 * AI チャット (Codex / Claude) の状態。Box と会話はサーバの DB にあり、
 * 実行中の出力は WS (ai:turn / ai:boxes) で全タブへ届く。
 */

export const AI_LABELS: Record<AiAgent, string> = { codex: 'Codex', claude: 'Claude' };

/** 送信欄の選択 (AI・AI ごとのモデル / effort / 権限)。次に開いたときも引き継ぐ。空 = 既定 */
export interface ComposerPrefs {
  agent: AiAgent;
  model: Record<AiAgent, string>;
  effort: Record<AiAgent, string>;
  permission: Record<AiAgent, string>;
}

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

interface AiChatStore {
  open: boolean;
  agents: AiAgentsResult | null;
  boxes: AiBox[];
  boxesLoaded: boolean;
  selectedId: number | null;
  /** 新しい Box の作成フォームを表示中か */
  creating: boolean;
  /** 読み込み済みの Box の会話 (Box ID → ターン) */
  turns: Record<number, AiTurn[]>;
  /** 折り畳んだ AI の出力 (ターン ID) */
  collapsed: Record<number, boolean>;
  /** 送信欄の入力 (Box ごと。送信するまで保持) */
  drafts: Record<number, string>;
  prefs: ComposerPrefs;
  setOpen: (open: boolean) => void;
  setCreating: (creating: boolean) => void;
  refreshAgents: (force?: boolean) => Promise<void>;
  loadBoxes: () => Promise<void>;
  select: (id: number | null) => void;
  loadTurns: (id: number) => Promise<void>;
  setDraft: (id: number, text: string) => void;
  setPrefs: (patch: Partial<ComposerPrefs>) => void;
  toggleCollapsed: (turnId: number) => void;
  setAllCollapsed: (boxId: number, collapsed: boolean) => void;
  applyTurn: (turn: AiTurn) => void;
  applyBox: (box: AiBox) => void;
}

export const useAiChat = create<AiChatStore>((set, get) => ({
  open: false,
  agents: null,
  boxes: [],
  boxesLoaded: false,
  selectedId: loadSelectedBox(),
  creating: false,
  turns: {},
  collapsed: {},
  drafts: {},
  prefs: loadPrefs(),

  setOpen: (open) => set({ open }),
  setCreating: (creating) => set({ creating }),

  refreshAgents: async (force = false) => {
    try {
      set({ agents: await api.aiAgents(force) });
    } catch (e) {
      toastError(e);
    }
  },

  loadBoxes: async () => {
    try {
      const { boxes } = await api.aiBoxes();
      const { selectedId } = get();
      // 選択中の Box が消えていたら先頭を選ぶ
      const next = boxes.some((b) => b.id === selectedId) ? selectedId : (boxes[0]?.id ?? null);
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
      const { box, turns } = await api.aiBox(id);
      set((s) => ({ turns: { ...s.turns, [id]: turns } }));
      get().applyBox(box);
    } catch (e) {
      toastError(e);
    }
  },

  setDraft: (id, text) => set((s) => ({ drafts: { ...s.drafts, [id]: text } })),

  setPrefs: (patch) => {
    const prefs = { ...get().prefs, ...patch };
    set({ prefs });
    savePrefs(prefs);
  },

  toggleCollapsed: (turnId) => set((s) => ({ collapsed: { ...s.collapsed, [turnId]: !s.collapsed[turnId] } })),

  setAllCollapsed: (boxId, collapsed) =>
    set((s) => {
      const next = { ...s.collapsed };
      for (const t of s.turns[boxId] ?? []) next[t.id] = collapsed;
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
  onWsEvent('ai:boxes', () => {
    if (useAiChat.getState().boxesLoaded) void useAiChat.getState().loadBoxes();
  });
}

export function openAiChat(): void {
  subscribe();
  const s = useAiChat.getState();
  s.setOpen(true);
  void s.refreshAgents();
  void s.loadBoxes();
}

export function closeAiChat(): void {
  useAiChat.getState().setOpen(false);
}

/** 作成日時 (既定の Box 名に使う) */
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
