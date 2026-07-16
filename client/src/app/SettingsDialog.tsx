import { useEffect, useRef, useState } from 'react';
import { useUi, refreshUiConfig } from '../stores/ui';
import { useSettings, DEFAULT_COLUMN_WIDTHS, type ModKey } from '../stores/settings';
import { api, APP_TOKEN } from '../api/client';
import { useToast, toastError } from '../stores/toast';
import { externalToolPresets, diffToolPresets } from '../lib/toolPresets';
import type { AppSettings, DiffToolDef, ExternalToolDef } from '../types';

type Tab = 'general' | 'menu' | 'tools' | 'diff';

/** contextMenu の各キーと日本語ラベル (config.jsonc のコメントが対応表) */
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

export function SettingsDialog() {
  const { settingsOpen, setSettingsOpen } = useUi();
  const { settings, update, load } = useSettings();
  const platform = useUi((s) => s.platform);
  const fileRef = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<Tab>('general');
  // サーバ設定 (commitFilesLimit / contextMenu / externalTools / diffTools / extDefaults) の編集ドラフト
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // 拡張子ごとの既定ツール追加フォームの入力値 (フックは早期 return より前で宣言する)
  const [newExt, setNewExt] = useState('');
  const [newExtTool, setNewExtTool] = useState('');

  useEffect(() => {
    if (!settingsOpen) return;
    setDirty(false);
    api
      .getSettings()
      .then(setDraft)
      .catch((e) => {
        setDraft(null);
        toastError(e);
      });
  }, [settingsOpen]);

  if (!settingsOpen) return null;

  /** ドラフトを一部更新 (dirty を立てる) */
  const patch = (p: Partial<AppSettings>) => {
    setDraft((d) => (d ? { ...d, ...p } : d));
    setDirty(true);
  };

  const doSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const saved = await api.putSettings(draft);
      setDraft(saved);
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
      setDirty(false);
      useToast.getState().show('success', '設定をインポートしました');
    } catch (e) {
      toastError(e);
    }
  };

  const row = (label: string, control: React.ReactNode) => (
    <div className="settings-row">
      <span className="settings-label">{label}</span>
      {control}
    </div>
  );

  // --- 外部ツール編集 ---
  const updateTool = (i: number, p: Partial<ExternalToolDef>) => {
    if (!draft) return;
    const externalTools = draft.externalTools.map((t, idx) => (idx === i ? { ...t, ...p } : t));
    patch({ externalTools });
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
  const addTool = (preset?: Omit<ExternalToolDef, 'id'>) => {
    if (!draft) return;
    const id = crypto.randomUUID();
    const tool: ExternalToolDef = preset
      ? { id, ...preset }
      : { id, label: '新しいツール', command: '', kind: 'any' };
    patch({ externalTools: [...draft.externalTools, tool] });
  };

  // --- 差分ツール編集 ---
  const updateDiff = (i: number, p: Partial<DiffToolDef>) => {
    if (!draft) return;
    let diffTools = draft.diffTools.map((t, idx) => (idx === i ? { ...t, ...p } : t));
    // default は 1 つだけ
    if (p.default) diffTools = diffTools.map((t, idx) => (idx === i ? t : { ...t, default: false }));
    patch({ diffTools });
  };
  const removeDiff = (i: number) => {
    if (!draft) return;
    patch({ diffTools: draft.diffTools.filter((_, idx) => idx !== i) });
  };
  const addDiff = (preset?: Omit<DiffToolDef, 'id'>) => {
    if (!draft) return;
    const id = crypto.randomUUID();
    const tool: DiffToolDef = preset ? { id, ...preset } : { id, label: '新しい差分ツール', command: '' };
    patch({ diffTools: [...draft.diffTools, tool] });
  };

  // --- 拡張子ごとの既定ツール (extDefaults) ---
  const extRows = draft ? Object.entries(draft.extDefaults) : [];
  const setExtRow = (oldExt: string, newExt: string, toolId: string) => {
    if (!draft) return;
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(draft.extDefaults)) if (k !== oldExt) map[k] = v;
    const e = normExt(newExt);
    if (e && toolId) map[e] = toolId;
    patch({ extDefaults: map });
  };
  const removeExtRow = (ext: string) => {
    if (!draft) return;
    const map = { ...draft.extDefaults };
    delete map[ext];
    patch({ extDefaults: map });
  };
  const addExtRow = () => {
    if (!draft) return;
    const e = normExt(newExt);
    if (!e || !newExtTool) return;
    patch({ extDefaults: { ...draft.extDefaults, [e]: newExtTool } });
    setNewExt('');
    setNewExtTool('');
  };

  const tabBtn = (id: Tab, label: string) => (
    <button className={`settings-tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
      {label}
    </button>
  );

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setSettingsOpen(false)}>
      <div className="dialog settings-dialog" role="dialog">
        <div className="dialog-title">設定</div>

        <div className="settings-tabs">
          {tabBtn('general', '一般')}
          {tabBtn('menu', 'コンテキストメニュー')}
          {tabBtn('tools', '外部ツール')}
          {tabBtn('diff', '差分ツール')}
        </div>

        <div className="settings-body">
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
                <button className="btn" onClick={() => update({ columnWidths: DEFAULT_COLUMN_WIDTHS })}>
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
            <div className="settings-hint-wrap">
              <p className="settings-hint">チェックを外した項目はコンテキストメニューに表示されません。</p>
              {draft &&
                MENU_ITEMS.map(({ key, label }) => (
                  <label key={key} className="settings-check-row">
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
            <div className="tool-editor">
              <p className="settings-hint">
                コンテキストメニューから起動するツール。args の <code>{'${paths}'}</code> が選択パスに展開されます
                (無ければ末尾に追加)。対象種別/拡張子を指定するとその条件のときだけメニューに表示します。
              </p>
              {draft.externalTools.map((t, i) => (
                <div className="tool-card" key={t.id}>
                  <div className="tool-card-head">
                    <input
                      className="dialog-input"
                      placeholder="ラベル"
                      value={t.label}
                      onChange={(e) => updateTool(i, { label: e.target.value })}
                    />
                    <div className="tool-card-actions">
                      <button className="btn" title="上へ" onClick={() => moveTool(i, -1)}>
                        ▲
                      </button>
                      <button className="btn" title="下へ" onClick={() => moveTool(i, 1)}>
                        ▼
                      </button>
                      <button className="btn danger" title="削除" onClick={() => removeTool(i)}>
                        ✕
                      </button>
                    </div>
                  </div>
                  {row(
                    'コマンド',
                    <input
                      className="dialog-input"
                      placeholder="notepad.exe / 絶対パス"
                      value={t.command}
                      onChange={(e) => updateTool(i, { command: e.target.value })}
                    />,
                  )}
                  {row(
                    '引数 (1 行 1 つ)',
                    <textarea
                      className="dialog-input"
                      rows={2}
                      value={(t.args ?? []).join('\n')}
                      onChange={(e) =>
                        updateTool(i, { args: e.target.value.split('\n').filter((s) => s.length > 0) })
                      }
                    />,
                  )}
                  {row(
                    'グループ',
                    <input
                      className="dialog-input"
                      placeholder="開く / 削除 / Git / 任意名 (空=直下)"
                      value={t.group ?? ''}
                      onChange={(e) => updateTool(i, { group: e.target.value || undefined })}
                    />,
                  )}
                  {row(
                    '対象種別',
                    <select value={t.kind ?? 'any'} onChange={(e) => updateTool(i, { kind: e.target.value as ExternalToolDef['kind'] })}>
                      <option value="any">両方</option>
                      <option value="file">ファイルのみ</option>
                      <option value="dir">フォルダのみ</option>
                    </select>,
                  )}
                  {row(
                    '対象拡張子 (カンマ区切り・空=全部)',
                    <input
                      className="dialog-input"
                      placeholder="sh, bat, png"
                      value={(t.extensions ?? []).join(', ')}
                      onChange={(e) =>
                        updateTool(i, {
                          extensions: e.target.value
                            .split(/[\s,]+/)
                            .map(normExt)
                            .filter(Boolean),
                        })
                      }
                    />,
                  )}
                  {row(
                    '起動前に確認',
                    <label>
                      <input
                        type="checkbox"
                        checked={t.confirm === true}
                        onChange={(e) => updateTool(i, { confirm: e.target.checked })}
                      />
                      確認ダイアログを出す
                    </label>,
                  )}
                </div>
              ))}

              <div className="tool-add-row">
                <button className="btn" onClick={() => addTool()}>
                  + 空のツールを追加
                </button>
                <select
                  defaultValue=""
                  onChange={(e) => {
                    const idx = Number(e.target.value);
                    const presets = externalToolPresets(platform);
                    if (presets[idx]) addTool(presets[idx]);
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

              <div className="settings-subtitle">拡張子ごとの既定ツール (ダブルクリック / Enter)</div>
              <p className="settings-hint">
                設定した拡張子のファイルは、ダブルクリック時にそのツールで開きます (未設定はアプリ内エディタ)。
              </p>
              {extRows.map(([ext, toolId]) => (
                <div className="ext-default-row" key={ext}>
                  <input
                    className="dialog-input ext-input"
                    value={ext}
                    onChange={(e) => setExtRow(ext, e.target.value, toolId)}
                  />
                  <select value={toolId} onChange={(e) => setExtRow(ext, ext, e.target.value)}>
                    {!draft.externalTools.some((t) => t.id === toolId) && <option value={toolId}>(不明なツール)</option>}
                    {draft.externalTools.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <button className="btn danger" onClick={() => removeExtRow(ext)}>
                    ✕
                  </button>
                </div>
              ))}
              <div className="ext-default-row">
                <input
                  className="dialog-input ext-input"
                  placeholder="png"
                  value={newExt}
                  onChange={(e) => setNewExt(e.target.value)}
                />
                <select value={newExtTool} onChange={(e) => setNewExtTool(e.target.value)}>
                  <option value="">ツールを選択…</option>
                  {draft.externalTools.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <button className="btn" onClick={addExtRow} disabled={!normExt(newExt) || !newExtTool}>
                  追加
                </button>
              </div>
            </div>
          )}

          {tab === 'diff' && draft && (
            <div className="tool-editor">
              <p className="settings-hint">
                差分表示に使う外部ツール。args の <code>{'${left}'}</code> / <code>{'${right}'}</code> が比較対象、
                <code>{'${leftTitle}'}</code> / <code>{'${rightTitle}'}</code> が見出しに展開されます。
                「既定」にするとファイルのダブルクリックでそのツールが開きます。
              </p>
              {draft.diffTools.map((t, i) => (
                <div className="tool-card" key={t.id}>
                  <div className="tool-card-head">
                    <input
                      className="dialog-input"
                      placeholder="ラベル"
                      value={t.label}
                      onChange={(e) => updateDiff(i, { label: e.target.value })}
                    />
                    <div className="tool-card-actions">
                      <label className="diff-default-label">
                        <input
                          type="checkbox"
                          checked={t.default === true}
                          onChange={(e) => updateDiff(i, { default: e.target.checked })}
                        />
                        既定
                      </label>
                      <button className="btn danger" title="削除" onClick={() => removeDiff(i)}>
                        ✕
                      </button>
                    </div>
                  </div>
                  {row(
                    'コマンド',
                    <input
                      className="dialog-input"
                      placeholder="絶対パス推奨"
                      value={t.command}
                      onChange={(e) => updateDiff(i, { command: e.target.value })}
                    />,
                  )}
                  {row(
                    '引数 (1 行 1 つ)',
                    <textarea
                      className="dialog-input"
                      rows={2}
                      value={(t.args ?? []).join('\n')}
                      onChange={(e) =>
                        updateDiff(i, { args: e.target.value.split('\n').filter((s) => s.length > 0) })
                      }
                    />,
                  )}
                </div>
              ))}
              <div className="tool-add-row">
                <button className="btn" onClick={() => addDiff()}>
                  + 空のツールを追加
                </button>
                <select
                  defaultValue=""
                  onChange={(e) => {
                    const idx = Number(e.target.value);
                    const presets = diffToolPresets(platform);
                    if (presets[idx]) addDiff(presets[idx]);
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

        <div className="settings-row">
          <span className="settings-label">エクスポート / インポート</span>
          <span>
            <button className="btn" onClick={() => void doExport()}>
              エクスポート
            </button>{' '}
            <button className="btn" onClick={() => fileRef.current?.click()}>
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

        <div className="dialog-buttons">
          {dirty && <span className="settings-dirty">未保存の変更があります</span>}
          <button className="btn primary" onClick={() => void doSave()} disabled={!dirty || saving}>
            {saving ? '保存中…' : '保存'}
          </button>
          <button className="btn" onClick={() => setSettingsOpen(false)}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
