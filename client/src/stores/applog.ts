import { create } from 'zustand';
import { api } from '../api/client';
import { switchView, replaceView, useUi } from './ui';
import type { LogEntry, LogLevel, LogSource } from '../types';

/** アプリログビューの絞り込み条件 (空文字は「指定なし」) */
export interface AppLogFilter {
  q: string;
  /** これ以上のレベル */
  level: LogLevel;
  source: LogSource | '';
  session: string;
  request: string;
  /** datetime-local の値 (ローカル時刻)。空で無指定 */
  from: string;
  to: string;
}

export const DEFAULT_LOG_FILTER: AppLogFilter = {
  q: '',
  level: 'info',
  source: '',
  session: '',
  request: '',
  from: '',
  to: '',
};

const PAGE = 200;

interface AppLogStore {
  /** タブを表示中か (閉じるまで残る。差分/プレビュータブと同じ扱い) */
  opened: boolean;
  filter: AppLogFilter;
  entries: LogEntry[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  /** 一定間隔で先頭を再読込するか */
  autoRefresh: boolean;
  setFilter: (patch: Partial<AppLogFilter>) => void;
  resetFilter: () => void;
  /** 条件で先頭から読み直す */
  reload: () => Promise<void>;
  /** 表示中の末尾より古い行を追加読込 */
  loadMore: () => Promise<void>;
  setAutoRefresh: (on: boolean) => void;
}

/** datetime-local の値 → ISO (UTC)。不正なら undefined */
function localToIso(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

let seq = 0;

export const useAppLog = create<AppLogStore>((set, get) => ({
  opened: false,
  filter: DEFAULT_LOG_FILTER,
  entries: [],
  hasMore: false,
  loading: false,
  error: null,
  autoRefresh: false,

  setFilter: (patch) => set((s) => ({ filter: { ...s.filter, ...patch } })),
  resetFilter: () => set({ filter: DEFAULT_LOG_FILTER }),

  reload: async () => {
    const my = ++seq;
    const f = get().filter;
    set({ loading: true, error: null });
    try {
      const r = await api.logQuery({
        q: f.q.trim() || undefined,
        level: f.level,
        source: f.source || undefined,
        session: f.session.trim() || undefined,
        request: f.request.trim() || undefined,
        from: localToIso(f.from),
        to: localToIso(f.to),
        limit: PAGE,
      });
      if (my !== seq) return; // 後から出した要求が先に返っている
      set({ entries: r.entries, hasMore: r.hasMore, loading: false });
    } catch (e) {
      if (my !== seq) return;
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  loadMore: async () => {
    const { entries, loading, filter: f } = get();
    const last = entries[entries.length - 1];
    if (loading || !last) return;
    const my = ++seq;
    set({ loading: true });
    try {
      const r = await api.logQuery({
        q: f.q.trim() || undefined,
        level: f.level,
        source: f.source || undefined,
        session: f.session.trim() || undefined,
        request: f.request.trim() || undefined,
        from: localToIso(f.from),
        to: localToIso(f.to),
        before: last.id,
        limit: PAGE,
      });
      if (my !== seq) return;
      set((s) => ({ entries: [...s.entries, ...r.entries], hasMore: r.hasMore, loading: false }));
    } catch (e) {
      if (my !== seq) return;
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  setAutoRefresh: (autoRefresh) => set({ autoRefresh }),
}));

/**
 * アプリログタブを開く。filter を渡すとその条件で絞り込んだ状態にする
 * (エラートーストのリクエスト ID クリック → そのリクエストのログ、等)。
 * 条件指定なしで既に開いていれば表示だけ切り替える (絞り込みは保持)。
 */
export function openAppLog(filter?: Partial<AppLogFilter>): void {
  const s = useAppLog.getState();
  if (filter) {
    // 指定された条件以外は既定に戻す (前回の絞り込みが残って「該当なし」になるのを防ぐ)。
    // リクエスト/セッション指定時はレベルを debug にして全行見せる
    const level: LogLevel = filter.request || filter.session ? 'debug' : DEFAULT_LOG_FILTER.level;
    useAppLog.setState({ filter: { ...DEFAULT_LOG_FILTER, level, ...filter }, entries: [], hasMore: false });
  }
  if (!s.opened) useAppLog.setState({ opened: true });
  // 読み込みはビュー側 (AppLogTab) がマウント時と条件変更時に行う
  switchView('applog');
}

/** アプリログタブを閉じる。表示中だった場合はファイル一覧へ戻す (履歴は積まない) */
export function closeAppLog(): void {
  useAppLog.setState({ opened: false, autoRefresh: false });
  if (useUi.getState().view === 'applog') replaceView('files');
}
