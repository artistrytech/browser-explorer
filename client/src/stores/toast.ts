import { create } from 'zustand';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  message: string;
}

let nextId = 1;

interface ToastStore {
  toasts: Toast[];
  show: (kind: Toast['kind'], message: string) => void;
  dismiss: (id: number) => void;
}

export const useToast = create<ToastStore>((set) => ({
  toasts: [],
  show: (kind, message) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, kind === 'error' ? 6000 : 3000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function toastError(e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  useToast.getState().show('error', message);
}
