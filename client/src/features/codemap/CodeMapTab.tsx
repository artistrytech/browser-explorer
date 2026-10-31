import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../../api/client';
import { useContextMenu, type MenuItem } from '../../components/ContextMenu';
import { useEditor } from '../../stores/editor';
import { useSettings } from '../../stores/settings';
import { useToast, toastError } from '../../stores/toast';
import { openSettingsTab } from '../../stores/ui';
import { copyText } from '../../lib/clipboard';
import { baseName } from '../../lib/paths';
import type { AiAgent, CodeItem, CodeRange, CodeRelation } from '../../types';
import {
  isLeftRelation,
  isTypeKind,
  leftRelation,
  LSP_UNAVAILABLE_CODES,
  RELATION_LABELS,
  useCodeMap,
  type MapEdge,
  type MapNode,
  type Provider,
} from './codeMapStore';
import { layoutGraph, nodeWidth, NODE_HEIGHT } from './layout';
import styles from './CodeMap.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * コードマップのタブ。起点のシンボルを中心に、参照元を左・参照先を右に並べたグラフを描く。
 * - ノードの ◀ / ▶ で参照元 / 参照先を 1 段ずつ展開 (もう一度押すと畳む)。ダブルクリックで定義を開く
 * - エッジのクリックで呼び出し / 参照している箇所を開く (複数あるときは右クリックで選ぶ)
 * - 右クリックで展開する関係 (呼び出し元・参照元・型階層など) を選べる
 */

/** SymbolKind → 表示 (短い記号 / 名前) */
const KINDS: Record<number, [string, string]> = {
  1: ['F', 'ファイル'],
  2: ['Mod', 'モジュール'],
  3: ['NS', '名前空間'],
  4: ['Pkg', 'パッケージ'],
  5: ['C', 'クラス'],
  6: ['M', 'メソッド'],
  7: ['P', 'プロパティ'],
  8: ['F', 'フィールド'],
  9: ['new', 'コンストラクタ'],
  10: ['E', '列挙型'],
  11: ['I', 'インターフェイス'],
  12: ['ƒ', '関数'],
  13: ['v', '変数'],
  14: ['c', '定数'],
  22: ['e', '列挙子'],
  23: ['S', '構造体'],
  24: ['ev', 'イベント'],
  25: ['op', '演算子'],
  26: ['T', '型パラメータ'],
};

const kindOf = (kind: number) => KINDS[kind] ?? ['?', 'シンボル'];

/** 種類ごとの色分け (CSS のクラス) */
function kindClass(kind: number): string {
  if (isTypeKind(kind)) return 'kind-type';
  if (kind === 6 || kind === 9 || kind === 12) return 'kind-fn';
  if (kind === 7 || kind === 8 || kind === 13 || kind === 14 || kind === 22) return 'kind-var';
  return 'kind-other';
}

/** ミニマップのノードの色 (ノードの左端の色と同じ系統。起点は強調) */
function miniMapColor(n: Node): string {
  const data = n.data as SymbolNodeData;
  if (data.isRoot) return '#0067c0';
  const k = kindClass(data.node.item.kind);
  return k === 'kind-fn' ? '#8a5cd0' : k === 'kind-type' ? '#d08a1e' : k === 'kind-var' ? '#2b8fd6' : '#999';
}

const isFilePath = (p: string) => p.startsWith('/') || /^[A-Za-z]:\//.test(p);

/** ルートからの相対パス (外なら末尾の 2 階層) */
function displayPath(p: string, root: string | undefined): string {
  if (!isFilePath(p)) return p;
  const fold = (v: string) => (/^[A-Za-z]:/.test(v) ? v.toLowerCase() : v);
  const prefix = root ? (root.endsWith('/') ? root : `${root}/`) : null;
  if (prefix && fold(p).startsWith(fold(prefix))) return p.slice(prefix.length);
  return p.split('/').slice(-2).join('/');
}

const location = (item: CodeItem, root?: string) => `${displayPath(item.path, root)}:${item.selectionRange.start.line + 1}`;

function openAt(path: string, range: CodeRange): void {
  if (!isFilePath(path)) {
    useToast.getState().show('info', `ファイルとして開けない場所です: ${path}`);
    return;
  }
  void useEditor.getState().openAt(path, range.start.line + 1, range.start.character + 1);
}

