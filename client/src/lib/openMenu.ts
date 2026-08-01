/**
 * 「開く」系メニューの共通部品。
 * ファイル一覧 (ファイルタブ) と Git の変更ファイル一覧 (コミットタブ) で、
 * 同じ項目・同じ挙動・同じ表示設定 (contextMenu の id) を使うためにここへ集約する。
 */

import { api } from '../api/client';
import { useExplorer } from '../stores/explorer';
import { useUi, osMenuLabels, type ExternalTool } from '../stores/ui';
import { toastError } from '../stores/toast';
import { openEntry, openWithDefault, runExternalTool } from './fileOps';
import { saveEnteredChild } from './focusMemory';
import { parentPath, baseName } from './paths';
import type { MenuItem } from '../components/ContextMenu';

/** contextMenu 設定 (id) を持てるメニュー項目 */
export type CfgMenuItem = Omit<MenuItem, 'submenu'> & { id?: string; submenu?: CfgMenuItem[] };

/**
 * 外部ツールがメニューに出せるか: 対象 (複数選択可) が全て kind / 拡張子条件に合致するか。
 * kind 'any'/未指定は種別不問。extensions 空/未指定は全拡張子対象 (フォルダは拡張子条件に不一致)。
 */
export function toolMatches(
  t: { kind?: 'file' | 'dir' | 'any'; extensions?: string[] },
  targets: { kind: 'file' | 'dir'; ext: string }[],
): boolean {
  return targets.every((tg) => {
    const kindOk = !t.kind || t.kind === 'any' || t.kind === tg.kind;
    const extOk =
      !t.extensions || t.extensions.length === 0 || (tg.kind === 'file' && t.extensions.includes(tg.ext));
    return kindOk && extOk;
  });
}

/**
 * 設定 (contextMenu) で false にされた項目を間引く。
 * 空になったサブメニューと、先頭/連続/末尾の separator も取り除く。
 */
export function pruneMenuItems(items: CfgMenuItem[], menuConfig: Record<string, boolean>): MenuItem[] {
  const out: MenuItem[] = [];
  for (const it of items) {
    if (it.id && menuConfig[it.id] === false) continue;
    if (it.submenu) {
      const submenu = pruneMenuItems(it.submenu, menuConfig);
      if (submenu.length > 0) out.push({ ...it, submenu });
      continue;
    }
    if (it.separator && (out.length === 0 || out[out.length - 1].separator)) continue;
    out.push(it);
  }
  while (out.length > 0 && out[out.length - 1].separator) out.pop();
  return out;
}

/**
 * OS 連携項目 (ファイルマネージャ / ターミナル)。
 * フォルダはそのフォルダを、ファイルは親フォルダを開く
 * (ファイルマネージャはそのファイルを選択した状態で開く → サーバ側で /select, や -R を使う)。
 */
export function osMenuItems(targetPath: string, platform: string): CfgMenuItem[] {
  const labels = osMenuLabels(platform);
  return [
    {
      id: 'osFileManager',
      label: labels.fileManager,
      action: () => void api.osOpenFileManager(targetPath).catch(toastError),
    },
    {
      id: 'osTerminal',
      label: labels.terminal,
      action: () => void api.osOpenTerminal(targetPath).catch(toastError),
    },
  ];
}

/** 指定フォルダをブラウザの別タブで開く。focusName を渡すとその項目にフォーカスを当てる */
export function openDirInNewWindow(dir: string, focusName?: string): void {
  // フォーカス記録の sessionStorage は window.open 時に新タブへ複製されるので、先に保存する
  if (focusName) saveEnteredChild(dir, focusName, 0);
  window.open(`${location.pathname}?path=${encodeURIComponent(dir)}`, '_blank');
}

/**
 * 単一ファイル (絶対パス) 用の「開く」サブメニュー項目。
 * ファイル一覧の「開く」グループと同じ並び: 開く / エディタで開く / 別ウィンドウで開く /
 * OS 連携 / 外部ツール (group が「開く」のもの)。
 * 呼び出し側は pruneMenuItems() に通してから openMenu() へ渡す。
 */
export function fileOpenMenuItems(absPath: string): CfgMenuItem[] {
  const dir = parentPath(absPath);
  const name = baseName(absPath);
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const { platform, externalTools } = useUi.getState();

  /** 既定ツール / エディタで開く。エントリ情報はサーバの stat から得る (種別・拡張子が要るため) */
  const openBy = (fn: (entry: Awaited<ReturnType<typeof api.stat>>) => void) => () => {
    void api.stat(absPath).then(fn).catch(toastError);
  };

  const openTools: CfgMenuItem[] = externalTools
    .filter((t: ExternalTool) => t.label && t.group === '開く' && toolMatches(t, [{ kind: 'file', ext }]))
    .map((t) => ({ label: t.label, action: () => void runExternalTool(t, [absPath]) }));

  return [
    { id: 'open', label: '開く', action: openBy(openWithDefault) },
    { id: 'openEditor', label: 'エディタで開く', action: openBy(openEntry) },
    {
      id: 'openNewWindow',
      label: '別ウィンドウで開く',
      action: () => openDirInNewWindow(dir, name),
    },
    {
      id: 'openLocation',
      label: 'ファイル場所に移動',
      action: (e) => {
        saveEnteredChild(dir, name, 0); // 移動先でこのファイルにフォーカスを当てる
        if (e.ctrlKey || e.metaKey) openDirInNewWindow(dir, name);
        else void useExplorer.getState().navigate(dir);
      },
    },
    { separator: true },
    ...osMenuItems(absPath, platform),
    ...openTools,
  ];
}
