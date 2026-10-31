import { Router, type Response } from 'express';
import { aiExpand, aiPrepare, type AiRelation } from '../services/codeMapAi.js';
import { norm } from '../services/fsService.js';
import { LSP_PRESETS } from '../services/lspPresets.js';
import {
  expand,
  findRepoRoot,
  listInstances,
  prepare,
  RELATIONS,
  serverStatuses,
  stopInstances,
  type CodeItem,
  type Pos,
  type Relation,
} from '../services/lsp.js';

/**
 * コードマップ (選んだクラス・メソッド等の参照元 / 参照先のマップ)。
 * 言語サーバ (LSP) で調べるのが基本で、言語サーバの無い言語は AI (claude / codex) に作らせる。
 */
export const codeMapRouter = Router();

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

function reqPath(v: unknown): string {
  if (typeof v !== 'string' || !v) throw badRequest('path が必要です');
  return norm(v);
}

function reqPosition(v: unknown): Pos {
  const p = (v ?? {}) as Record<string, unknown>;
  const line = Number(p.line);
  const character = Number(p.character);
  if (!Number.isInteger(line) || line < 0 || !Number.isInteger(character) || character < 0) {
    throw badRequest('position が不正です');
  }
  return { line, character };
}

function reqItem(v: unknown): CodeItem {
  const it = (v ?? {}) as Partial<CodeItem>;
  if (typeof it.name !== 'string' || typeof it.path !== 'string' || !it.selectionRange || !it.range) {
    throw badRequest('item が不正です');
  }
  return it as CodeItem;
}

const optStr = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** 応答を待たずに画面側が取り消したら (fetch の中断) AI の実行を止める */
function abortOnClose(res: Response): AbortSignal {
  const ctrl = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ctrl.abort();
  });
  return ctrl.signal;
}

/** 言語サーバの定義と、コマンドが見つかるか・起動中のもの・プリセット (設定画面の「プリセットから追加」) */
codeMapRouter.get('/servers', async (req, res) => {
  const root = optStr(req.query.root);
  res.json({
    servers: await serverStatuses(root ? norm(root) : null),
    running: listInstances(),
    presets: LSP_PRESETS,
  });
});

/** 起動中の言語サーバを止める (serverId / root を省くとすべて) */
codeMapRouter.post('/stop', (req, res) => {
  const { serverId, root } = (req.body ?? {}) as Record<string, unknown>;
  res.json({ stopped: stopInstances({ serverId: optStr(serverId), root: optStr(root) }) });
});

/** カーソル位置のシンボルを起点にする。content はエディタで編集中の内容 (省くとディスクから読む) */
codeMapRouter.post('/prepare', async (req, res) => {
  const { path, position, content } = (req.body ?? {}) as Record<string, unknown>;
  res.json(
    await prepare({
      path: reqPath(path),
      position: reqPosition(position),
      content: typeof content === 'string' ? content : undefined,
    }),
  );
});

codeMapRouter.post('/expand', async (req, res) => {
  const { item, relation, serverId, root } = (req.body ?? {}) as Record<string, unknown>;
  if (!RELATIONS.includes(relation as Relation)) throw badRequest('relation が不正です');
  res.json(
    await expand({ item: reqItem(item), relation: relation as Relation, serverId: optStr(serverId), root: optStr(root) }),
  );
});

/**
 * AI で作る。item を省くと path / position のシンボルを起点に呼び出し元・呼び出し先をまとめて調べ、
 * item を渡すとそのノードを relation の向きに 1 段展開する
 */
codeMapRouter.post('/ai', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const agent = body.agent === 'codex' ? 'codex' : 'claude';
  const signal = abortOnClose(res);
  if (body.item) {
    const item = reqItem(body.item);
    if (body.relation !== 'callers' && body.relation !== 'callees') throw badRequest('relation が不正です');
    const cwd = optStr(body.root) ? norm(body.root as string) : findRepoRoot(item.path);
    res.json({ links: await aiExpand({ agent, cwd, item, relation: body.relation as AiRelation, signal }) });
    return;
  }
  const p = reqPath(body.path);
  const position = reqPosition(body.position);
  res.json(
    await aiPrepare({
      agent,
      cwd: findRepoRoot(p),
      path: p,
      line: position.line,
      word: typeof body.word === 'string' ? body.word.slice(0, 200) : '',
      signal,
    }),
  );
});
