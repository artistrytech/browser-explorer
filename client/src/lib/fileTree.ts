/**
 * 変更ファイル一覧 (レビュー・コミットのログ・Stash) をツリー表示するためのフォルダ階層。
 * 配下が単一のフォルダだけのフォルダは 1 行にまとめる (VSCode の Compact Folders と同じ: `src/features/review`)
 */

/** 一覧の表示形式 */
export type FileListMode = 'list' | 'tree';

export interface FileTreeDir<T extends { path: string }> {
  /** ルートからのパス (まとめた場合は末尾のフォルダまで)。折り畳み状態のキーにする */
  path: string;
  /** 表示名。まとめた場合は `a/b/c` */
  name: string;
  dirs: FileTreeDir<T>[];
  files: T[];
}

export type FileTreeRow<T extends { path: string }> =
  | { kind: 'dir'; node: FileTreeDir<T>; depth: number }
  | { kind: 'file'; file: T; depth: number };

/** ファイル一覧からフォルダ階層を作る。並びは各フォルダ内でフォルダ → ファイル (それぞれ元の順) */
export function buildFileTree<T extends { path: string }>(files: T[]): FileTreeDir<T> {
  const root: FileTreeDir<T> = { path: '', name: '', dirs: [], files: [] };
  const byPath = new Map<string, FileTreeDir<T>>([['', root]]);
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${part}` : part;
      let child = byPath.get(path);
      if (!child) {
        child = { path, name: part, dirs: [], files: [] };
        byPath.set(path, child);
        node.dirs.push(child);
      }
      node = child;
    }
    node.files.push(f);
  }
  return compact(root);
}

function compact<T extends { path: string }>(node: FileTreeDir<T>): FileTreeDir<T> {
  return {
    ...node,
    dirs: node.dirs.map((d) => {
      let merged = d;
      let name = d.name;
      while (merged.files.length === 0 && merged.dirs.length === 1) {
        merged = merged.dirs[0];
        name = `${name}/${merged.name}`;
      }
      return compact({ ...merged, name });
    }),
  };
}

const NONE: ReadonlySet<string> = new Set();

/** 表示する行。折り畳んだフォルダ (collapsed) の中身は含めない */
export function flattenFileTree<T extends { path: string }>(
  root: FileTreeDir<T>,
  collapsed: ReadonlySet<string> = NONE,
): FileTreeRow<T>[] {
  const rows: FileTreeRow<T>[] = [];
  const walk = (node: FileTreeDir<T>, depth: number) => {
    for (const d of node.dirs) {
      rows.push({ kind: 'dir', node: d, depth });
      if (!collapsed.has(d.path)) walk(d, depth + 1);
    }
    for (const f of node.files) rows.push({ kind: 'file', file: f, depth });
  };
  walk(root, 0);
  return rows;
}

/** ツリーの表示順に並べたファイル (折り畳みは無視) */
export function filesInTreeOrder<T extends { path: string }>(root: FileTreeDir<T>): T[] {
  return flattenFileTree(root).flatMap((r) => (r.kind === 'file' ? [r.file] : []));
}

/** フォルダ配下 (孫以下を含む) のファイル */
export function filesUnder<T extends { path: string }>(node: FileTreeDir<T>): T[] {
  return [...node.dirs.flatMap((d) => filesUnder(d)), ...node.files];
}

/** 折り畳み状態を 1 つ反転した集合を返す */
export function toggleCollapsed(collapsed: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(collapsed);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/** 表示形式を localStorage から読む (画面ごとのキー)。次に開いたときも引き継ぐ */
export function loadFileListMode(key: string): FileListMode {
  try {
    return localStorage.getItem(key) === 'tree' ? 'tree' : 'list';
  } catch {
    return 'list';
  }
}

export function saveFileListMode(key: string, mode: FileListMode): void {
  try {
    localStorage.setItem(key, mode);
  } catch {
    /* 無視 */
  }
}
