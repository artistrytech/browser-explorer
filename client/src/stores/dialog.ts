import { create } from 'zustand';

/** チェックボックス付き確認ダイアログの結果 (キャンセルは ok:false) */
export interface ConfirmResult {
  ok: boolean;
  checked: boolean;
}

export interface DialogRequest {
  kind: 'confirm' | 'prompt';
  title: string;
  message?: string;
  defaultValue?: string;
  danger?: boolean;
  selectStem?: boolean; // prompt 時、拡張子を除く部分だけ選択
  /** confirm 時、OK と一緒に返すオプション (force など) のチェックボックス */
  checkbox?: { label: string; checked?: boolean };
  resolve: (value: string | boolean | null | ConfirmResult) => void;
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

/**
 * チェックボックス (force などの追加オプション) 付きの確認ダイアログ。
 * OK なら { ok: true, checked }、キャンセル / 背景クリックなら { ok: false, checked: false } を返す。
 */
export function confirmDialogWithOption(
  title: string,
  message: string | undefined,
  checkboxLabel: string,
  opts: { danger?: boolean; checked?: boolean } = {},
): Promise<ConfirmResult> {
  return new Promise((resolve) => {
    useDialog.getState().open({
      kind: 'confirm',
      title,
      message,
      danger: opts.danger,
      checkbox: { label: checkboxLabel, checked: opts.checked },
      resolve: (v) =>
        resolve(
          typeof v === 'object' && v !== null ? v : { ok: v === true, checked: false },
        ),
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
