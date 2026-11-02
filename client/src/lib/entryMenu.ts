/**
 * ファイル / フォルダの右クリックメニュー (出し分けは 002.md §8)。
 * ファイル一覧 (ファイルタブ) とプロジェクトツリー (左パネル) で同じ項目・同じ並び・
 * 同じ表示設定 (contextMenu の id) を使うためにここへ集約する。
 */

import { api } from '../api/client';
import type { MenuItem } from '../components/ContextMenu';
import { openCloneDialog } from '../features/git/CloneDialog';
import { isMarkdownPath, openMarkdownPreview } from '../features/preview/MarkdownTab';
import { openDualPane } from '../features/transfer/DualPaneDialog';
import { openConflictResolver } from '../stores/conflict';
import { useExplorer } from '../stores/explorer';
import { useGit } from '../stores/git';
import { useSettings } from '../stores/settings';
import { toastError } from '../stores/toast';
import { useUi } from '../stores/ui';
import type { FsEntry } from '../types';
import { wantsNewTab } from './appTabs';
import { copyPathItems } from './copyPath';
import {
  copySelection,
  cutSelection,
  deleteSelection,
  openEntry,
  openWithDefault,
  paste,
  runExternalTool,
  showProperties,
} from './fileOps';
import { downloadArchive } from './gitArchive';
import { excludeUntracked } from './gitExclude';
import { osMenuItems, pruneMenuItems, toolMatches, type CfgMenuItem } from './openMenu';
import { pinFolder, unpinFolder } from './quickaccessOps';

/** 絶対パス → リポジトリルート相対 (repo 外は null) */
function repoRelOf(abs: string): string | null {
  const { repoRoot } = useGit.getState();
  if (!repoRoot) return null;
  if (abs === repoRoot) return '';
  return abs.startsWith(`${repoRoot}/`) ? abs.slice(repoRoot.length + 1) : null;
}

/**
 * カスタム項目 (設定の externalTools) を group ごとに振り分ける。
 * group が既定グループ名 (開く/削除/Git) ならそのサブメニューに合流し、
 * それ以外の名前なら同名のサブメニューを新設する。group 無しはメニュー直下。
 * targets の種別/拡張子が全て一致するツールだけを表示する。
 */
export function toolItems(paths: string[], targets: { kind: 'file' | 'dir'; ext: string }[]) {
  const byGroup = new Map<string, MenuItem[]>();
  const ungrouped: MenuItem[] = [];
  useUi.getState().externalTools.forEach((t) => {
    if (!t.label || !toolMatches(t, targets)) return;
    const item: MenuItem = {
      label: t.label,
      action: () => void runExternalTool(t, paths),
    };
    if (t.group) byGroup.set(t.group, [...(byGroup.get(t.group) ?? []), item]);
    else ungrouped.push(item);
  });
  /** 既定グループに合流する項目を取り出す (取り出したグループは新設対象から外れる) */
  const take = (group: string): MenuItem[] => {
    const items = byGroup.get(group) ?? [];
    byGroup.delete(group);
    return items;
  };
  /** 既定グループに属さなかったカスタム項目 (新設サブメニュー + group 無しの項目) */
  const rest = (): CfgMenuItem[] => [
    ...[...byGroup.entries()].map(([label, submenu]) => ({ label, submenu })),
    ...ungrouped,
  ];
  return { take, rest };
}

/** Git 系のリポジトリ操作 (選択パスに対するステージ/解除/破棄) */
function gitRepoItems(sel: string[]): CfgMenuItem[] {
  const { repoRoot } = useGit.getState();
  if (!repoRoot || !sel.every((p) => p.startsWith(`${repoRoot}/`))) return [];
  const rel = sel.map((p) => p.slice(repoRoot.length + 1));
  return [
    {
      id: 'gitStage',
      label: 'ステージ',
      action: () =>
        void api
          .gitStage(repoRoot, rel)
          .then(() => useGit.getState().refreshStatus())
          .catch(toastError),
    },
    {
      id: 'gitUnstage',
      label: 'ステージ解除',
      action: () =>
        void api
          .gitUnstage(repoRoot, rel)
          .then(() => useGit.getState().refreshStatus())
          .catch(toastError),
    },
    {
      id: 'gitDiscard',
      label: '変更を破棄',
      danger: true,
      action: () =>
        void api
          .gitDiscard(repoRoot, rel)
          .then(() => Promise.all([useGit.getState().refreshStatus(), useExplorer.getState().refresh()]))
          .catch(toastError),
    },
  ];
}

