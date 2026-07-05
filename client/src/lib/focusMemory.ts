/**
 * Explorer のフォーカス/選択位置を sessionStorage に保持する (002.md §6)。
 * - リロード・ブラウザバック/フォワードでは維持、タブを閉じると破棄。
 * - キーはタブ内で最大 MAX_KEYS 件、ts の古い順に間引く。
 */

const PREFIX = 'exp:focus:';
const MAX_KEYS = 200;

export interface FocusRecord {
  /** フォーカス項目の名前 (カレントフォルダ内で一意) */
  focused: string | null;
  /** 項目消失時のフォールバック用 index */
  focusedIndex: number;
  /** 選択項目の名前一覧 */
  selected: string[];
  scrollTop: number;
  ts: number;
}

export function saveFocus(path: string, rec: Omit<FocusRecord, 'ts'>): void {
  try {
    sessionStorage.setItem(PREFIX + path, JSON.stringify({ ...rec, ts: Date.now() }));
    prune();
  } catch {
    /* storage full 等は無視 */
  }
}

export function loadFocus(path: string): FocusRecord | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + path);
    return raw ? (JSON.parse(raw) as FocusRecord) : null;
  } catch {
    return null;
  }
}

/**
 * サブフォルダへ入る直前に「今入った子項目」を親パスの focus として保存する (§6.3)。
 * → 戻った時、さっき入った子フォルダがハイライトされる (Windows Explorer 挙動)。
 */
export function saveEnteredChild(parentPath: string, childName: string, index: number): void {
  const prev = loadFocus(parentPath);
  saveFocus(parentPath, {
    focused: childName,
    focusedIndex: index,
    selected: [childName],
    scrollTop: prev?.scrollTop ?? 0,
  });
}

function prune(): void {
  const keys: { key: string; ts: number }[] = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    try {
      const rec = JSON.parse(sessionStorage.getItem(key) ?? '{}') as FocusRecord;
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
