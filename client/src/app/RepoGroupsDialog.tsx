import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useSettings } from '../stores/settings';
import { toastError, useToast } from '../stores/toast';
import { useDialogKeys } from '../lib/dialogKeys';
import { baseName } from '../lib/paths';
import { moveItem } from '../lib/moveItem';
import {
  newGroupId,
  nextGroupColor,
  normalizeRepoGroups,
  REPO_GROUP_COLORS,
  textColorOn,
  type RepoGroupSettings,
} from '../lib/repoGroups';
import styles from './RepoGroupsDialog.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

interface RepoGroupsDialogStore {
  open: boolean;
  show: () => void;
  close: () => void;
}

const useRepoGroupsDialog = create<RepoGroupsDialogStore>((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));

/** 左パネルの「リポジトリ」・コマンドパレットから呼ぶ */
export function openRepoGroupsDialog(): void {
  useRepoGroupsDialog.getState().show();
}

/** 短縮名の上限 (タブの左端のチップに出すので短くする) */
const SHORT_MAX = 12;

/** 色の候補のポップアップの高さの目安 (下に収まらなければ色見本の上に出す) */
const COLOR_POPUP_HEIGHT = 90;

/** リポジトリの並び替えドラッグ。ファイルの D&D や入力欄への文字のドロップと区別する */
const REORDER_MIME = 'application/x-repo-groups-reorder';

/**
 * 登録リポジトリのグループ分け (lib/repoGroups.ts)。
 * グループ (管理用の名前と色) を作り、リポジトリごとに所属グループと短縮名を決める。
 * アプリ内タブでは、グループに属するリポジトリを開いているタブの背景をグループの色にし、左端に短縮名を出す。
 * リポジトリの行は ＝ のドラッグで並べ替えられる (左パネルの並びと同じ。保存で確定する)
 */
