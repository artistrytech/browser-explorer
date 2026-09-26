/**
 * サイドバーの各セクション (クイックアクセス / 場所 / リポジトリ) の折り畳み状態を localStorage に保持する。
 * 表示の好みなのでウィンドウ単位ではなく、ブラウザの別タブ・再起動後も引き継ぐ。
 */

const KEY = 'sidebar:collapsed';

export function loadCollapsedSections(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsedSections(ids: Set<string>): void {
  try {
    if (ids.size === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    /* storage full 等は無視 */
  }
}
