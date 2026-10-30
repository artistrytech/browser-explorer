import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { norm } from '../services/fsService.js';
import { AI_MODEL_RE, getAppConfig } from '../services/appConfigStore.js';
import {
  createBox,
  deleteBox,
  deleteTurns,
  getBox,
  getTurn,
  isAiAgent,
  listBoxes,
  listTurns,
  startTurn,
  updateBox,
  type AiBox,
} from '../services/aiStore.js';
import {
  AI_EFFORTS,
  AI_PERMISSIONS,
  cancelTurn,
  detectAgents,
  isBoxRunning,
  listCodexModels,
  runTurn,
} from '../services/aiRunner.js';
import { broadcastEvent } from '../ws/watcher.js';

/**
 * AI チャット (Codex / Claude の CLI との対話)。
 * 会話の Box の管理と、依頼の実行 (結果は WS の ai:turn で届く)。
 */
export const aiRouter = Router();

function badRequest(message: string): never {
  const err = new Error(message) as Error & { status?: number };
  err.status = 400;
  throw err;
}

function notFound(message: string): never {
  const err = new Error(message) as Error & { status?: number };
  err.status = 404;
  throw err;
}

function mustGetBox(v: unknown): AiBox {
  const id = Number(v);
  if (!Number.isInteger(id) || id <= 0) badRequest('id is required');
  return getBox(id) ?? notFound('Box が見つかりません');
}

/** ベースフォルダは実在するフォルダのみ (表記は / 区切りにそろえる) */
async function resolveDir(v: unknown): Promise<string> {
  if (typeof v !== 'string' || !v.trim()) badRequest('ベースフォルダを指定してください');
  const dir = path.resolve(v.trim());
  const st = await fs.stat(dir).catch(() => null);
  if (!st?.isDirectory()) badRequest(`フォルダが見つかりません: ${v}`);
  return norm(dir);
}

function boxName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name) badRequest('名前を入力してください');
  return name.slice(0, 200);
}

/** Box に実行中のターンがあるかを付けて返す */
function withRunning(box: AiBox) {
  return { ...box, running: isBoxRunning(box.id) };
}

/** 設定画面で決めた権限の既定値 (依頼で未指定のときに使う) */
function defaultPermissions() {
  const cfg = getAppConfig();
  return { codex: cfg.aiCodexSandbox, claude: cfg.aiClaudePermission };
}

/** codex / claude の有無と、選べるモデル・effort・権限の一覧 */
aiRouter.get('/agents', async (req, res) => {
  const agents = await detectAgents(req.query.refresh === '1');
  res.json({
    agents,
    models: getAppConfig().aiModels,
    efforts: AI_EFFORTS,
    permissions: AI_PERMISSIONS,
    defaultPermissions: defaultPermissions(),
  });
});

/** codex debug models のモデル一覧 (設定画面の入力サポート) */
aiRouter.get('/codex-models', async (_req, res) => {
  res.json({ models: await listCodexModels() });
});

aiRouter.get('/boxes', (_req, res) => {
  res.json({ boxes: listBoxes().map(withRunning) });
});

aiRouter.post('/boxes', async (req, res) => {
  const body = (req.body ?? {}) as { name?: unknown; cwd?: unknown };
  const box = createBox(boxName(body.name), await resolveDir(body.cwd));
  broadcastEvent('ai:boxes', { boxId: box.id });
  res.json(withRunning(box));
});

/** 1 回に返す会話の件数の上限 (古いものは「さらに読み込む」で before を付けて取りに来る) */
const MAX_TURNS_PAGE = 100;

/** Box と、その会話 (新しい方から limit 件。before より古いものに限ることもできる) */
aiRouter.get('/boxes/:id', (req, res) => {
  const box = mustGetBox(req.params.id);
  const n = Number(req.query.limit);
  const limit = Number.isInteger(n) && n > 0 ? Math.min(n, MAX_TURNS_PAGE) : MAX_TURNS_PAGE;
  const b = Number(req.query.before);
  const before = Number.isInteger(b) && b > 0 ? b : undefined;
  const { turns, hasMore } = listTurns(box.id, { limit, before });
  res.json({ box: withRunning(box), turns, hasMore });
});

