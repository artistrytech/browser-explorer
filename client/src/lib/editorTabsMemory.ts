/**
 * エディタで開いているファイル (タブの並びと表示中のファイル) を sessionStorage に保持する。
 * 画面を読み込み直したときにここから開き直す。内容はファイルから読み直すので、未保存の編集は引き継がない。
 * リロード・ブラウザバックでも維持、タブを閉じると破棄。
 */

import { tabSession } from './appTabs';

/** 別タブへは引き継がない (lib/appTabs.ts の NOT_INHERITED) */
const EDITOR_TABS_KEY = 'editor:tabs';

export interface EditorTabsRecord {
  paths: string[];
  active: string | null;
}

export function saveEditorTabs(rec: EditorTabsRecord): void {
  try {
    if (rec.paths.length === 0) tabSession.removeItem(EDITOR_TABS_KEY);
    else tabSession.setItem(EDITOR_TABS_KEY, JSON.stringify(rec));
  } catch {
    /* storage full 等は無視 */
  }
}

export function loadEditorTabs(): EditorTabsRecord | null {
  try {
    const raw = tabSession.getItem(EDITOR_TABS_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as Partial<EditorTabsRecord>;
    const paths = Array.isArray(rec.paths) ? rec.paths.filter((p): p is string => typeof p === 'string') : [];
    if (paths.length === 0) return null;
    return { paths, active: typeof rec.active === 'string' ? rec.active : null };
  } catch {
    return null;
  }
}
