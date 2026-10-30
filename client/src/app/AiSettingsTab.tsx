import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { toastError } from '../stores/toast';
import type { AiAgentInfo, AiAgent, AppSettings, CodexModelInfo } from '../types';
import styles from './SettingsDialog.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';
import { permissionLabel } from '../features/aichat/aiPermissions';

const cx = createCssModuleClassNames(styles);

/** Claude のモデル系列の候補 (入力サポート用。ここに無い系列も入力できる) */
const CLAUDE_SERIES = ['fable', 'opus', 'sonnet', 'haiku'];

const CODEX_SANDBOXES: AppSettings['aiCodexSandbox'][] = ['read-only', 'workspace-write', 'danger-full-access'];
const CLAUDE_PERMISSIONS: AppSettings['aiClaudePermission'][] = [
  'acceptEdits',
  'auto',
  'plan',
  'dontAsk',
  'manual',
  'bypassPermissions',
];

/** 1 行 1 つのモデル名 (入力途中の空行も保つため、ここでは整えない。保存時にサーバで正規化する) */
const toLines = (text: string) => text.split('\n');

/** 設定画面の「AI」タブ: AI チャットで選べるモデル名と、実行時の権限 */
export function AiSettingsTab({
  draft,
  patch,
}: {
  draft: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
}) {
  const [agents, setAgents] = useState<Record<AiAgent, AiAgentInfo> | null>(null);
  const [codexModels, setCodexModels] = useState<CodexModelInfo[] | null>(null);
  const [loadingCodex, setLoadingCodex] = useState(false);
  const [series, setSeries] = useState('opus');
  const [major, setMajor] = useState('');
  const [minor, setMinor] = useState('');

  useEffect(() => {
    api
      .aiAgents(true)
      .then((r) => setAgents(r.agents))
      .catch(() => {});
  }, []);

  const setModels = (agent: AiAgent, list: string[]) => patch({ aiModels: { ...draft.aiModels, [agent]: list } });

  /** 一覧に無ければ末尾に足す (空行は詰める) */
  const addModel = (agent: AiAgent, name: string) => {
    const list = draft.aiModels[agent].filter((m) => m.trim());
    if (!list.includes(name)) setModels(agent, [...list, name]);
  };

  const fetchCodexModels = async () => {
    setLoadingCodex(true);
    try {
      setCodexModels((await api.aiCodexModels()).models);
    } catch (e) {
      toastError(e);
    } finally {
      setLoadingCodex(false);
    }
  };

  // {系列}-{メジャー}-{マイナー}。メジャー・マイナーは入力したときだけ付ける
  const s = series.trim().toLowerCase();
  const claudeName = s
    ? [s, ...(major.trim() ? [major.trim(), ...(minor.trim() ? [minor.trim()] : [])] : [])].join('-')
    : '';
  const claudeNameValid = /^[a-z][a-z0-9]*(-\d+(-\d+)?)?$/.test(claudeName);

  const status = (a: AiAgent) => {
    const info = agents?.[a];
    if (!info) return <span className={cx('settings-hint')}>確認中…</span>;
    return info.available ? (
      <span className={cx('settings-hint')}>
        {info.path}
        {info.version ? ` (${info.version})` : ''}
      </span>
    ) : (
      <span className={cx('settings-warn')}>PATH に見つかりません (AI チャットでは選べません)</span>
    );
  };

  const codexListed = draft.aiModels.codex.map((m) => m.trim());

  return (
    <div className={cx('ai-settings')}>
      <p className={cx('settings-hint')}>
        AI チャット (ツールバーの 🤖) で使う CLI の設定です。モデル名は 1 行に 1 つ書きます。空なら CLI の既定のモデルだけを使います。
        サンドボックス・権限モードはここが既定値で、AI チャットの送信欄で依頼ごとに変えられます。
      </p>

      <div className={cx('settings-subtitle')}>Codex</div>
      <div className={cx('settings-row')}>
        <span className={cx('settings-label')}>コマンド</span>
        {status('codex')}
      </div>
      <div className={cx('settings-row')}>
        <span className={cx('settings-label')}>サンドボックス (既定)</span>
        <select
          value={draft.aiCodexSandbox}
          onChange={(e) => patch({ aiCodexSandbox: e.target.value as AppSettings['aiCodexSandbox'] })}
        >
          {CODEX_SANDBOXES.map((v) => (
            <option key={v} value={v}>
              {permissionLabel('codex', v)}
            </option>
          ))}
        </select>
      </div>
      <div className={cx('ai-models')}>
        <span className={cx('settings-label')}>モデル</span>
        <textarea
          className={cx('dialog-input ai-models-text')}
          rows={5}
          spellCheck={false}
          placeholder={'gpt-6.1-sol\ngpt-6-luna'}
          value={draft.aiModels.codex.join('\n')}
          onChange={(e) => setModels('codex', toLines(e.target.value))}
        />
      </div>
      <div className={cx('ai-support')}>
        <button className={cx('btn')} disabled={loadingCodex || agents?.codex.available === false} onClick={() => void fetchCodexModels()}>
          {loadingCodex ? '取得中…' : 'codex debug models から取得'}
        </button>
        {codexModels && (
          <>
            <span className={cx('settings-hint')}>クリックで一覧に追加します (薄い表示は CLI の選択肢に出ないモデル)</span>
            <div className={cx('ai-chips')}>
              {codexModels.map((m) => {
                const added = codexListed.includes(m.slug);
                return (
                  <button
                    key={m.slug}
                    className={cx(`ai-chip${added ? ' added' : ''}${m.hidden ? ' hidden-model' : ''}`)}
                    title={`${m.displayName}${m.efforts.length ? `\neffort: ${m.efforts.join(' / ')}` : ''}`}
                    disabled={added}
                    onClick={() => addModel('codex', m.slug)}
                  >
                    {added ? '✓ ' : '+ '}
                    {m.slug}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      <div className={cx('settings-subtitle')}>Claude</div>
      <div className={cx('settings-row')}>
        <span className={cx('settings-label')}>コマンド</span>
        {status('claude')}
      </div>
      <div className={cx('settings-row')}>
        <span className={cx('settings-label')}>権限モード (既定)</span>
        <select
          value={draft.aiClaudePermission}
          onChange={(e) => patch({ aiClaudePermission: e.target.value as AppSettings['aiClaudePermission'] })}
        >
          {CLAUDE_PERMISSIONS.map((v) => (
            <option key={v} value={v}>
              {permissionLabel('claude', v)}
            </option>
          ))}
        </select>
      </div>
      <div className={cx('ai-models')}>
        <span className={cx('settings-label')}>モデル</span>
        <textarea
          className={cx('dialog-input ai-models-text')}
          rows={5}
          spellCheck={false}
          placeholder={'opus-5-5\nsonnet-5-5'}
          value={draft.aiModels.claude.join('\n')}
          onChange={(e) => setModels('claude', toLines(e.target.value))}
        />
      </div>
      <div className={cx('ai-support')}>
        <div className={cx('ai-builder')}>
          <input
            className={cx('dialog-input ai-series')}
            list="ai-claude-series"
            placeholder="系列"
            value={series}
            spellCheck={false}
            onChange={(e) => setSeries(e.target.value)}
          />
          <datalist id="ai-claude-series">
            {CLAUDE_SERIES.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <span>-</span>
          <input
            className={cx('dialog-input ai-version')}
            inputMode="numeric"
            placeholder="メジャー"
            value={major}
            onChange={(e) => setMajor(e.target.value.replace(/\D/g, ''))}
          />
          <span>-</span>
          <input
            className={cx('dialog-input ai-version')}
            inputMode="numeric"
            placeholder="マイナー"
            value={minor}
            disabled={!major.trim()}
            title={major.trim() ? undefined : 'メジャーバージョンを入れると入力できます'}
            onChange={(e) => setMinor(e.target.value.replace(/\D/g, ''))}
          />
          <code className={cx('ai-preview')}>{claudeName || '—'}</code>
          <button
            className={cx('btn')}
            disabled={!claudeNameValid || draft.aiModels.claude.map((m) => m.trim()).includes(claudeName)}
            onClick={() => addModel('claude', claudeName)}
          >
            追加
          </button>
        </div>
        <p className={cx('settings-hint')}>
          {'{'}モデル系列{'}'}-{'{'}メジャー{'}'}-{'{'}マイナー{'}'} の形で組み立てます。メジャー・マイナーは入力したときだけ付きます。
          <span className={cx('settings-warn')}>
            {' '}
            モデル名が CLI に認識されない場合は、最新のモデル名を Anthropic の公式ドキュメント等で確認してください。
          </span>
        </p>
      </div>
    </div>
  );
}
