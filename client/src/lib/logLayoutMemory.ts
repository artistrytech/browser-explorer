/**
 * ログタブの分割レイアウト (方向・各ペインのサイズ) を localStorage に保持する。
 * サイズは % で保持し、リポジトリを跨いで共通 (表示の好みであってリポジトリ固有ではないため)。
 * 表示の好みはウィンドウ単位ではないので、localStorage にしてブラウザの別タブ・
 * 再起動後にも同じ分割方向で開くようにしている。
 */

/** localStorage のキー (別タブの変更を storage イベントで拾うため公開する) */
export const LOG_LAYOUT_KEY = 'git:log:layout';
const KEY = LOG_LAYOUT_KEY;

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
    // 旧版は sessionStorage に保存していたので、残っていれば引き継ぐ
    const raw = localStorage.getItem(KEY) ?? sessionStorage.getItem(KEY);
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
    localStorage.setItem(KEY, JSON.stringify(layout));
    sessionStorage.removeItem(KEY); // 旧版の残骸を残さない
  } catch {
    /* storage full 等は無視 */
  }
}
