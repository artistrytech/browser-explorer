import { useEffect, useRef, useState } from 'react';
import { useUi, refreshUiConfig } from '../stores/ui';
import { useSettings, DEFAULT_COLUMN_WIDTHS, type ModKey } from '../stores/settings';
import { api, APP_TOKEN } from '../api/client';
import { useToast, toastError } from '../stores/toast';
import { externalToolPresets, diffToolPresets } from '../lib/toolPresets';
import type { AppSettings, DiffToolDef, ExternalToolDef } from '../types';
import styles from './SettingsDialog.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

type Tab = 'general' | 'menu' | 'tools' | 'diff';

/** contextMenu の各キーと日本語ラベル */
const MENU_ITEMS: { key: string; label: string }[] = [
  { key: 'groupOpen', label: '「開く」サブメニュー' },
  { key: 'open', label: '  開く' },
  { key: 'openEditor', label: '  エディタで開く' },
  { key: 'openNewWindow', label: '  別ウィンドウで開く' },
  { key: 'osFileManager', label: '  Explorer / Finder で開く' },
  { key: 'osTerminal', label: '  コマンドプロンプト / ターミナルで開く' },
  { key: 'pin', label: 'クイックアクセスにピン止め / 解除' },
  { key: 'copy', label: 'コピー' },
  { key: 'cut', label: '切り取り' },
  { key: 'paste', label: '貼り付け' },
  { key: 'rename', label: '名前の変更 (F2)' },
  { key: 'groupDelete', label: '「削除」サブメニュー' },
  { key: 'delete', label: '  ゴミ箱に移動' },
  { key: 'deletePermanent', label: '  完全に削除' },
  { key: 'groupGit', label: '「Git」サブメニュー' },
  { key: 'gitLog', label: '  Git ログ' },
  { key: 'resolveConflict', label: '  競合を解消…' },
  { key: 'gitClone', label: '  Git Clone…' },
  { key: 'gitStage', label: '  ステージ' },
  { key: 'gitUnstage', label: '  ステージ解除' },
  { key: 'gitDiscard', label: '  変更を破棄' },
  { key: 'properties', label: 'プロパティ' },
  { key: 'newFolder', label: '新規フォルダ (空白右クリック)' },
  { key: 'newFile', label: '新規ファイル (空白右クリック)' },
  { key: 'refresh', label: '最新の情報に更新 (空白右クリック)' },
];

const normExt = (s: string) => s.trim().replace(/^\.+/, '').toLowerCase();
const parseExts = (text: string) => [...new Set(text.split(/[\s,]+/).map(normExt).filter(Boolean))];
const parseArgs = (text: string) => text.split('\n').filter((s) => s.length > 0);

/** ラベル + コントロールを 2 カラムグリッドで揃えて並べる */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className={cx("settings-field")}>
      <span className={cx("settings-field-label")}>{label}</span>
      {children}
    </label>
  );
}

/** 外部ツールの編集ダイアログ (設定ダイアログに重ねて表示) */
function ExternalToolEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: ExternalToolDef;
  onSave: (tool: ExternalToolDef) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial.label);
  const [command, setCommand] = useState(initial.command);
  const [argsText, setArgsText] = useState((initial.args ?? []).join('\n'));
  const [group, setGroup] = useState(initial.group ?? '');
  const [kind, setKind] = useState<'file' | 'dir' | 'any'>(initial.kind ?? 'any');
  const [extText, setExtText] = useState((initial.extensions ?? []).join(', '));
  const [confirm, setConfirm] = useState(initial.confirm === true);

  const save = () => {
    const exts = parseExts(extText);
    const args = parseArgs(argsText);
    onSave({
      id: initial.id,
      label: label.trim() || '(無題)',
      command: command.trim(),
      ...(args.length ? { args } : {}),
      ...(group.trim() ? { group: group.trim() } : {}),
      kind,
      ...(exts.length ? { extensions: exts } : {}),
      ...(confirm ? { confirm: true } : {}),
    });
  };

  return (
    <div className={cx("dialog-backdrop nested")} onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className={cx("dialog tool-edit-dialog")} role="dialog">
        <div className={cx("dialog-title")}>外部ツールの編集</div>
        <Field label="ラベル">
          <input className={cx("dialog-input")} value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="コマンド">
          <input
            className={cx("dialog-input")}
            placeholder="notepad.exe / 絶対パス"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
        </Field>
        <Field label="引数 (1 行 1 つ)">
          <textarea className={cx("dialog-input")} rows={3} value={argsText} onChange={(e) => setArgsText(e.target.value)} />
        </Field>
        <Field label="グループ">
          <input
            className={cx("dialog-input")}
            placeholder="開く / 削除 / Git / 任意名 (空=直下)"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          />
        </Field>
        <Field label="対象種別">
          <select value={kind} onChange={(e) => setKind(e.target.value as 'file' | 'dir' | 'any')}>
            <option value="any">両方</option>
            <option value="file">ファイルのみ</option>
            <option value="dir">フォルダのみ</option>
          </select>
        </Field>
        <Field label="対象拡張子">
          <input
            className={cx("dialog-input")}
            placeholder="sh, bat, png (カンマ区切り・空=全部)"
            value={extText}
            onChange={(e) => setExtText(e.target.value)}
          />
        </Field>
        <Field label="起動前に確認">
          <label className={cx("inline-check")}>
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            確認ダイアログを出す
          </label>
        </Field>
        <p className={cx("settings-hint")}>
          args の <code>{'${paths}'}</code> が選択パスに展開されます (無ければ末尾に追加)。
        </p>
        <div className={cx("dialog-buttons")}>
          <button className={cx("btn primary")} onClick={save}>
            OK
          </button>
          <button className={cx("btn")} onClick={onCancel}>
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}