/**
 * 会話の削除。older=true なら指定の会話と、それより古い会話をまとめて削除する。
 * 表示上の記録を消すだけで、CLI 側の会話の記録 (継続したときの文脈) には影響しない
 */
aiRouter.post('/boxes/:id/turns/delete', (req, res) => {
  const box = mustGetBox(req.params.id);
  const body = (req.body ?? {}) as { turnId?: unknown; older?: unknown };
  const turnId = Number(body.turnId);
  if (!Number.isInteger(turnId) || turnId <= 0) badRequest('turnId is required');
  const older = body.older === true;
  const deleted = deleteTurns(box.id, turnId, older);
  if (deleted === null) badRequest('実行中の会話は削除できません。先に停止してください');
  broadcastEvent('ai:turns-deleted', { boxId: box.id, ids: deleted, older });
  res.json({ deleted });
});

/** 名前・ベースフォルダの変更 (フォルダを変えると、以降の依頼はすべて新しい会話になる) */
aiRouter.patch('/boxes/:id', async (req, res) => {
  const box = mustGetBox(req.params.id);
  const body = (req.body ?? {}) as { name?: unknown; cwd?: unknown };
  const patch: { name?: string; cwd?: string } = {};
  if (body.name !== undefined) patch.name = boxName(body.name);
  if (body.cwd !== undefined) {
    if (isBoxRunning(box.id)) badRequest('実行中はベースフォルダを変更できません');
    patch.cwd = await resolveDir(body.cwd);
  }
  const updated = updateBox(box.id, patch)!;
  broadcastEvent('ai:boxes', { boxId: box.id });
  res.json(withRunning(updated));
});

aiRouter.delete('/boxes/:id', (req, res) => {
  const box = mustGetBox(req.params.id);
  if (isBoxRunning(box.id)) badRequest('実行中の Box は削除できません。先に停止してください');
  deleteBox(box.id);
  broadcastEvent('ai:boxes', { boxId: box.id, deleted: true });
  res.json({ ok: true });
});

/**
 * 依頼を送る。mode=continue はその AI の最後の会話を続ける (別の AI の会話は引き継げない)。
 * 実行は待たずにターン (実行中) を返し、出力は WS の ai:turn で届く
 */
aiRouter.post('/boxes/:id/send', async (req, res) => {
  const box = mustGetBox(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { agent, mode } = body;
  if (!isAiAgent(agent)) badRequest('AI の種類が不正です');
  if (mode !== 'new' && mode !== 'continue') badRequest('mode が不正です');
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  const effort = typeof body.effort === 'string' ? body.effort.trim() : '';
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  // 権限は未指定なら設定の既定値。実行した値をターンに残す
  const permission = (typeof body.permission === 'string' && body.permission.trim()) || defaultPermissions()[agent];
  if (!AI_PERMISSIONS[agent].includes(permission)) badRequest(`権限が不正です: ${permission}`);
  if (model && !AI_MODEL_RE.test(model)) badRequest(`モデル名が不正です: ${model}`);
  if (effort && !AI_EFFORTS[agent].includes(effort)) badRequest(`effort が不正です: ${effort}`);
  if (!prompt.trim()) badRequest('依頼内容を入力してください');
  if (isBoxRunning(box.id)) badRequest('この Box は実行中です。完了を待つか停止してください');
  if (!(await detectAgents())[agent].available) badRequest(`${agent} が PATH に見つかりません`);
  if (mode === 'continue' && !box.sessions[agent]?.sessionId) {
    badRequest('続ける会話がありません。新しい会話で依頼してください');
  }
  // ベースフォルダが消えていたら実行できない (spawn の cwd エラーより分かりやすく返す)
  await resolveDir(box.cwd);

  const { turn, resumeId } = startTurn({ box, agent, mode, model, effort, permission, prompt });
  await runTurn(turn, resumeId);
  // 「続ける」の対象が変わったことを知らせる (実行中の扱いになった後に送る)
  broadcastEvent('ai:boxes', { boxId: box.id });
  res.json(getTurn(turn.id));
});

aiRouter.post('/turns/:id/cancel', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) badRequest('id is required');
  res.json({ ok: cancelTurn(id) });
});
