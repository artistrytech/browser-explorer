import type { MenuItem } from '../components/ContextMenu';
import { useToast, toastError } from '../stores/toast';
import { useUi } from '../stores/ui';
import { copyText } from './clipboard';

export async function copyWithToast(text: string, message: string): Promise<void> {
  try {
    await copyText(text);
    useToast.getState().show('success', message);
  } catch (e) {
    toastError(e);
  }
}

/** メニューに添えるパスの最大文字数。超える場合は先頭と末尾 (ファイル名側) を残して途中を省略する */
const PATH_DETAIL_MAX = 60;

function middleEllipsis(s: string, max = PATH_DETAIL_MAX): string {
  if (s.length <= max) return s;
  const head = Math.floor((max - 1) * 0.4);
  return `${s.slice(0, head)}…${s.slice(s.length - (max - 1 - head))}`;
}

/**
 * パスのコピー項目。コピーされるパスをラベルの下に添える。
 * Windows では区切り文字 "/" と "\" の両方を出す (パスは内部では "/" 区切りで持っている。区切りを含まなければ 1 つ)。
 * 複数のパスは 1 行に 1 つずつ並べてコピーし、添えるパスは先頭のものと件数にする。
 */
export function copyPathItems(label: string, paths: string | string[]): MenuItem[] {
  const list = typeof paths === 'string' ? [paths] : paths;
  if (list.length === 0) return [];
  const done = `${label}しました`;
  const hasSlash = list.some((p) => p.includes('/'));
  const variants =
    useUi.getState().platform === 'win32' && hasSlash ? [list, list.map((p) => p.replace(/\//g, '\\'))] : [list];
  return variants.map((v) => {
    const text = v.join('\n');
    const more = v.length > 1 ? ` ほか ${v.length - 1} 件` : '';
    return {
      label,
      detail: `${middleEllipsis(v[0])}${more}`,
      title: more || v[0].length > PATH_DETAIL_MAX ? text : undefined,
      action: () => void copyWithToast(text, done),
    };
  });
}
