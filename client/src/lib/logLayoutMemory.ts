/**
 * ログタブの分割レイアウト (方向・各ペインのサイズ) を sessionStorage に保持する。
 * サイズは % で保持し、リポジトリを跨いで共通 (表示の好みであってリポジトリ固有ではないため)。
 */

const KEY = 'git:log:layout';

/** 'horizontal' = 左右分割 (左: グラフ)、'vertical' = 上下分割 (上: グラフ) */
export type LogLayoutDir = 'horizontal' | 'vertical';

/** main = グラフ側ペイン、detail = コミット詳細 (ファイル一覧) 側ペインの % */
export interface LogPaneSizes {
  main: number;
  detail: number;
}

export interface LogLayoutRecord {
  dir: LogLayoutDir;
  /** 方向ごとに別枠で保持する (左右と上下では自然な比率が異なるため) */
  sizes: Record<LogLayoutDir, LogPaneSizes>;
}

export const defaultLogLayout: LogLayoutRecord = {
  dir: 'horizontal',
  sizes: {
    horizontal: { main: 44, detail: 55 },
    vertical: { main: 50, detail: 55 },
  },
};

const clampPct = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 100 ? v : fallback;

export function loadLogLayout(): LogLayoutRecord {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return defaultLogLayout;
    const parsed = JSON.parse(raw) as Partial<LogLayoutRecord>;
    const dir: LogLayoutDir = parsed.dir === 'vertical' ? 'vertical' : 'horizontal';
    const size = (d: LogLayoutDir): LogPaneSizes => ({
      main: clampPct(parsed.sizes?.[d]?.main, defaultLogLayout.sizes[d].main),
      detail: clampPct(parsed.sizes?.[d]?.detail, defaultLogLayout.sizes[d].detail),
    });
    return { dir, sizes: { horizontal: size('horizontal'), vertical: size('vertical') } };
  } catch {
    return defaultLogLayout;
  }
}

export function saveLogLayout(layout: LogLayoutRecord): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    /* storage full 等は無視 */
  }
}
