import { create } from 'zustand';
import { api, ApiError } from '../../api/client';
import { switchView, replaceView, useUi } from '../../stores/ui';
import { toastError } from '../../stores/toast';
import type { AiAgent, CodeItem, CodeLink, CodePos, CodeRange, CodeRelation } from '../../types';

/**
 * コードマップ: 選んだクラス・メソッド等を中心に、参照元 (左) と参照先 (右) をたどるグラフ。
 * 調べ方は 2 通り: 言語サーバ (LSP。サーバ側で起動して問い合わせる) / AI (claude・codex に JSON で答えさせる)。
 * 対象は 1 つ (別のシンボルで開くと差し替わる)。ノードはボタン・右クリックで 1 段ずつ展開する。
 *
 * エッジの向きは「使う側 → 使われる側」で揃える (呼び出し元 → 呼び出し先、参照元 → 参照先、子の型 → 親の型)。
 * 左右に並べるとき (layout.ts) 使う側が左に来る。
 */

export type Provider = 'lsp' | 'ai';
export type EdgeKind = 'call' | 'ref' | 'type';

export interface MapNode {
  id: string;
  item: CodeItem;
  /** 展開済みの関係 */
  expanded: Partial<Record<CodeRelation, true>>;
}

export interface MapEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  /** 呼び出し / 参照している箇所 (sitePath のファイル内) */
  sitePath: string;
  sites: CodeRange[];
  /** このエッジを出した展開 ("ノード id|関係")。折り畳みで全部消えたらエッジも消す */
  owners: string[];
}

export interface CodeMapOrigin {
  path: string;
  position: CodePos;
  /** カーソル位置の単語 (AI への手掛かり) */
  word: string;
  /** エディタで編集中の内容 (未保存でも位置が合うように) */
  content?: string;
}

export interface CodeMapSession {
  provider: Provider;
  root: string;
  serverId?: string;
  serverLabel?: string;
  agent?: AiAgent;
}

interface CodeMapStore {
  origin: CodeMapOrigin | null;
  session: CodeMapSession | null;
  nodes: Record<string, MapNode>;
  edges: Record<string, MapEdge>;
  rootId: string | null;
  /** 展開中のノード (id → 調べている関係) */
  pending: Record<string, CodeRelation[]>;
  /** 起点を調べている (言語サーバの起動・AI の解析) */
  loading: Provider | null;
  error: { message: string; code: string } | null;
  notices: string[];
  /** ライブラリ等 (プロジェクトの外) のノードも出すか */
  showExternal: boolean;
  /** 直前に展開したノード (表示をそこへ寄せる) */
  focusId: string | null;

  start: (origin: CodeMapOrigin, provider?: Provider, agent?: AiAgent) => Promise<void>;
  expand: (nodeId: string, relation: CodeRelation) => Promise<void>;
  collapse: (nodeId: string, relation: CodeRelation) => void;
  remove: (nodeId: string) => void;
  /** 起点の調べ直しや AI の実行を止める */
  cancel: () => void;
  dismissNotices: () => void;
  setShowExternal: (on: boolean) => void;
  close: () => void;
}

export const nodeId = (item: CodeItem) =>
  `${item.path}#${item.selectionRange.start.line}:${item.selectionRange.start.character}`;

/** クラス・インターフェイス・構造体・列挙型 (SymbolKind) */
const TYPE_KINDS = new Set([5, 10, 11, 23, 26]);

export const isTypeKind = (kind: number) => TYPE_KINDS.has(kind);

/** ノードの左のボタン (参照元) で使う関係。型は呼び出し元ではなくすべての参照をたどる */
export function leftRelation(item: CodeItem, provider: Provider): CodeRelation {
  return provider === 'lsp' && isTypeKind(item.kind) ? 'references' : 'callers';
}

/** 左側 (参照元) に広がる関係か */
export const isLeftRelation = (r: CodeRelation) => r === 'callers' || r === 'references' || r === 'subtypes';

export const RELATION_LABELS: Record<CodeRelation, string> = {
  callers: '呼び出し元',
  callees: '呼び出し先',
  references: '参照元 (すべての参照)',
  supertypes: '親の型',
  subtypes: '子の型',
};

const EDGE_KIND: Record<CodeRelation, EdgeKind> = {
  callers: 'call',
  callees: 'call',
  references: 'ref',
  supertypes: 'type',
  subtypes: 'type',
};

/** 実行中の AI の依頼 (取り消し用) */
const aborts = new Set<AbortController>();
/** start のたびに増やし、古い起点の結果が後から届いても捨てる */
let generation = 0;

function abortAll(): void {
  for (const a of aborts) a.abort();
  aborts.clear();
}

