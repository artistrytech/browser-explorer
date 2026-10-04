/**
 * バックアップブランチの名前パターン。
 * 正規表現として扱い、yyyy / mm / dd は日付 (数字) のプレースホルダ。
 * ローカルブランチのうち、名前全体がこのパターンに一致するものをバックアップとみなす。
 */
export const DEFAULT_BACKUP_BRANCH_PATTERN = 'backup/yyyy/mm/dd-.*';

const DATE_TOKEN = /yyyy|mm|dd/g;
/** 作成時の既定名で、現在のブランチ名の末尾に置き換える部分 */
const WILDCARD = /\.[*+]/;

/** パターンを判定用の正規表現にする。空欄や不正な正規表現なら null (バックアップ扱いのブランチ無し) */
export function backupBranchRegex(pattern: string): RegExp | null {
  const p = pattern.trim();
  if (!p) return null;
  try {
    return new RegExp(`^(?:${p.replace(DATE_TOKEN, (t) => (t === 'yyyy' ? '\\d{4}' : '\\d{2}'))})$`);
  } catch {
    return null;
  }
}

/**
 * 作成時の既定名。日付を埋め、最初の `.*` (`.+`) をブランチ名のスラッシュ区切りの末尾に置き換える。
 * 例: backup/yyyy/mm/dd-.* + feature/login → backup/2026/10/04-login
 * パターンが空欄なら既定のパターンで組み立てる (名前が空にならないように)。
 */
export function defaultBackupBranchName(pattern: string, branch: string, date = new Date()): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const values: Record<string, string> = {
    yyyy: String(date.getFullYear()),
    mm: p2(date.getMonth() + 1),
    dd: p2(date.getDate()),
  };
  // \. などのエスケープは文字そのものに戻し、残った正規表現の記号は名前に使えないので落とす
  const literal = (s: string) =>
    s.replace(DATE_TOKEN, (t) => values[t]).replace(/\\(.)|\.[*+?]|[\^$()[\]{}|]/g, (_, esc?: string) => esc ?? '');
  const tail = branch.split('/').filter(Boolean).pop() ?? '';
  const p = pattern.trim() || DEFAULT_BACKUP_BRANCH_PATTERN;
  const m = WILDCARD.exec(p);
  return m ? literal(p.slice(0, m.index)) + tail + literal(p.slice(m.index + m[0].length)) : literal(p);
}
