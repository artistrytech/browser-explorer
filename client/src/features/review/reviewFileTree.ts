/**
 * レビュー詳細のファイル一覧をツリー表示するためのフォルダ階層。
 * 配下が単一のフォルダだけのフォルダは 1 行にまとめる (VSCode の Compact Folders と同じ: `src/features/review`)
 */

import type { CommitFile } from '../../types';

export interface ReviewDirNode {
  /** ルートからのパス (まとめた場合は末尾のフォルダまで)。折り畳み状態のキーにする */
  path: string;
  /** 表示名。まとめた場合は `a/b/c` */
  name: string;
  dirs: ReviewDirNode[];
  files: CommitFile[];
}

export type ReviewTreeRow =
  | { kind: 'dir'; node: ReviewDirNode; depth: number }
  | { kind: 'file'; file: CommitFile; depth: number };

/** ファイル一覧からフォルダ階層を作る。並びは各フォルダ内でフォルダ → ファイル (それぞれ元の順) */
export function buildReviewFileTree(files: CommitFile[]): ReviewDirNode {
  const root: ReviewDirNode = { path: '', name: '', dirs: [], files: [] };
  const byPath = new Map<string, ReviewDirNode>([['', root]]);
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

function compact(node: ReviewDirNode): ReviewDirNode {
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

/** 表示する行。折り畳んだフォルダの中身は含めない */
export function flattenReviewFileTree(root: ReviewDirNode, collapsed: ReadonlySet<string>): ReviewTreeRow[] {
  const rows: ReviewTreeRow[] = [];
  const walk = (node: ReviewDirNode, depth: number) => {
    for (const d of node.dirs) {
      rows.push({ kind: 'dir', node: d, depth });
      if (!collapsed.has(d.path)) walk(d, depth + 1);
    }
    for (const f of node.files) rows.push({ kind: 'file', file: f, depth });
  };
  walk(root, 0);
  return rows;
}

/** フォルダ配下 (孫以下を含む) のファイル */
export function filesUnder(node: ReviewDirNode): CommitFile[] {
  return [...node.dirs.flatMap(filesUnder), ...node.files];
}