async function copyWithToast(text: string, message: string): Promise<void> {
  try {
    await copyText(text);
    useToast.getState().show('success', message);
  } catch (e) {
    toastError(e);
  }
}

// --- ノード ---

interface SymbolNodeData extends Record<string, unknown> {
  node: MapNode;
  sub: string;
  isRoot: boolean;
  /** 調べている関係 */
  pending: CodeRelation[];
  provider: Provider;
  width: number;
}

type SymbolFlowNode = Node<SymbolNodeData, 'symbol'>;

function toggle(node: MapNode, relation: CodeRelation): void {
  const s = useCodeMap.getState();
  if (node.expanded[relation]) s.collapse(node.id, relation);
  else void s.expand(node.id, relation);
}

const SymbolNode = memo(function SymbolNode({ data, selected }: NodeProps<SymbolFlowNode>) {
  const { node, sub, isRoot, pending, provider, width } = data;
  const item = node.item;
  const [badge, kindName] = kindOf(item.kind);
  const sideButton = (side: 'left' | 'right') => {
    const relation = side === 'left' ? leftRelation(item, provider) : 'callees';
    const open = node.expanded[relation];
    const busy = pending.some((r) => isLeftRelation(r) === (side === 'left'));
    const label = RELATION_LABELS[relation];
    return (
      <button
        className={cx(`node-expand ${side}${open ? ' open' : ''}${busy ? ' busy' : ''} nodrag`)}
        title={busy ? '調べています…' : open ? `${label}を畳む` : `${label}を展開`}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          toggle(node, relation);
        }}
      >
        {busy ? '…' : side === 'left' ? (open ? '▷' : '◀') : open ? '◁' : '▶'}
      </button>
    );
  };
  return (
    <div
      className={cx(
        `symbol-node ${kindClass(item.kind)}${isRoot ? ' root' : ''}${selected ? ' selected' : ''}${item.external ? ' external' : ''}`,
      )}
      style={{ width, height: NODE_HEIGHT }}
      title={`${kindName} ${item.name}${item.detail ? `\n${item.detail}` : ''}\n${item.path}:${item.selectionRange.start.line + 1}\nダブルクリックで定義を開く`}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className={cx('node-handle')} />
      {sideButton('left')}
      <div className={cx('node-body')}>
        <div className={cx('node-title')}>
          <span className={cx('node-kind')}>{badge}</span>
          <span className={cx('node-name')}>{item.name}</span>
        </div>
        <div className={cx('node-sub')}>{sub}</div>
      </div>
      {sideButton('right')}
      <Handle type="source" position={Position.Right} isConnectable={false} className={cx('node-handle')} />
    </div>
  );
});

const nodeTypes = { symbol: SymbolNode };

// --- Mermaid への書き出し ---

