/**
 * サイドバーの各セクション (クイックアクセス / 場所 / リポジトリ) の折り畳み状態と表示モードを localStorage に保持する。
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

/** サイドバーの表示モード。places = 通常 (クイックアクセス / リポジトリ / 場所)、project = プロジェクトツリー */
export type SidebarMode = 'places' | 'project';

const MODE_KEY = 'sidebar:mode';

export function loadSidebarMode(): SidebarMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'project' ? 'project' : 'places';
  } catch {
    return 'places';
  }
}

export function saveSidebarMode(mode: SidebarMode): void {
  try {
    if (mode === 'places') localStorage.removeItem(MODE_KEY);
    else localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* storage full 等は無視 */
  }
}

/**
 * プロジェクトツリーで展開中のフォルダ (リポジトリ相対パス)。
 * 作業中の状態なのでウィンドウ単位 (sessionStorage) で、リポジトリごとに保持する。
 */
function expandedKey(repoRoot: string): string {
  return `projectTree:expanded:${repoRoot}`;
}

export function loadProjectExpanded(repoRoot: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(expandedKey(repoRoot));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveProjectExpanded(repoRoot: string, rels: Set<string>): void {
  try {
    if (rels.size === 0) sessionStorage.removeItem(expandedKey(repoRoot));
    else sessionStorage.setItem(expandedKey(repoRoot), JSON.stringify([...rels]));
  } catch {
    /* storage full 等は無視 */
  }
}