/** 差分ツールの編集ダイアログ */
function DiffToolEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: DiffToolDef;
  onSave: (tool: DiffToolDef) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial.label);
  const [command, setCommand] = useState(initial.command);
  const [argsText, setArgsText] = useState((initial.args ?? []).join('\n'));
  const [isDefault, setIsDefault] = useState(initial.default === true);

  const save = () => {
    const args = parseArgs(argsText);
    onSave({
      id: initial.id,
      label: label.trim() || '(無題)',
      command: command.trim(),
      ...(args.length ? { args } : {}),
      ...(isDefault ? { default: true } : {}),
    });
  };

  return (
    <div className={cx("dialog-backdrop nested")} onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className={cx("dialog tool-edit-dialog")} role="dialog">
        <div className={cx("dialog-title")}>差分ツールの編集</div>
        <Field label="ラベル">
          <input className={cx("dialog-input")} value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="コマンド">
          <input
            className={cx("dialog-input")}
            placeholder="絶対パス推奨"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
        </Field>
        <Field label="引数 (1 行 1 つ)">
          <textarea className={cx("dialog-input")} rows={4} value={argsText} onChange={(e) => setArgsText(e.target.value)} />
        </Field>
        <Field label="既定にする">
          <label className={cx("inline-check")}>
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            ダブルクリック時にこのツールで開く
          </label>
        </Field>
        <p className={cx("settings-hint")}>
          args の <code>{'${left}'}</code> / <code>{'${right}'}</code> が比較対象、
          <code>{'${leftTitle}'}</code> / <code>{'${rightTitle}'}</code> が見出しに展開されます。
        </p>
        <div className={cx("dialog-buttons")}>
          <button className={cx("btn primary")} onClick={save}>
            OK
          </button>
          <button className={cx("btn")} onClick={onCancel}>
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const { settingsOpen, setSettingsOpen } = useUi();
  const { settings, update, load } = useSettings();
  const platform = useUi((s) => s.platform);
  const fileRef = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<Tab>('general');
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [extRows, setExtRows] = useState<{ ext: string; toolId: string }[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // 重ねて開く編集ダイアログ (index -1 = 新規追加)
  const [editingTool, setEditingTool] = useState<{ index: number; tool: ExternalToolDef } | null>(null);
  const [editingDiff, setEditingDiff] = useState<{ index: number; tool: DiffToolDef } | null>(null);

  useEffect(() => {
    if (!settingsOpen) return;
    setDirty(false);
    setEditingTool(null);
    setEditingDiff(null);
    api
      .getSettings()
      .then((s) => {
        setDraft(s);
        setExtRows(Object.entries(s.extDefaults).map(([ext, toolId]) => ({ ext, toolId })));
      })
      .catch((e) => {
        setDraft(null);
        toastError(e);
      });
  }, [settingsOpen]);

  if (!settingsOpen) return null;

  const patch = (p: Partial<AppSettings>) => {
    setDraft((d) => (d ? { ...d, ...p } : d));
    setDirty(true);
  };

  const doSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const extDefaults: Record<string, string> = {};
      for (const { ext, toolId } of extRows) {
        const e = normExt(ext);
        if (e && toolId) extDefaults[e] = toolId;
      }
      const saved = await api.putSettings({ ...draft, extDefaults });
      setDraft(saved);
      setExtRows(Object.entries(saved.extDefaults).map(([ext, toolId]) => ({ ext, toolId })));
      setDirty(false);
      await refreshUiConfig(); // 再起動なしでメニュー等に即時反映
      useToast.getState().show('success', '設定を保存しました');
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  };

  const doExport = async () => {
    try {
      const res = await fetch('/api/state/export', { headers: { 'x-app-token': APP_TOKEN } });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'explorer-state.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toastError(e);
    }
  };

  const doImport = async (file: File) => {
    try {
      const json = JSON.parse(await file.text());
      await api.importState(json);
      await load();
      await refreshUiConfig();
      const fresh = await api.getSettings();
      setDraft(fresh);
      setExtRows(Object.entries(fresh.extDefaults).map(([ext, toolId]) => ({ ext, toolId })));
      setDirty(false);
      useToast.getState().show('success', '設定をインポートしました');
    } catch (e) {
      toastError(e);
    }
  };

  const row = (label: string, control: React.ReactNode) => (
    <div className={cx("settings-row")}>
      <span className={cx("settings-label")}>{label}</span>
      {control}
    </div>
  );

  // --- 外部ツール ---
  const commitTool = (index: number, tool: ExternalToolDef) => {
    if (!draft) return;
    const externalTools =
      index < 0 ? [...draft.externalTools, tool] : draft.externalTools.map((t, i) => (i === index ? tool : t));
    patch({ externalTools });
    setEditingTool(null);
  };
  const removeTool = (i: number) => {
    if (!draft) return;
    patch({ externalTools: draft.externalTools.filter((_, idx) => idx !== i) });
  };
  const moveTool = (i: number, dir: -1 | 1) => {
    if (!draft) return;
    const arr = [...draft.externalTools];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    patch({ externalTools: arr });
  };

  // --- 差分ツール ---
  const commitDiff = (index: number, tool: DiffToolDef) => {
    if (!draft) return;
    let diffTools =
      index < 0 ? [...draft.diffTools, tool] : draft.diffTools.map((t, i) => (i === index ? tool : t));
    if (tool.default) diffTools = diffTools.map((t) => (t.id === tool.id ? t : { ...t, default: false }));
    patch({ diffTools });
    setEditingDiff(null);
  };
  const removeDiff = (i: number) => {
    if (!draft) return;
    patch({ diffTools: draft.diffTools.filter((_, idx) => idx !== i) });
  };

  // --- 拡張子ごとの既定ツール (ローカル配列で編集し、保存時に record 化) ---
  const updateExtRow = (i: number, p: Partial<{ ext: string; toolId: string }>) => {
    setExtRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
    setDirty(true);
  };
  const addExtRow = () => {
    setExtRows((rows) => [...rows, { ext: '', toolId: '' }]);
    setDirty(true);
  };
  const removeExtRow = (i: number) => {
    setExtRows((rows) => rows.filter((_, idx) => idx !== i));
    setDirty(true);
  };

  const toolSummary = (t: ExternalToolDef) => {
    const parts = [t.command || '(コマンド未設定)'];
    if (t.kind && t.kind !== 'any') parts.push(t.kind === 'dir' ? 'フォルダ' : 'ファイル');
    if (t.extensions?.length) parts.push('.' + t.extensions.join(' .'));
    if (t.group) parts.push('→' + t.group);
    if (t.confirm) parts.push('確認');
    return parts.join(' / ');
  };

  const tabBtn = (id: Tab, label: string) => (
    <button className={cx(`settings-tab${tab === id ? ' active' : ''}`)} onClick={() => setTab(id)}>
      {label}
    </button>
  );

  return (
    <div className={cx("dialog-backdrop")} onMouseDown={(e) => e.target === e.currentTarget && setSettingsOpen(false)}>
      <div className={cx("dialog settings-dialog")} role="dialog">
        <div className={cx("dialog-title")}>設定</div>

        <div className={cx("settings-tabs")}>
          {tabBtn('general', '一般')}
          {tabBtn('menu', 'コンテキストメニュー')}
          {tabBtn('tools', '外部ツール')}
          {tabBtn('diff', '差分ツール')}
        </div>

        <div className={cx("settings-body")}>
          {tab === 'general' && (
            <>
              {row(
                'キーバインド基準',
                <select value={settings.modKey} onChange={(e) => update({ modKey: e.target.value as ModKey })}>
                  <option value="auto">自動 (既定) — Mac は ⌘、他は Ctrl</option>
                  <option value="ctrl">Ctrl 基準</option>
                  <option value="meta">⌘ 基準</option>
                </select>,
              )}
              {row(
                '表示モード',
                <select
                  value={settings.viewMode}
                  onChange={(e) => update({ viewMode: e.target.value as typeof settings.viewMode })}
                >
                  <option value="details">詳細 (既定)</option>
                  <option value="list">一覧</option>
                  <option value="icons">大アイコン</option>
                </select>,
              )}
              {row(
                '一覧のカラム幅',
                <button className={cx("btn")} onClick={() => update({ columnWidths: DEFAULT_COLUMN_WIDTHS })}>
                  既定に戻す
                </button>,
              )}
              {row(
                '隠しファイル',
                <label>
                  <input
                    type="checkbox"
                    checked={settings.showHidden}
                    onChange={(e) => update({ showHidden: e.target.checked })}
                  />
                  表示する
                </label>,
              )}
              {row(
                'テーマ',
                <select value={settings.theme} onChange={(e) => update({ theme: e.target.value as 'light' | 'dark' })}>
                  <option value="light">ライト</option>
                  <option value="dark">ダーク</option>
                </select>,
              )}
              {row(
                'エディタ フォントサイズ',
                <input
                  type="number"
                  min={10}
                  max={28}
                  value={settings.fontSize}
                  onChange={(e) => update({ fontSize: Number(e.target.value) || 14 })}
                />,
              )}
              {row(
                '折り返し',
                <label>
                  <input
                    type="checkbox"
                    checked={settings.wordWrap}
                    onChange={(e) => update({ wordWrap: e.target.checked })}
                  />
                  有効
                </label>,
              )}
              {row(
                '既定エンコーディング',
                <select value={settings.defaultEncoding} onChange={(e) => update({ defaultEncoding: e.target.value })}>
                  {['UTF-8', 'Shift_JIS', 'EUC-JP'].map((enc) => (
                    <option key={enc}>{enc}</option>
                  ))}
                </select>,
              )}
              {draft &&
                row(
                  'コミット変更ファイルの表示上限',
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    value={draft.commitFilesLimit}
                    onChange={(e) => patch({ commitFilesLimit: Number(e.target.value) || 100 })}
                  />,
                )}
            </>
          )}

          {tab === 'menu' && (
            <div>
              <p className={cx("settings-hint")}>チェックを外した項目はコンテキストメニューに表示されません。</p>
              {draft &&
                MENU_ITEMS.map(({ key, label }) => (
                  <label key={key} className={cx("settings-check-row")}>
                    <input
                      type="checkbox"
                      checked={draft.contextMenu[key] !== false}
                      onChange={(e) => patch({ contextMenu: { ...draft.contextMenu, [key]: e.target.checked } })}
                    />
                    {label}
                  </label>
                ))}
            </div>
          )}

          {tab === 'tools' && draft && (
            <div className={cx("tool-editor")}>
              <p className={cx("settings-hint")}>
                コンテキストメニューから起動するツール。行をクリックすると編集ダイアログを開きます。
              </p>
              {draft.externalTools.length === 0 && <p className={cx("settings-empty")}>ツールがありません。</p>}
              {draft.externalTools.map((t, i) => (
                <div className={cx("tool-list-row")} key={t.id}>
                  <button className={cx("tool-list-main")} onClick={() => setEditingTool({ index: i, tool: t })}>
                    <span className={cx("tool-list-label")}>{t.label || '(無題)'}</span>
                    <span className={cx("tool-list-sub")}>{toolSummary(t)}</span>
                  </button>
                  <div className={cx("tool-list-actions")}>
                    <button className={cx("btn")} title="上へ" onClick={() => moveTool(i, -1)}>
                      ▲
                    </button>
                    <button className={cx("btn")} title="下へ" onClick={() => moveTool(i, 1)}>
                      ▼
                    </button>
                    <button className={cx("btn danger")} title="削除" onClick={() => removeTool(i)}>
                      ✕
                    </button>
                  </div>
                </div>
              ))}

              <div className={cx("tool-add-row")}>
                <button
                  className={cx("btn")}
                  onClick={() =>
                    setEditingTool({ index: -1, tool: { id: crypto.randomUUID(), label: '新しいツール', command: '', kind: 'any' } })
                  }
                >
                  + ツールを追加
                </button>
                <select
                  value=""
                  onChange={(e) => {
                    const idx = Number(e.target.value);
                    const p = externalToolPresets(platform)[idx];
                    if (p) setEditingTool({ index: -1, tool: { id: crypto.randomUUID(), ...p } });
                    e.target.value = '';
                  }}
                >
                  <option value="" disabled>
                    プリセットから追加…
                  </option>
                  {externalToolPresets(platform).map((p, idx) => (
                    <option key={p.label} value={idx}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className={cx("settings-subtitle")}>拡張子ごとの既定ツール (ダブルクリック / Enter)</div>
              <p className={cx("settings-hint")}>
                設定した拡張子のファイルは、ダブルクリック時にそのツールで開きます (未設定はアプリ内エディタ)。
              </p>
              {extRows.map((r, i) => (
                <div className={cx("ext-default-row")} key={i}>
                  <input
                    className={cx("dialog-input ext-input")}
                    placeholder="png"
                    value={r.ext}
                    onChange={(e) => updateExtRow(i, { ext: e.target.value })}
                  />
                  <select value={r.toolId} onChange={(e) => updateExtRow(i, { toolId: e.target.value })}>
                    <option value="">ツールを選択…</option>
                    {!draft.externalTools.some((t) => t.id === r.toolId) && r.toolId && (
                      <option value={r.toolId}>(不明なツール)</option>
                    )}
                    {draft.externalTools.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label || '(無題)'}
                      </option>
                    ))}
                  </select>
                  <button className={cx("btn danger")} title="削除" onClick={() => removeExtRow(i)}>
                    ✕
                  </button>
                </div>
              ))}
              <div className={cx("tool-add-row")}>
                <button className={cx("btn")} onClick={addExtRow}>
                  + 拡張子を追加
                </button>
              </div>
            </div>
          )}

          {tab === 'diff' && draft && (
            <div className={cx("tool-editor")}>
              <p className={cx("settings-hint")}>
                差分表示に使う外部ツール (WinMerge / Meld / VS Code など)。行をクリックすると編集ダイアログを開きます。
              </p>
              {draft.diffTools.length === 0 && <p className={cx("settings-empty")}>ツールがありません。</p>}
              {draft.diffTools.map((t, i) => (
                <div className={cx("tool-list-row")} key={t.id}>
                  <button className={cx("tool-list-main")} onClick={() => setEditingDiff({ index: i, tool: t })}>
                    <span className={cx("tool-list-label")}>
                      {t.label || '(無題)'}
                      {t.default && <span className={cx("tool-badge")}>既定</span>}
                    </span>
                    <span className={cx("tool-list-sub")}>{t.command || '(コマンド未設定)'}</span>
                  </button>
                  <div className={cx("tool-list-actions")}>
                    <button className={cx("btn danger")} title="削除" onClick={() => removeDiff(i)}>
                      ✕
                    </button>
                  </div>
                </div>
              ))}
              <div className={cx("tool-add-row")}>
                <button
                  className={cx("btn")}
                  onClick={() =>
                    setEditingDiff({ index: -1, tool: { id: crypto.randomUUID(), label: '新しい差分ツール', command: '' } })
                  }
                >
                  + ツールを追加
                </button>
                <select
                  value=""
                  onChange={(e) => {
                    const idx = Number(e.target.value);
                    const p = diffToolPresets(platform)[idx];
                    if (p) setEditingDiff({ index: -1, tool: { id: crypto.randomUUID(), ...p } });
                    e.target.value = '';
                  }}
                >
                  <option value="" disabled>
                    プリセットから追加…
                  </option>
                  {diffToolPresets(platform).map((p, idx) => (
                    <option key={p.label} value={idx}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>

        <div className={cx("settings-row")}>
          <span className={cx("settings-label")}>エクスポート / インポート</span>
          <span>
            <button className={cx("btn")} onClick={() => void doExport()}>
              エクスポート
            </button>{' '}
            <button className={cx("btn")} onClick={() => fileRef.current?.click()}>
              インポート
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void doImport(f);
                e.target.value = '';
              }}
            />
          </span>
        </div>

        <div className={cx("dialog-buttons")}>
          {dirty && <span className={cx("settings-dirty")}>未保存の変更があります</span>}
          <button className={cx("btn primary")} onClick={() => void doSave()} disabled={!dirty || saving}>
            {saving ? '保存中…' : '保存'}
          </button>
          <button className={cx("btn")} onClick={() => setSettingsOpen(false)}>
            閉じる
          </button>
        </div>
      </div>

      {editingTool && (
        <ExternalToolEditor
          initial={editingTool.tool}
          onSave={(tool) => commitTool(editingTool.index, tool)}
          onCancel={() => setEditingTool(null)}
        />
      )}
      {editingDiff && (
        <DiffToolEditor
          initial={editingDiff.tool}
          onSave={(tool) => commitDiff(editingDiff.index, tool)}
          onCancel={() => setEditingDiff(null)}
        />
      )}
    </div>
  );
}