function toMermaid(nodes: MapNode[], edges: MapEdge[], root: string | undefined): string {
  const ids = new Map(nodes.map((n, i) => [n.id, `n${i}`]));
  const esc = (s: string) => s.replace(/"/g, '#quot;');
  const lines = ['flowchart LR'];
  for (const n of nodes) {
    lines.push(`  ${ids.get(n.id)}["${esc(n.item.name)}<br/><small>${esc(location(n.item, root))}</small>"]`);
  }
  const arrow: Record<MapEdge['kind'], string> = { call: '-->', ref: '-.->', type: '==>' };
  for (const e of edges) {
    const label = e.sites.length > 1 ? `|×${e.sites.length}|` : '';
    lines.push(`  ${ids.get(e.from)} ${arrow[e.kind]}${label} ${ids.get(e.to)}`);
  }
  return lines.join('\n');
}

// --- 本体 ---

function CodeMapView() {
  const {
    origin,
    session,
    nodes,
    edges,
    rootId,
    pending,
    loading,
    error,
    notices,
    showExternal,
    focusId,
  } = useCodeMap();
  const theme = useSettings((s) => s.settings.theme);
  const flow = useReactFlow();
  const [agents, setAgents] = useState<Record<AiAgent, boolean>>({ claude: false, codex: false });
  /** ドラッグで動かしたノードの位置 (グラフの形が変わったら自動配置に戻す) */
  const [manual, setManual] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const provider: Provider = session?.provider ?? 'lsp';

  useEffect(() => {
    api
      .aiAgents()
      .then((r) => setAgents({ claude: r.agents.claude.available, codex: r.agents.codex.available }))
      .catch(() => {});
  }, []);

  const visibleNodes = useMemo(
    () => Object.values(nodes).filter((n) => showExternal || !n.item.external || n.id === rootId),
    [nodes, showExternal, rootId],
  );
  const visibleEdges = useMemo(() => {
    const ids = new Set(visibleNodes.map((n) => n.id));
    return Object.values(edges).filter((e) => ids.has(e.from) && ids.has(e.to));
  }, [edges, visibleNodes]);
  const hiddenCount = Object.keys(nodes).length - visibleNodes.length;

  const subOf = (n: MapNode) => {
    const loc = location(n.item, session?.root);
    return n.item.detail ? `${n.item.detail} · ${loc}` : loc;
  };

  /** グラフの形 (ノードとエッジの組) が変わったときだけ配置し直す */
  const structureKey = `${visibleNodes.map((n) => n.id).join('\n')}\n--\n${visibleEdges.map((e) => e.id).join('\n')}`;
  const positions = useMemo(
    () =>
      layoutGraph(
        visibleNodes.map((n) => ({ id: n.id, width: nodeWidth(n.item.name, subOf(n)) })),
        visibleEdges,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structureKey],
  );
  useEffect(() => setManual(new Map()), [structureKey]);

  const rfNodes: SymbolFlowNode[] = visibleNodes.map((n) => {
    const sub = subOf(n);
    const width = nodeWidth(n.item.name, sub);
    return {
      id: n.id,
      type: 'symbol',
      position: manual.get(n.id) ?? positions.get(n.id) ?? { x: 0, y: 0 },
      // 大きさは決めて渡す (測った寸法を onNodesChange で戻さなくても、ミニマップ・全体表示が使える)
      width,
      height: NODE_HEIGHT,
      selected: n.id === selectedId,
      data: {
        node: n,
        sub,
        isRoot: n.id === rootId,
        pending: pending[n.id] ?? [],
        provider,
        width,
      },
    };
  });

  const rfEdges: Edge[] = visibleEdges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    label: e.sites.length > 1 ? `×${e.sites.length}` : undefined,
    className: cx(`edge-${e.kind}`),
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    interactionWidth: 14,
  }));

  // 展開したら、小さいグラフは全体を、大きいグラフは展開したノードを中心に表示する
  const firstFit = useRef(true);
  useEffect(() => {
    if (!visibleNodes.length) {
      firstFit.current = true;
      return;
    }
    const id = requestAnimationFrame(() => {
      const focus = focusId ? positions.get(focusId) : undefined;
      if (firstFit.current || visibleNodes.length <= 24 || !focus) {
        void flow.fitView({ padding: 0.15, duration: firstFit.current ? 0 : 250, maxZoom: 1.1 });
      } else {
        void flow.setCenter(focus.x + 120, focus.y + NODE_HEIGHT / 2, { zoom: flow.getZoom(), duration: 250 });
      }
      firstFit.current = false;
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  const onNodesChange = (changes: NodeChange<SymbolFlowNode>[]) => {
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        const pos = c.position;
        setManual((m) => new Map(m).set(c.id, pos));
      } else if (c.type === 'select') {
        setSelectedId((cur) => (c.selected ? c.id : cur === c.id ? null : cur));
      }
    }
  };

  const nodeMenu = (e: React.MouseEvent, n: MapNode) => {
    e.preventDefault();
    const s = useCodeMap.getState();
    const relationItem = (relation: CodeRelation): MenuItem => ({
      label: `${RELATION_LABELS[relation]}を${n.expanded[relation] ? '畳む' : '展開'}`,
      disabled: pending[n.id]?.includes(relation),
      action: () => toggle(n, relation),
    });
    const relations: CodeRelation[] =
      provider === 'ai' ? ['callers', 'callees'] : ['callers', 'callees', 'references', 'supertypes', 'subtypes'];
    const items: MenuItem[] = [
      ...relations.map(relationItem),
      { separator: true },
      { label: '定義を開く', action: () => openAt(n.item.path, n.item.selectionRange) },
      {
        label: 'このシンボルを起点に作り直す',
        disabled: n.id === rootId || !isFilePath(n.item.path),
        action: () =>
          void s.start(
            { path: n.item.path, position: n.item.selectionRange.start, word: n.item.name },
            provider,
            session?.agent,
          ),
      },
      { label: '名前をコピー', action: () => void copyWithToast(n.item.name, '名前をコピーしました') },
      { label: 'パスをコピー', action: () => void copyWithToast(n.item.path, 'パスをコピーしました') },
      { separator: true },
      { label: 'マップから外す', disabled: n.id === rootId, danger: true, action: () => s.remove(n.id) },
    ];
    useContextMenu.getState().open(e.clientX, e.clientY, items);
  };

  const edgeMenu = (e: React.MouseEvent, edge: MapEdge) => {
    e.preventDefault();
    if (!edge.sites.length) return;
    const lines = edge.sites.slice(0, 30).map<MenuItem>((r) => ({
      label: `${displayPath(edge.sitePath, session?.root)}:${r.start.line + 1}`,
      action: () => openAt(edge.sitePath, r),
    }));
    if (edge.sites.length > 30) lines.push({ label: `ほか ${edge.sites.length - 30} 件`, disabled: true });
    useContextMenu.getState().open(e.clientX, e.clientY, lines);
  };

  const aiMenu = (e: React.MouseEvent) => {
    if (!origin) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const item = (agent: AiAgent, label: string): MenuItem => ({
      label,
      detail: agents[agent] ? undefined : 'PATH に見つかりません',
      disabled: !agents[agent],
      action: () => void useCodeMap.getState().start(origin, 'ai', agent),
    });
    useContextMenu.getState().open(r.left, r.bottom + 2, [item('claude', 'Claude で作成'), item('codex', 'Codex で作成')]);
  };

  const rootNode = rootId ? nodes[rootId] : null;
  const busyAi = provider === 'ai' && Object.keys(pending).length > 0;

  const body = () => {
    if (loading) {
      return (
        <div className={cx('codemap-message')}>
          <div className={cx('codemap-spinner')} />
          {loading === 'ai' ? (
            <>
              <p>AI が解析しています… (数十秒〜数分かかります)</p>
              <button className={cx('btn')} onClick={() => useCodeMap.getState().cancel()}>
                中止
              </button>
            </>
          ) : (
            <p>言語サーバで解析しています… (起動直後はプロジェクトの読み込みに時間がかかります)</p>
          )}
        </div>
      );
    }
    if (error) {
      const unavailable = LSP_UNAVAILABLE_CODES.has(error.code);
      return (
        <div className={cx('codemap-message')}>
          <p className={cx('codemap-error')}>{error.message}</p>
          {unavailable && <p>言語サーバを入れるか、AI でマップを作れます。</p>}
          {origin && (
            <div className={cx('codemap-actions')}>
              {unavailable && (
                <button className={cx('btn')} onClick={() => openSettingsTab('codemap')}>
                  設定を開く
                </button>
              )}
              <button className={cx('btn')} onClick={() => void useCodeMap.getState().start(origin, 'lsp')}>
                言語サーバでやり直す
              </button>
              <button className={cx('btn primary')} disabled={!agents.claude} onClick={() => void useCodeMap.getState().start(origin, 'ai', 'claude')}>
                Claude で作成
              </button>
              <button className={cx('btn')} disabled={!agents.codex} onClick={() => void useCodeMap.getState().start(origin, 'ai', 'codex')}>
                Codex で作成
              </button>
            </div>
          )}
        </div>
      );
    }
    return (
      <ReactFlow<SymbolFlowNode>
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDoubleClick={(_, n) => openAt(n.data.node.item.path, n.data.node.item.selectionRange)}
        onNodeContextMenu={(e, n) => nodeMenu(e, n.data.node)}
        onEdgeClick={(_, e) => {
          const edge = edges[e.id];
          if (edge?.sites[0]) openAt(edge.sitePath, edge.sites[0]);
        }}
        onEdgeContextMenu={(e, ed) => {
          const edge = edges[ed.id];
          if (edge) edgeMenu(e, edge);
        }}
        nodesConnectable={false}
        // ダブルクリックはノードを開く操作に使うので、外れて背景に当たっても拡大しない
        zoomOnDoubleClick={false}
        colorMode={theme === 'dark' ? 'dark' : 'light'}
        minZoom={0.1}
        maxZoom={2.5}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={miniMapColor} nodeBorderRadius={4} />
      </ReactFlow>
    );
  };

  return (
    <div className={cx('codemap')}>
      <div className={cx('codemap-bar')}>
        <span className={cx('codemap-title')} title={rootNode?.item.path}>
          {rootNode ? (
            <>
              <span className={cx('codemap-kind')}>{kindOf(rootNode.item.kind)[1]}</span>
              <b>{rootNode.item.name}</b>
              <span className={cx('codemap-dim')}>{location(rootNode.item, session?.root)}</span>
            </>
          ) : (
            <span className={cx('codemap-dim')}>{origin ? `${baseName(origin.path)}:${origin.position.line + 1}` : ''}</span>
          )}
        </span>
        {session && (
          <span className={cx('codemap-chip')} title={session.root}>
            {session.provider === 'ai' ? `AI: ${session.agent === 'codex' ? 'Codex' : 'Claude'}` : session.serverLabel}
          </span>
        )}
        {busyAi && (
          <button className={cx('btn small')} onClick={() => useCodeMap.getState().cancel()}>
            AI の実行を中止
          </button>
        )}
        <span className={cx('codemap-spacer')} />
        <span className={cx('codemap-legend')}>
          <span className={cx('legend-call')}>呼び出し</span>
          <span className={cx('legend-ref')}>参照</span>
          <span className={cx('legend-type')}>継承</span>
        </span>
        <label className={cx('codemap-check')} title="ライブラリ・標準ライブラリなど、プロジェクトの外のシンボルも表示する">
          <input
            type="checkbox"
            checked={showExternal}
            onChange={(e) => useCodeMap.getState().setShowExternal(e.target.checked)}
          />
          ライブラリも表示{hiddenCount > 0 ? ` (${hiddenCount})` : ''}
        </label>
        <button className={cx('btn small')} title="全体を表示" disabled={!rootNode} onClick={() => void flow.fitView({ padding: 0.15, duration: 250, maxZoom: 1.1 })}>
          全体表示
        </button>
        <button className={cx('btn small')} title="ドラッグで動かしたノードを自動配置に戻す" disabled={!manual.size} onClick={() => setManual(new Map())}>
          整列
        </button>
        <button
          className={cx('btn small')}
          title="表示中のマップを Mermaid の flowchart としてコピー"
          disabled={!rootNode}
          onClick={() => void copyWithToast(toMermaid(visibleNodes, visibleEdges, session?.root), 'Mermaid としてコピーしました')}
        >
          Mermaid をコピー
        </button>
        <button
          className={cx('btn small')}
          title="起点から調べ直す"
          disabled={!origin || loading !== null}
          onClick={() => origin && void useCodeMap.getState().start(origin, provider, session?.agent)}
        >
          作り直す
        </button>
        {provider === 'lsp' && (
          <button className={cx('btn small')} title="言語サーバの代わりに AI (Claude / Codex) で作る" disabled={!origin} onClick={aiMenu}>
            AI で作成 ▾
          </button>
        )}
        {provider === 'ai' && origin && (
          <button className={cx('btn small')} onClick={() => void useCodeMap.getState().start(origin, 'lsp')}>
            言語サーバで作成
          </button>
        )}
      </div>
      {notices.length > 0 && (
        <div className={cx('codemap-notices')}>
          <ul>
            {[...new Set(notices)].map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <button className={cx('btn small')} title="お知らせを消す" onClick={() => useCodeMap.getState().dismissNotices()}>
            ✕
          </button>
        </div>
      )}
      <div className={cx('codemap-body')}>{body()}</div>
    </div>
  );
}

export function CodeMapTab() {
  return (
    <ReactFlowProvider>
      <CodeMapView />
    </ReactFlowProvider>
  );
}