function errorOf(e: unknown): { message: string; code: string } {
  if (e instanceof ApiError) return { message: e.message, code: e.code };
  return { message: e instanceof Error ? e.message : String(e), code: 'error' };
}

/** 既にあるノードに、階層の項目 (call / type) などの情報を足す */
function mergeItem(a: CodeItem, b: CodeItem): CodeItem {
  return { ...a, call: a.call ?? b.call, type: a.type ?? b.type, detail: a.detail ?? b.detail };
}

/** 展開の結果をグラフに足す */
function addLinks(
  nodes: Record<string, MapNode>,
  edges: Record<string, MapEdge>,
  from: MapNode,
  relation: CodeRelation,
  links: CodeLink[],
): void {
  const owner = `${from.id}|${relation}`;
  const kind = EDGE_KIND[relation];
  for (const link of links) {
    const id = nodeId(link.item);
    const existing = nodes[id];
    nodes[id] = existing ? { ...existing, item: mergeItem(existing.item, link.item) } : { id, item: link.item, expanded: {} };
    const [src, dst] = isLeftRelation(relation) ? [id, from.id] : [from.id, id];
    const eid = `${src}>${dst}>${kind}`;
    const e = edges[eid];
    if (e) {
      // 同じ呼び出しを両側から展開したときは箇所を重ねない
      const seen = new Set(e.sites.map((s) => `${s.start.line}:${s.start.character}`));
      edges[eid] = {
        ...e,
        sites: [...e.sites, ...link.sites.filter((s) => !seen.has(`${s.start.line}:${s.start.character}`))],
        owners: e.owners.includes(owner) ? e.owners : [...e.owners, owner],
      };
    } else {
      edges[eid] = { id: eid, from: src, to: dst, kind, sitePath: link.sitePath, sites: link.sites, owners: [owner] };
    }
  }
}

/** 起点からたどれなくなったノード (とそのエッジ) を消す */
function prune(nodes: Record<string, MapNode>, edges: Record<string, MapEdge>, rootId: string): void {
  const adj = new Map<string, string[]>();
  for (const e of Object.values(edges)) {
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    adj.set(e.to, [...(adj.get(e.to) ?? []), e.from]);
  }
  const alive = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    for (const next of adj.get(queue.shift()!) ?? []) {
      if (!alive.has(next)) {
        alive.add(next);
        queue.push(next);
      }
    }
  }
  for (const id of Object.keys(nodes)) if (!alive.has(id)) delete nodes[id];
  for (const [id, e] of Object.entries(edges)) if (!alive.has(e.from) || !alive.has(e.to)) delete edges[id];
}

