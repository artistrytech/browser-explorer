import { create } from 'zustand';

/** チェックボックス付き確認ダイアログの結果 (キャンセルは ok:false) */
export interface ConfirmResult {
  ok: boolean;
  checked: boolean;
}

/** choiceDialog のラジオボタンの選択肢 */
export interface DialogChoice {
  value: string;
  label: string;
}

export interface DialogRequest {
  kind: 'confirm' | 'prompt';
  title: string;
  message?: string;
  defaultValue?: string;
  danger?: boolean;
  selectStem?: boolean; // prompt 時、拡張子を除く部分だけ選択
  placeholder?: string; // prompt 時、入力欄が空のときに出す薄字
  /** confirm 時、OK と一緒に返すオプション (force など) のチェックボックス */
  checkbox?: { label: string; checked?: boolean };
  /** confirm 時、OK と一緒に返す選択肢 (ラジオボタン)。OK で選んだ value を返す */
  choices?: { options: DialogChoice[]; value: string };
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
  opts: { message?: string; selectStem?: boolean; placeholder?: string } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    useDialog.getState().open({
      kind: 'prompt',
      title,
      message: opts.message,
      defaultValue,
      selectStem: opts.selectStem,
      placeholder: opts.placeholder,
      resolve: (v) => resolve(typeof v === 'string' ? v : null),
    });
  });
}

/**
 * ラジオボタンで 1 つ選ぶ確認ダイアログ。OK なら選んだ value、キャンセル / 背景クリックなら null を返す
 */
export function choiceDialog(
  title: string,
  message: string | undefined,
  options: DialogChoice[],
  value: string,
  danger = false,
): Promise<string | null> {
  return new Promise((resolve) => {
    useDialog.getState().open({
      kind: 'confirm',
      title,
      message,
      danger,
      choices: { options, value },
      resolve: (v) => resolve(typeof v === 'string' ? v : null),
    });
  });
}
