import { Router } from 'express';
import { getState, putState, importState, AppState } from '../services/stateStore.js';

export const stateRouter = Router();

stateRouter.get('/', (_req, res) => {
  res.json(getState());
});

stateRouter.put('/', (req, res) => {
  putState(req.body as Partial<AppState>);
  res.json({ ok: true });
});

stateRouter.get('/export', (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="explorer-state.json"');
  res.json(getState());
});

stateRouter.post('/import', (req, res) => {
  importState(req.body as Partial<AppState>);
  res.json({ ok: true });
});
