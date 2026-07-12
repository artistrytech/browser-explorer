import { useRef } from 'react';
import { useUi } from '../stores/ui';
import { useSettings, DEFAULT_COLUMN_WIDTHS, type ModKey } from '../stores/settings';
import { api, APP_TOKEN } from '../api/client';
import { useToast, toastError } from '../stores/toast';

export function SettingsDialog() {
  const { settingsOpen, setSettingsOpen } = useUi();
  const { settings, update, load } = useSettings();
  const fileRef = useRef<HTMLInputElement>(null);

  if (!settingsOpen) return null;

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

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setSettingsOpen(false)}>
      <div className="dialog settings-dialog" role="dialog">
        <div className="dialog-title">設定</div>

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
          <select
            value={settings.theme}
            onChange={(e) => update({ theme: e.target.value as 'light' | 'dark' })}
          >
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
          <select
            value={settings.defaultEncoding}
            onChange={(e) => update({ defaultEncoding: e.target.value })}
          >
            {['UTF-8', 'Shift_JIS', 'EUC-JP'].map((enc) => (
              <option key={enc}>{enc}</option>
            ))}
          </select>,
        )}

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
          <button className="btn primary" onClick={() => setSettingsOpen(false)}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
