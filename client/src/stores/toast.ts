import { create } from 'zustand';
import { ApiError, api } from '../api/client';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  message: string;
  /** エラーに対応するサーバ側のリクエスト ID (アプリログで検索できる) */
  requestId?: string | null;
}

let nextId = 1;

interface ToastStore {
  toasts: Toast[];
  show: (kind: Toast['kind'], message: string, requestId?: string | null) => void;
  dismiss: (id: number) => void;
}

export const useToast = create<ToastStore>((set) => ({
  toasts: [],
  show: (kind, message, requestId) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message, requestId }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, kind === 'error' ? 6000 : 3000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/**
 * エラーをトースト表示する。
 * - API エラーはサーバ側で記録済みなのでリクエスト ID を添えて表示 (クリックでアプリログへ)
 * - それ以外 (UI 側の例外や、サーバに届かなかったエラー) はサーバのログへ送って後から追えるようにする
 */
export function toastError(e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  const requestId = e instanceof ApiError ? e.requestId : null;
  useToast.getState().show('error', message, requestId);
  if (requestId) return;
  if (e instanceof ApiError && (e.code === 'network' || e.code === 'unreachable')) return;
  void api.logClient('error', message, 'toast', {
    ...(e instanceof Error ? { name: e.name, stack: e.stack } : {}),
    ...(e instanceof ApiError ? { status: e.status, code: e.code } : {}),
    url: location.href,
  });
}
