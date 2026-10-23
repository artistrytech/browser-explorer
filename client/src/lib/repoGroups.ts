/**
 * 登録リポジトリのグループ分け。アプリ内タブ (tabs.html のシェル) のタブをリポジトリごとに見分けるために使う。
 * - グループ: 名前 (管理用。ダイアログでのみ表示) と色を持つ
 * - リポジトリ: 所属グループと短縮名 (タブの左端のチップに出す)。どのグループにも属さないものは未分類
 *
 * 保存先は状態 (settings テーブル) の `repoGroups` キー。アプリの設定 (`app`) とは別のキーにして、
 * 他のタブが古い設定をまとめて書き戻しても消えないようにする。
 * 変更はタブ間 (シェル・各タブ) へ BroadcastChannel で配る。
 */

export interface RepoGroup {
  id: string;
  /** 管理用の名前 (エクスプローラ上には出さない) */
  name: string;
  /** #rrggbb */
  color: string;
}

export interface RepoGroupMember {
  /** 所属グループの id */
  group: string;
  /** タブに出す短縮名 (空ならチップを出さない) */
  short: string;
}

export interface RepoGroupSettings {
  groups: RepoGroup[];
  /** リポジトリのパス → 所属。キーが無いリポジトリは未分類 */
  repos: Record<string, RepoGroupMember>;
}

/** 状態 (settings テーブル) のキー */
export const REPO_GROUPS_KEY = 'repoGroups';

export const EMPTY_REPO_GROUPS: RepoGroupSettings = { groups: [], repos: {} };

/**
 * グループの色の候補。色相の離れた順に並べ、グループを追加したときは未使用のものを先頭から割り当てる。
 * ライト / ダークのどちらの背景に混ぜても見分けやすい中程度の明るさにしている
 */
export const REPO_GROUP_COLORS: { color: string; name: string }[] = [
  { color: '#3b82f6', name: '青' },
  { color: '#ef4444', name: '赤' },
  { color: '#22a55a', name: '緑' },
  { color: '#f59e0b', name: '橙' },
  { color: '#a855f7', name: '紫' },
  { color: '#06b6d4', name: '水色' },
  { color: '#ec4899', name: '桃' },
  { color: '#84cc16', name: '黄緑' },
  { color: '#8b6b4a', name: '茶' },
  { color: '#64748b', name: '灰' },
];

/** 追加するグループの色: 使われていない候補の先頭。すべて使用中なら数で巡回する */
export function nextGroupColor(groups: readonly RepoGroup[]): string {
  const used = new Set(groups.map((g) => g.color.toLowerCase()));
  const free = REPO_GROUP_COLORS.find((c) => !used.has(c.color));
  return (free ?? REPO_GROUP_COLORS[groups.length % REPO_GROUP_COLORS.length]).color;
}

export function newGroupId(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** 保存値を検証して整える (壊れた値・存在しないグループへの所属は捨てる) */
export function normalizeRepoGroups(value: unknown): RepoGroupSettings {
  if (!value || typeof value !== 'object') return EMPTY_REPO_GROUPS;
  const v = value as Partial<RepoGroupSettings>;
  const groups = (Array.isArray(v.groups) ? v.groups : [])
    .filter((g): g is RepoGroup => !!g && typeof g.id === 'string' && typeof g.name === 'string')
    .map((g) => ({ id: g.id, name: g.name, color: HEX_COLOR.test(g.color) ? g.color : nextGroupColor([]) }));
  const ids = new Set(groups.map((g) => g.id));
  const repos: Record<string, RepoGroupMember> = {};
  for (const [path, m] of Object.entries(v.repos && typeof v.repos === 'object' ? v.repos : {})) {
    if (m && typeof m.group === 'string' && ids.has(m.group)) {
      repos[path] = { group: m.group, short: typeof m.short === 'string' ? m.short : '' };
    }
  }
  return { groups, repos };
}

/** パスの比較用キー (Windows のドライブパスは大文字小文字を区別しない。末尾の / は無視) */
function pathKey(p: string): string {
  const s = p.replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s;
}

/** タブに付ける目印 (グループの色と短縮名) */
export interface RepoBadge {
  color: string;
  short: string;
}

/** リポジトリ (ルートのパス) の目印。未分類・未登録なら null */
export function repoBadgeOf(settings: RepoGroupSettings, repo: string | null): RepoBadge | null {
  if (!repo) return null;
  const key = pathKey(repo);
  const entry = Object.entries(settings.repos).find(([p]) => pathKey(p) === key)?.[1];
  const group = entry && settings.groups.find((g) => g.id === entry.group);
  return group ? { color: group.color, short: entry.short } : null;
}

/** 色の上に載せる文字色 (白 / 黒の読みやすい方) */
export function textColorOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  // 白との対比 (1.05 / (l + 0.05)) と黒との対比 ((l + 0.05) / 0.05) の大きい方
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? '#fff' : '#111';
}

const CHANNEL_NAME = 'eb-repo-groups';

/** 変更を他のタブ・シェルへ知らせる (自分自身には届かない) */
export function broadcastRepoGroups(settings: RepoGroupSettings): void {
  try {
    const ch = new BroadcastChannel(CHANNEL_NAME);
    ch.postMessage(settings);
    ch.close();
  } catch {
    /* BroadcastChannel が使えない環境では次の読み込みで反映される */
  }
}

/** 他のタブ・シェルでの変更を受け取る */
export function onRepoGroupsChanged(cb: (settings: RepoGroupSettings) => void): () => void {
  try {
    const ch = new BroadcastChannel(CHANNEL_NAME);
    ch.onmessage = (e: MessageEvent) => cb(normalizeRepoGroups(e.data));
    return () => ch.close();
  } catch {
    return () => {};
  }
}