export const useCodeMap = create<CodeMapStore>((set, get) => ({
  origin: null,
  session: null,
  nodes: {},
  edges: {},
  rootId: null,
  pending: {},
  loading: null,
  error: null,
  notices: [],
  showExternal: false,
  focusId: null,

  start: async (origin, provider = 'lsp', agent = 'claude') => {
    abortAll();
    const gen = ++generation;
    set({
      origin,
      session: null,
      nodes: {},
      edges: {},
      rootId: null,
      pending: {},
      loading: provider,
      error: null,
      notices: [],
      focusId: null,
    });
    if (useUi.getState().view !== 'codemap') switchView('codemap');

    if (provider === 'ai') {
      const ctrl = new AbortController();
      aborts.add(ctrl);
      try {
        const r = await api.codeMapAiPrepare(
          { agent, path: origin.path, position: origin.position, word: origin.word },
          ctrl.signal,
        );
        if (gen !== generation) return;
        const root: MapNode = { id: nodeId(r.item), item: r.item, expanded: { callers: true, callees: true } };
        const nodes = { [root.id]: root };
        const edges: Record<string, MapEdge> = {};
        addLinks(nodes, edges, root, 'callers', r.links.callers);
        addLinks(nodes, edges, root, 'callees', r.links.callees);
        set({ session: { provider, root: r.root, agent }, nodes, edges, rootId: root.id, loading: null, focusId: root.id });
      } catch (e) {
        if (gen !== generation) return;
        set({ loading: null, error: ctrl.signal.aborted ? { message: '中止しました', code: 'aborted' } : errorOf(e) });
      } finally {
        aborts.delete(ctrl);
      }
      return;
    }

    try {
      const r = await api.codeMapPrepare({ path: origin.path, position: origin.position, content: origin.content });
      if (gen !== generation) return;
      const item = r.items[0];
      const root: MapNode = { id: nodeId(item), item, expanded: {} };
      set({
        session: { provider, root: r.root, serverId: r.serverId, serverLabel: r.serverLabel },
        nodes: { [root.id]: root },
        rootId: root.id,
        loading: null,
        notices: r.notices,
        focusId: root.id,
      });
      // 最初は参照元と参照先を 1 段ずつ開いておく
      await Promise.all([get().expand(root.id, leftRelation(item, 'lsp')), get().expand(root.id, 'callees')]);
    } catch (e) {
      if (gen !== generation) return;
      set({ loading: null, error: errorOf(e) });
    }
  },

  expand: async (id, relation) => {
    const { session, nodes } = get();
    const node = nodes[id];
    if (!session || !node || get().pending[id]?.includes(relation)) return;
    const gen = generation;
    set((s) => ({ pending: { ...s.pending, [id]: [...(s.pending[id] ?? []), relation] } }));
    const ctrl = new AbortController();
    aborts.add(ctrl);
    try {
      let links: CodeLink[];
      let notices: string[] = [];
      if (session.provider === 'ai') {
        if (relation !== 'callers' && relation !== 'callees') throw new Error('AI では呼び出し元 / 呼び出し先だけを調べられます');
        links = (
          await api.codeMapAiExpand(
            { agent: session.agent ?? 'claude', item: node.item, relation, root: session.root },
            ctrl.signal,
          )
        ).links;
      } else {
        const r = await api.codeMapExpand({
          item: node.item,
          relation,
          serverId: session.serverId!,
          root: session.root,
        });
        links = r.links;
        notices = r.notices;
      }
      if (gen !== generation) return;
      set((s) => {
        const cur = s.nodes[id];
        if (!cur) return {};
        const nodes2 = { ...s.nodes, [id]: { ...cur, expanded: { ...cur.expanded, [relation]: true as const } } };
        const edges2 = { ...s.edges };
        addLinks(nodes2, edges2, nodes2[id], relation, links);
        const label = `${cur.item.name} の${RELATION_LABELS[relation]}`;
        const extra = links.length ? notices : [...notices, `${label}は見つかりませんでした`];
        return {
          nodes: nodes2,
          edges: edges2,
          focusId: id,
          notices: [...s.notices, ...extra.map((n) => (n.includes(cur.item.name) ? n : `${label}: ${n}`))],
        };
      });
    } catch (e) {
      if (gen !== generation) return;
      if (!ctrl.signal.aborted) toastError(e);
    } finally {
      aborts.delete(ctrl);
      if (gen === generation) {
        set((s) => {
          const pending = { ...s.pending };
          const rest = (pending[id] ?? []).filter((r) => r !== relation);
          if (rest.length) pending[id] = rest;
          else delete pending[id];
          return { pending };
        });
      }
    }
  },

  collapse: (id, relation) => {
    const { rootId } = get();
    if (!rootId) return;
    set((s) => {
      const owner = `${id}|${relation}`;
      const edges: Record<string, MapEdge> = {};
      for (const [eid, e] of Object.entries(s.edges)) {
        const owners = e.owners.filter((o) => o !== owner);
        if (owners.length) edges[eid] = owners.length === e.owners.length ? e : { ...e, owners };
      }
      const nodes = { ...s.nodes };
      const cur = nodes[id];
      if (cur) {
        const expanded = { ...cur.expanded };
        delete expanded[relation];
        nodes[id] = { ...cur, expanded };
      }
      prune(nodes, edges, rootId);
      return { nodes, edges };
    });
  },

  remove: (id) => {
    const { rootId } = get();
    if (!rootId || id === rootId) return;
    set((s) => {
      const nodes = { ...s.nodes };
      delete nodes[id];
      const edges = Object.fromEntries(Object.entries(s.edges).filter(([, e]) => e.from !== id && e.to !== id));
      prune(nodes, edges, rootId);
      return { nodes, edges };
    });
  },

  cancel: () => {
    abortAll();
    if (get().loading) {
      generation++;
      set({ loading: null, pending: {}, error: { message: '中止しました', code: 'aborted' } });
    }
  },

  dismissNotices: () => set({ notices: [] }),
  setShowExternal: (showExternal) => set({ showExternal }),

  close: () => {
    abortAll();
    generation++;
    set({ origin: null, session: null, nodes: {}, edges: {}, rootId: null, pending: {}, loading: null, error: null, notices: [] });
    if (useUi.getState().view === 'codemap') replaceView('files');
  },
}));

/** エディタのカーソル位置から開く (エディタの右クリック・Shift+Alt+H) */
export function openCodeMap(origin: CodeMapOrigin, provider?: Provider): void {
  void useCodeMap.getState().start(origin, provider);
}

/** 言語サーバが無い / 設定されていないときのエラーコード (AI での生成を勧める) */
export const LSP_UNAVAILABLE_CODES = new Set(['lsp_not_found', 'lsp_not_configured']);
