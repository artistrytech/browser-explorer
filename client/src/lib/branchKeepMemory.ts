/**
 * ブランチの「常に除外」設定 (一括削除の対象から常に外すブランチ) を localStorage に保持する。
 * 残しておきたいブランチはウィンドウ単位の状態ではないので sessionStorage ではなく
 * localStorage に置き、ブラウザの別タブ・再起動後も引き継ぐ。リポジトリごとに別枠。
 */

const PREFIX = 'git:branch:keep:';

export function loadBranchKeep(repo: string): Set<string> {
  try {
    const raw = localStorage.getItem(PREFIX + repo);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveBranchKeep(repo: string, names: Set<string>): void {
  try {
    if (names.size === 0) localStorage.removeItem(PREFIX + repo);
    else localStorage.setItem(PREFIX + repo, JSON.stringify([...names]));
  } catch {
    /* storage full 等は無視 */
  }
}
