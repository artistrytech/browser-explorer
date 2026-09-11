/**
 * Markdown プレビューのスクロール位置を sessionStorage に保持する (ファイルパスごと)。
 * プレビュータブは非表示時にアンマウントされるため、別タブから戻った際や
 * 同じファイルを再度開いた際にここから復元する。リロード・ブラウザバックでも維持、タブを閉じると破棄。
 * キーはタブ内で最大 MAX_KEYS 件、ts の古い順に間引く。
 */

const PREFIX = 'preview:scroll:';
const MAX_KEYS = 200;

interface ScrollRecord {
  scrollTop: number;
  ts: number;
}

export function savePreviewScroll(path: string, scrollTop: number): void {
  try {
    sessionStorage.setItem(PREFIX + path, JSON.stringify({ scrollTop, ts: Date.now() }));
    prune();
  } catch {
    /* storage full 等は無視 */
  }
}

export function loadPreviewScroll(path: string): number | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + path);
    if (!raw) return null;
    const rec = JSON.parse(raw) as ScrollRecord;
    return typeof rec.scrollTop === 'number' ? rec.scrollTop : null;
  } catch {
    return null;
  }
}

function prune(): void {
  const keys: { key: string; ts: number }[] = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    try {
      const rec = JSON.parse(sessionStorage.getItem(key) ?? '{}') as ScrollRecord;
      keys.push({ key, ts: rec.ts ?? 0 });
    } catch {
      keys.push({ key, ts: 0 });
    }
  }
  if (keys.length <= MAX_KEYS) return;
  keys.sort((a, b) => a.ts - b.ts);
  for (const { key } of keys.slice(0, keys.length - MAX_KEYS)) {
    sessionStorage.removeItem(key);
  }
}