/** Git 系の文脈依存項目 (ログを表示 / 競合を解消 / Git Clone…) */
export function gitContextItems(targetPath: string, isFile: boolean, isDir: boolean): CfgMenuItem[] {
  const { repoRoot, mergeState } = useGit.getState();
  const rel = repoRelOf(targetPath);
  const items: CfgMenuItem[] = [];
  if (rel !== null) {
    // Git 管理下: パス絞り込みログ (002.md §1)。Ctrl+クリック (mac は ⌘) / 中クリックは別タブで開く
    items.push({
      id: 'gitLog',
      label: 'Gitログ',
      newTab: true,
      action: (e) => useGit.getState().showLogFor(rel, isFile, { newTab: wantsNewTab(e) }),
    });
    // HEAD 時点の内容を zip でダウンロード (対象がフォルダなら配下、ファイルならそのファイル)
    items.push({ id: 'gitArchive', label: 'アーカイブ', action: () => void downloadArchive(repoRoot!, rel) });
    // 配下に競合あり → 競合を解消 (002.md §2)。
    // stash の復元や cherry-pick --no-commit では進行中フラグが残らないので、競合の有無で判定する
    const conflictsUnder = mergeState.conflicted.some(
      (c) => rel === '' || c === rel || c.startsWith(`${rel}/`),
    );
    if (isDir && conflictsUnder) {
      items.push({ id: 'resolveConflict', label: '競合を解消…', action: () => openConflictResolver(rel) });
    }
  } else if (isDir) {
    // Git 管理外のフォルダ → Git Clone… (002.md §3)
    items.push({ id: 'gitClone', label: 'Git Clone…', action: () => openCloneDialog(targetPath) });
  }
  return items;
}

export interface EntryMenuOptions {
  /** 右クリックした項目 */
  entry: FsEntry;
  /** 操作の対象 (複数選択中ならその全項目。entry を含む) */
  targets: FsEntry[];
  /** ファイルを右クリックしたときの基準フォルダ (貼り付け先・「別ウィンドウで開く」で開くフォルダ) */
  fileDir: string;
  /** entry が Git の未追跡か (「未追跡ファイルを除外する」を出すか) */
  untracked: boolean;
  /** 「別ウィンドウで開く」: dir をブラウザの別タブで開き、focusName があればその項目にフォーカスを当てる */
  openInNewWindow: (dir: string, focusName?: string) => void;
  /** 「2 画面で整理…」(ファイル) の左側のフォルダ。省略時は一覧で表示中のフォルダ */
  dualPaneLeft?: string;
  /** 「名前の変更」 */
  rename: () => void;
}

