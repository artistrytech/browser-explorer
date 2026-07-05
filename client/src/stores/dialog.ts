import { create } from 'zustand';

export interface DialogRequest {
  kind: 'confirm' | 'prompt';
  title: string;
  message?: string;
  defaultValue?: string;
  danger?: boolean;
  selectStem?: boolean; // prompt 時、拡張子を除く部分だけ選択
  resolve: (value: string | boolean | null) => void;
}

interface DialogStore {
  current: DialogRequest | null;
  open: (req: DialogRequest) => void;
  close: () => void;
}

export const useDialog = create<DialogStore>((set) => ({
  current: null,
  open: (req) => set({ current: req }),
  close: () => set({ current: null }),
}));

export function confirmDialog(title: string, message?: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    useDialog.getState().open({
      kind: 'confirm',
      title,
      message,
      danger,
      resolve: (v) => resolve(v === true),
    });
  });
}

export function promptDialog(
  title: string,
  defaultValue = '',
  opts: { message?: string; selectStem?: boolean } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    useDialog.getState().open({
      kind: 'prompt',
      title,
      message: opts.message,
      defaultValue,
      selectStem: opts.selectStem,
      resolve: (v) => resolve(typeof v === 'string' ? v : null),
    });
  });
}
