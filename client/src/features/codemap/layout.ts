import { Graph, layout } from '@dagrejs/dagre';

/**
 * コードマップの自動配置 (dagre の左 → 右の階層配置)。
 * エッジは「使う側 → 使われる側」なので、参照元が左、参照先が右に並ぶ。
 */

export const NODE_HEIGHT = 50;
const NODE_MIN_WIDTH = 150;
const NODE_MAX_WIDTH = 340;

/** 名前と補足の文字数からノードの幅を見積もる (全角は 2 文字分) */
export function nodeWidth(name: string, sub: string): number {
  const units = (s: string) => [...s].reduce((n, c) => n + (c.charCodeAt(0) > 0xff ? 2 : 1), 0);
  const w = Math.max(units(name) * 7.6 + 76, units(sub) * 6.2 + 40);
  return Math.round(Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, w)));
}

/** ノードの左上の座標 (React Flow の position) を返す */
export function layoutGraph(
  nodes: { id: string; width: number }[],
  edges: { from: string; to: string }[],
): Map<string, { x: number; y: number }> {
  const g = new Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 18, ranksep: 90, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: n.width, height: NODE_HEIGHT });
  for (const e of edges) if (e.from !== e.to) g.setEdge(e.from, e.to);
  layout(g);
  const out = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const p = g.node(n.id);
    out.set(n.id, { x: p.x - n.width / 2, y: p.y - NODE_HEIGHT / 2 });
  }
  return out;
}
