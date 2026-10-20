/**
 * 最後に使ったテーマ (設定の theme) の控え。
 * 設定は API から読み込むので、読み込みが終わるまでの間にライトテーマで描画されて
 * 白くちらつく (特にアプリ内タブを開いた直後) のを防ぐため、localStorage に控えておき起動直後に使う。
 * index.html / tabs.html の先頭のインラインスクリプトも同じキーを読む (CSS の適用前に data-theme を付けるため)
 */

export type Theme = 'light' | 'dark';

const KEY = 'app:theme';

export function loadCachedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function saveCachedTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* ignore */
  }
}