/** ファイル / フォルダの右クリックメニュー。contextMenu 設定で間引いた結果を返す */
export function entryMenuItems(opts: EntryMenuOptions): MenuItem[] {
  const { entry, targets, fileDir } = opts;
  const sel = targets.map((t) => t.path);
  const single = sel.length === 1;
  const isDir = entry.type === 'dir';
  const { repoRoot } = useGit.getState();
  const pinned = useSettings.getState().isPinned(entry.path);
  const { clipboard } = useExplorer.getState();
  const { platform, menuConfig } = useUi.getState();
  // 外部ツール: 選択中のパス群 (複数可) を引数に起動。group 指定のものは各グループへ合流。
  // 表示条件用に選択エントリの種別/拡張子を渡す
  const tools = toolItems(
    sel,
    targets.map((d) => ({ kind: d.type === 'dir' ? 'dir' : 'file', ext: d.ext })),
  );

  // 「開く」系統をサブメニューにまとめる
  const openGroup: CfgMenuItem[] = [
    { id: 'open', label: '開く', action: () => targets.forEach(openWithDefault) },
    ...(isDir
      ? [
          // フォルダ: 対象フォルダ自体を別ウィンドウ (ブラウザの別タブ) で開く
          { id: 'openNewWindow', label: '別ウィンドウで開く', newTab: true, action: () => opts.openInNewWindow(entry.path) },
          // 表示中のフォルダ (左) とこのフォルダ (右) を並べて整理する
          { id: 'openDualPane', label: '2 画面で整理…', action: () => openDualPane({ right: entry.path }) },
          { separator: true },
          ...osMenuItems(entry.path, platform),
        ]
      : [
          { id: 'openEditor', label: 'エディタで開く', action: () => openEntry(entry) },
          // Markdown はダブルクリックの既定がプレビューなので、明示的に選べる項目も出す
          ...(isMarkdownPath(entry.path)
            ? [{ id: 'openPreview', label: 'プレビューで開く', action: () => openMarkdownPreview(entry.path) }]
            : []),
          // ファイル: 同じフォルダを別ウィンドウで開いて対象にフォーカス
          {
            id: 'openNewWindow',
            label: '別ウィンドウで開く',
            newTab: true,
            action: () => opts.openInNewWindow(fileDir, entry.name),
          },
          { id: 'openDualPane', label: '2 画面で整理…', action: () => openDualPane({ left: opts.dualPaneLeft }) },
          { separator: true },
          // ファイルも OS 側で開ける (親フォルダを開き、そのファイルを選択した状態にする)
          ...osMenuItems(entry.path, platform),
        ]),
    ...tools.take('開く'),
  ];

  // 「パスをコピー」系統 (リポジトリ内なら相対パスを先に出す)
  const rels = sel.map(repoRelOf);
  const copyPathGroup: CfgMenuItem[] = [
    ...(rels.every((r) => r) ? copyPathItems('リポジトリの相対パスをコピー', rels as string[]) : []),
    ...copyPathItems('パスをコピー', sel),
  ];

  // 「削除」系統
  const deleteGroup: CfgMenuItem[] = [
    { id: 'delete', label: 'ゴミ箱に移動', action: () => void deleteSelection(false, sel) },
    { id: 'deletePermanent', label: '完全に削除', action: () => void deleteSelection(true, sel), danger: true },
    ...tools.take('削除'),
  ];

  // 「Git」系統 (文脈依存項目 + リポジトリ操作)
  const rel = repoRelOf(entry.path);
  const gitGroup: CfgMenuItem[] = [
    ...gitContextItems(entry.path, !isDir, isDir),
    ...gitRepoItems(sel),
    // 未追跡のエントリ (1 件選択時) を .git/info/exclude に追加する。追跡済み / 無視済みや複数選択では出さない
    ...(repoRoot && single && rel && opts.untracked
      ? [
          { separator: true },
          {
            id: 'gitExclude',
            label: '未追跡ファイルを除外する',
            action: () => void excludeUntracked(repoRoot, rel, isDir),
          },
        ]
      : []),
    ...tools.take('Git'),
  ];

  const items: CfgMenuItem[] = [
    { id: 'groupOpen', label: '開く', submenu: openGroup },
    // ピン止め / 解除のトグル (002.md §7.2)。解除は確認フローへ
    ...(isDir
      ? [
          pinned
            ? { id: 'pin', label: 'ピン止めを解除', action: () => void unpinFolder(entry.path, entry.name) }
            : {
                id: 'pin',
                label: 'クイックアクセスにピン止め',
                action: () => void pinFolder(entry.path, entry.name),
              },
        ]
      : []),
    { separator: true },
    { id: 'copy', label: 'コピー', action: () => copySelection(sel) },
    { id: 'cut', label: '切り取り', action: () => cutSelection(sel) },
    {
      id: 'paste',
      label: '貼り付け',
      action: () => void paste(isDir ? entry.path : fileDir),
      disabled: !clipboard,
    },
    { id: 'groupCopyPath', label: 'パスをコピー', submenu: copyPathGroup },
    { separator: true },
    { id: 'rename', label: '名前の変更 (F2)', action: opts.rename, disabled: !single },
    { id: 'groupDelete', label: '削除', submenu: deleteGroup },
    { separator: true },
    { id: 'groupGit', label: 'Git', submenu: gitGroup },
    { separator: true },
    // 既定グループに属さないカスタム項目 (独自グループ / group 無し)
    ...tools.rest(),
    { separator: true },
    { id: 'properties', label: 'プロパティ', action: () => void showProperties(entry), disabled: !single },
  ];
  return pruneMenuItems(items, menuConfig);
}