export function RepoGroupsDialog() {
  const { open, close } = useRepoGroupsDialog();
  const repositories = useSettings((s) => s.repositories);
  const repoLabels = useSettings((s) => s.settings.repoLabels);
  const [draft, setDraft] = useState<RepoGroupSettings>({ groups: [], repos: {} });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 色の候補を開いているグループと、開いた色見本 (候補はその下に浮かせる) */
  const [colorPick, setColorPick] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const colorPopupRef = useRef<HTMLDivElement>(null);
  const customColorRef = useRef<HTMLInputElement>(null);
  /** リポジトリの並び (下書き) */
  const [order, setOrder] = useState<string[]>([]);
  /** ドラッグ中の行と、ドロップ先の挿入位置 (元の並びでの隙間 0..length) */
  const [drag, setDrag] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(useSettings.getState().repoGroups);
    setOrder(useSettings.getState().repositories);
    setDirty(false);
    setColorPick(null);
    setDrag(null);
    setDropAt(null);
  }, [open]);

  // 色の候補は外側のクリックで閉じる。任意の色はピッカーを閉じた (確定した) ときに閉じる
  // (選んでいる間は input イベント = onChange で色を反映し続ける)
  useEffect(() => {
    if (!colorPick) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (colorPopupRef.current?.contains(t) || colorPick.anchor.contains(t)) return;
      setColorPick(null);
    };
    const onCommit = () => setColorPick(null);
    const custom = customColorRef.current;
    document.addEventListener('mousedown', onDown, true);
    custom?.addEventListener('change', onCommit);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      custom?.removeEventListener('change', onCommit);
    };
  }, [colorPick]);

  const patch = (fn: (d: RepoGroupSettings) => RepoGroupSettings) => {
    setDraft(fn);
    setDirty(true);
  };

  const labelOf = (path: string) => repoLabels[path] || baseName(path) || path;

  const addGroup = () => {
    const id = newGroupId();
    patch((d) => ({
      ...d,
      groups: [...d.groups, { id, name: `グループ ${d.groups.length + 1}`, color: nextGroupColor(d.groups) }],
    }));
  };

  const updateGroup = (id: string, p: { name?: string; color?: string }) =>
    patch((d) => ({ ...d, groups: d.groups.map((g) => (g.id === id ? { ...g, ...p } : g)) }));

  /** グループを削除する。所属していたリポジトリは未分類に戻す */
  const removeGroup = (id: string) => {
    if (colorPick?.id === id) setColorPick(null);
    patch((d) => ({
      groups: d.groups.filter((g) => g.id !== id),
      repos: Object.fromEntries(Object.entries(d.repos).filter(([, m]) => m.group !== id)),
    }));
  };

  /** 色を選んだら候補を閉じる */
  const pickColor = (id: string, color: string) => {
    updateGroup(id, { color });
    setColorPick(null);
  };

  /** 所属を変える。空文字は未分類。初めてグループに入れるときは短縮名に表示名を入れておく */
  const setRepoGroup = (path: string, group: string) =>
    patch((d) => {
      const repos = { ...d.repos };
      if (!group) delete repos[path];
      else repos[path] = { group, short: repos[path]?.short ?? labelOf(path).slice(0, SHORT_MAX) };
      return { ...d, repos };
    });

  const setRepoShort = (path: string, short: string) =>
    patch((d) => {
      const m = d.repos[path];
      return m ? { ...d, repos: { ...d.repos, [path]: { ...m, short } } } : d;
    });

  const endDrag = () => {
    setDrag(null);
    setDropAt(null);
  };

  /** マウス位置が行の上半分なら前、下半分なら後ろの隙間 */
  const gapAt = (e: React.DragEvent<HTMLDivElement>, index: number) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? index : index + 1;
  };

  /** ドラッグ元の前後の隙間は並びが変わらないので、ドロップ先にしない */
  const isMove = (gap: number) => drag !== null && gap !== drag && gap !== drag + 1;

  const doSave = async () => {
    setSaving(true);
    try {
      // 並びは開いている間に登録・解除されたリポジトリも反映する (解除分は外し、追加分は末尾へ)
      const { repositories: current, setRepositories } = useSettings.getState();
      const registered = new Set(current);
      const nextOrder = [...order.filter((p) => registered.has(p)), ...current.filter((p) => !order.includes(p))];
      if (nextOrder.some((p, i) => p !== current[i])) setRepositories(nextOrder);
      // 名前が空のグループは連番の名前にし、登録が外れたリポジトリの所属は捨てる
      const next = normalizeRepoGroups({
        groups: draft.groups.map((g, i) => ({ ...g, name: g.name.trim() || `グループ ${i + 1}` })),
        repos: Object.fromEntries(
          Object.entries(draft.repos)
            .filter(([p]) => registered.has(p))
            .map(([p, m]) => [p, { ...m, short: m.short.trim() }]),
        ),
      });
      await useSettings.getState().setRepoGroups(next);
      useToast.getState().show('success', 'リポジトリのグループを保存しました');
      close();
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  };

  const dialogRef = useDialogKeys({
    enabled: open,
    onEnter: dirty && !saving ? () => void doSave() : null,
    // 色の候補が開いていれば、Escape はそれだけを閉じる
    onEscape: colorPick ? () => setColorPick(null) : close,
  });

  if (!open) return null;

  const countOf = (id: string) => repositories.filter((p) => draft.repos[p]?.group === id).length;

  const pickingGroup = colorPick && draft.groups.find((g) => g.id === colorPick.id);
  /** 色の候補の位置: 色見本の下 (画面の下端に収まらなければ上) */
  const colorPopupPos = (() => {
    if (!colorPick) return undefined;
    const r = colorPick.anchor.getBoundingClientRect();
    return r.bottom + 4 + COLOR_POPUP_HEIGHT > window.innerHeight
      ? { left: r.left, bottom: window.innerHeight - r.top + 4 }
      : { left: r.left, top: r.bottom + 4 };
  })();

  return (
    <div ref={dialogRef} className={cx('dialog-backdrop')}>
      <div className={cx('dialog groups-dialog')}>
        <div className={cx('dialog-title')}>リポジトリのグループ</div>
        <p className={cx('groups-desc')}>
          グループに入れたリポジトリを開いているタブは、背景がグループの色になり、左端に短縮名が付きます。
          グループ名は管理用で、画面には出ません。
        </p>

        <div className={cx('groups-section-head')}>
          <span>グループ</span>
          <button className={cx('btn small')} onClick={addGroup}>
            ＋ グループを追加
          </button>
        </div>
        {/* 一覧をスクロールすると色見本の位置がずれるので、候補は閉じる */}
        <div className={cx('groups-list')} onScroll={() => setColorPick(null)}>
          {draft.groups.map((g) => (
            <div key={g.id} className={cx('group-row')}>
              <div className={cx('group-main')}>
                <button
                  className={cx(`color-swatch${colorPick?.id === g.id ? ' open' : ''}`)}
                  style={{ background: g.color }}
                  title="色を変更"
                  aria-haspopup="true"
                  aria-expanded={colorPick?.id === g.id}
                  onClick={(e) => {
                    const anchor = e.currentTarget;
                    setColorPick((c) => (c?.id === g.id ? null : { id: g.id, anchor }));
                  }}
                />
                <input
                  className={cx('dialog-input')}
                  value={g.name}
                  placeholder="グループ名"
                  onChange={(e) => updateGroup(g.id, { name: e.target.value })}
                />
                <span className={cx('group-count')}>{countOf(g.id)} 件</span>
                <button
                  className={cx('icon-btn')}
                  title="グループを削除 (所属するリポジトリは未分類に戻ります)"
                  onClick={() => removeGroup(g.id)}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
          {draft.groups.length === 0 && (
            <div className={cx('groups-empty')}>(グループがありません。「＋ グループを追加」で作成します)</div>
          )}
        </div>

        <div className={cx('groups-section-head')}>
          <span>リポジトリ</span>
        </div>
        <div className={cx('repo-table')}>
          {order.map((p, i) => {
            const m = draft.repos[p];
            const group = m && draft.groups.find((g) => g.id === m.group);
            const mark =
              drag === null || dropAt === null
                ? ''
                : dropAt === i
                  ? ' drop-before'
                  : dropAt === i + 1
                    ? ' drop-after'
                    : '';
            return (
              <div
                key={p}
                className={cx(`repo-row${drag === i ? ' dragging' : ''}${mark}`)}
                onDragOver={(e) => {
                  if (drag === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  const gap = gapAt(e, i);
                  setDropAt(isMove(gap) ? gap : null);
                }}
                onDrop={(e) => {
                  if (drag === null) return;
                  e.preventDefault();
                  const gap = gapAt(e, i);
                  if (isMove(gap)) {
                    setOrder((o) => moveItem(o, drag, gap));
                    setDirty(true);
                  }
                  endDrag();
                }}
              >
                <span
                  className={cx('drag-handle')}
                  title="ドラッグで並べ替え"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(REORDER_MIME, p);
                    e.dataTransfer.effectAllowed = 'move';
                    // つまみだけでなく行全体をドラッグの見た目にする
                    const row = e.currentTarget.parentElement;
                    if (row) e.dataTransfer.setDragImage(row, 8, row.offsetHeight / 2);
                    setDrag(i);
                  }}
                  onDragEnd={endDrag}
                >
                  ＝
                </span>
                <span className={cx('repo-name')} title={p}>
                  {labelOf(p)}
                </span>
                <select
                  className={cx('dialog-input')}
                  value={group ? group.id : ''}
                  onChange={(e) => setRepoGroup(p, e.target.value)}
                >
                  <option value="">(未分類)</option>
                  {draft.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name || '(名前なし)'}
                    </option>
                  ))}
                </select>
                <input
                  className={cx('dialog-input')}
                  value={group ? m.short : ''}
                  maxLength={SHORT_MAX}
                  placeholder={group ? '短縮名' : ''}
                  disabled={!group}
                  onChange={(e) => setRepoShort(p, e.target.value)}
                />
                {/* タブでの見え方 */}
                <span className={cx('repo-preview')}>
                  {group && m.short.trim() && (
                    <span className={cx('chip')} style={{ background: group.color, color: textColorOn(group.color) }}>
                      {m.short.trim()}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
          {order.length === 0 && <div className={cx('groups-empty')}>(登録されたリポジトリがありません)</div>}
        </div>

        {/* 色の候補 (色見本の下に浮かせる。グループ一覧のスクロール領域に切り取られないよう fixed で置く) */}
        {pickingGroup && (
          <div ref={colorPopupRef} className={cx('color-palette')} style={colorPopupPos}>
            {REPO_GROUP_COLORS.map((c) => (
              <button
                key={c.color}
                className={cx(`color-swatch${pickingGroup.color.toLowerCase() === c.color ? ' selected' : ''}`)}
                style={{ background: c.color }}
                title={c.name}
                onClick={() => pickColor(pickingGroup.id, c.color)}
              />
            ))}
            <label className={cx('color-custom')} title="任意の色">
              <input
                ref={customColorRef}
                type="color"
                value={pickingGroup.color}
                onChange={(e) => updateGroup(pickingGroup.id, { color: e.target.value })}
              />
              その他
            </label>
          </div>
        )}

        <div className={cx('dialog-buttons')}>
          <button className={cx('btn')} onClick={close}>
            キャンセル
          </button>
          <button className={cx('btn primary')} disabled={!dirty || saving} onClick={() => void doSave()}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
