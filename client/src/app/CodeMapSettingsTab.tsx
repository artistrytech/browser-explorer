import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useExplorer } from '../stores/explorer';
import { toastError, useToast } from '../stores/toast';
import { useDialogKeys } from '../lib/dialogKeys';
import type { AppSettings, LspInstanceInfo, LspPreset, LspServerDef, LspServerStatus } from '../types';
import styles from './SettingsDialog.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

const parseList = (text: string) => [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
const parseExts = (text: string) => parseList(text).map((e) => e.replace(/^\.+/, '').toLowerCase());
const parseArgs = (text: string) => text.split('\n').filter((s) => s.length > 0);

const presetToDef = (p: LspPreset): LspServerDef => ({
  id: p.id,
  label: p.label,
  extensions: [...p.extensions],
  command: p.command,
  args: [...p.args],
  rootMarkers: [...p.rootMarkers],
  enabled: true,
});

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className={cx('settings-field')}>
      <span className={cx('settings-field-label')}>{label}</span>
      {children}
    </label>
  );
}

/** 言語サーバの編集ダイアログ (設定ダイアログに重ねて表示) */
function LspServerEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: LspServerDef;
  onSave: (def: LspServerDef) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial.label);
  const [command, setCommand] = useState(initial.command);
  const [argsText, setArgsText] = useState(initial.args.join('\n'));
  const [extText, setExtText] = useState(initial.extensions.join(', '));
  const [markerText, setMarkerText] = useState(initial.rootMarkers.join(', '));
  const [enabled, setEnabled] = useState(initial.enabled);

  const save = () => {
    if (!command.trim()) {
      useToast.getState().show('error', 'コマンドを入力してください');
      return;
    }
    onSave({
      id: initial.id,
      label: label.trim() || command.trim(),
      command: command.trim(),
      args: parseArgs(argsText),
      extensions: parseExts(extText),
      rootMarkers: parseList(markerText),
      enabled,
    });
  };

  const dialogRef = useDialogKeys({ onEnter: save, onEscape: onCancel });

  return (
    <div
      ref={dialogRef}
      className={cx('dialog-backdrop nested')}
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className={cx('dialog tool-edit-dialog')} role="dialog">
        <div className={cx('dialog-title')}>言語サーバの編集</div>
        <Field label="ラベル">
          <input className={cx('dialog-input')} value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="コマンド">
          <input
            className={cx('dialog-input')}
            placeholder="typescript-language-server / 絶対パス"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
        </Field>
        <Field label="引数 (1 行 1 つ)">
          <textarea className={cx('dialog-input')} rows={3} value={argsText} onChange={(e) => setArgsText(e.target.value)} />
        </Field>
        <Field label="対象拡張子">
          <input
            className={cx('dialog-input')}
            placeholder="ts, tsx, js (カンマ区切り)"
            value={extText}
            onChange={(e) => setExtText(e.target.value)}
          />
        </Field>
        <Field label="プロジェクトの目印">
          <input
            className={cx('dialog-input')}
            placeholder="package.json, *.csproj (カンマ区切り)"
            value={markerText}
            onChange={(e) => setMarkerText(e.target.value)}
          />
        </Field>
        <Field label="使う">
          <label className={cx('inline-check')}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            この言語サーバを使う
          </label>
        </Field>
        <p className={cx('settings-hint')}>
          コマンドは PATH と、プロジェクトの node_modules/.bin から探します。引数の <code>{'${root}'}</code> は
          プロジェクトのフォルダ、<code>{'${dataDir}'}</code> は言語サーバ用の作業フォルダ (data/lsp 配下) に展開されます。
          プロジェクトのフォルダは、ファイルから近い親の「目印」のあるフォルダ (無ければ Git のリポジトリ) です。
        </p>
        <div className={cx('dialog-buttons')}>
          <button className={cx('btn primary')} onClick={save}>
            OK
          </button>
          <button className={cx('btn')} onClick={onCancel}>
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 設定画面の「コード解析」タブ: コードマップ (エディタの右クリック →「参照マップを表示」) に使う言語サーバ。
 * 拡張子ごとに上から順に、最初に当てはまる有効な言語サーバを使う。
 */
export function CodeMapSettingsTab({
  draft,
  patch,
}: {
  draft: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
}) {
  const explorerPath = useExplorer((s) => s.path);
  const [statuses, setStatuses] = useState<LspServerStatus[] | null>(null);
  const [running, setRunning] = useState<LspInstanceInfo[]>([]);
  const [presets, setPresets] = useState<LspPreset[]>([]);
  const [editing, setEditing] = useState<{ index: number; def: LspServerDef } | null>(null);

  const reload = useCallback(() => {
    api
      .codeMapServers(explorerPath)
      .then((r) => {
        setStatuses(r.servers);
        setRunning(r.running);
        setPresets(r.presets);
      })
      .catch(toastError);
  }, [explorerPath]);

  useEffect(reload, [reload]);

  const servers = draft.lspServers;
  const commit = (index: number, def: LspServerDef) => {
    patch({ lspServers: index < 0 ? [...servers, def] : servers.map((s, i) => (i === index ? def : s)) });
    setEditing(null);
  };
  const move = (i: number, dir: -1 | 1) => {
    const arr = [...servers];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    patch({ lspServers: arr });
  };

  /** 保存済みの定義でコマンドを探した結果 (未保存でコマンドを変えたものは保存後に確認する) */
  const statusText = (def: LspServerDef): { text: string; ok: boolean | null } => {
    const st = statuses?.find((s) => s.id === def.id);
    if (!statuses) return { text: '確認中…', ok: null };
    if (!st || st.command !== def.command) return { text: '保存すると確認します', ok: null };
    if (st.resolved) return { text: st.resolved, ok: true };
    return { text: `見つかりません${st.install ? ` — インストール: ${st.install}` : ''}`, ok: false };
  };

  const stop = async (body: { serverId?: string; root?: string }) => {
    try {
      await api.codeMapStop(body);
      setTimeout(reload, 500);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className={cx('tool-editor')}>
      <p className={cx('settings-hint')}>
        エディタの右クリック →「参照マップを表示」(Shift+Alt+H) で使う言語サーバ (LSP) です。
        ファイルの拡張子で、上から順に最初に当てはまる有効なものを使います。
        言語サーバが無い言語は、参照マップのタブから AI (Claude / Codex) で作れます。
      </p>
      {servers.length === 0 && <p className={cx('settings-empty')}>言語サーバがありません。</p>}
      {servers.map((def, i) => {
        const st = statusText(def);
        return (
          <div className={cx('tool-list-row')} key={def.id}>
            <label className={cx('inline-check')} title="この言語サーバを使う">
              <input
                type="checkbox"
                checked={def.enabled}
                onChange={(e) => commit(i, { ...def, enabled: e.target.checked })}
              />
            </label>
            <button className={cx('tool-list-main')} onClick={() => setEditing({ index: i, def })}>
              <span className={cx('tool-list-label')}>
                {def.label}
                {st.ok === true && <span className={cx('tool-badge')}>検出</span>}
              </span>
              <span className={cx('tool-list-sub')}>
                .{def.extensions.join(' .')} / {[def.command, ...def.args].join(' ')}
              </span>
              <span
                className={cx(`tool-list-sub${st.ok === false ? ' settings-warn' : ''}`)}
                title={st.text}
              >
                {st.text}
              </span>
            </button>
            <div className={cx('tool-list-actions')}>
              <button className={cx('btn')} title="上へ" onClick={() => move(i, -1)}>
                ▲
              </button>
              <button className={cx('btn')} title="下へ" onClick={() => move(i, 1)}>
                ▼
              </button>
              <button
                className={cx('btn danger')}
                title="削除"
                onClick={() => patch({ lspServers: servers.filter((_, idx) => idx !== i) })}
              >
                ✕
              </button>
            </div>
          </div>
        );
      })}
      <div className={cx('tool-add-row')}>
        <button
          className={cx('btn')}
          onClick={() =>
            setEditing({
              index: -1,
              def: { id: crypto.randomUUID(), label: '', extensions: [], command: '', args: [], rootMarkers: [], enabled: true },
            })
          }
        >
          + 言語サーバを追加
        </button>
        <select
          value=""
          onChange={(e) => {
            const p = presets.find((x) => x.id === e.target.value);
            if (p) setEditing({ index: -1, def: { ...presetToDef(p), id: servers.some((s) => s.id === p.id) ? crypto.randomUUID() : p.id } });
            e.target.value = '';
          }}
        >
          <option value="" disabled>
            プリセットから追加…
          </option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <button
          className={cx('btn')}
          title="一覧をプリセットの内容に戻す"
          disabled={!presets.length}
          onClick={() => patch({ lspServers: presets.map(presetToDef) })}
        >
          初期値に戻す
        </button>
        <button className={cx('btn')} title="コマンドを探し直す" onClick={reload}>
          再確認
        </button>
      </div>

      <div className={cx('settings-subtitle')}>起動中の言語サーバ</div>
      <p className={cx('settings-hint')}>
        プロジェクトごとに起動し、30 分使わないと止めます。言語サーバを入れ直したときや、結果がおかしいときは止めてください
        (次に参照マップを開いたときに起動し直します)。
      </p>
      {running.length === 0 && <p className={cx('settings-empty')}>起動中の言語サーバはありません。</p>}
      {running.map((r) => (
        <div className={cx('tool-list-row')} key={`${r.serverId}\0${r.root}`}>
          <div className={cx('tool-list-main')}>
            <span className={cx('tool-list-label')}>
              {r.label}
              {r.state === 'starting' && <span className={cx('tool-badge')}>起動中</span>}
            </span>
            <span className={cx('tool-list-sub')} title={r.root}>
              {r.root}
            </span>
            {r.progress.length > 0 && <span className={cx('tool-list-sub')}>{r.progress.join(' / ')}</span>}
          </div>
          <div className={cx('tool-list-actions')}>
            <button className={cx('btn')} onClick={() => void stop({ serverId: r.serverId, root: r.root })}>
              停止
            </button>
          </div>
        </div>
      ))}
      {running.length > 1 && (
        <div className={cx('tool-add-row')}>
          <button className={cx('btn')} onClick={() => void stop({})}>
            すべて停止
          </button>
        </div>
      )}

      {editing && (
        <LspServerEditor
          initial={editing.def}
          onSave={(def) => commit(editing.index, def)}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}
