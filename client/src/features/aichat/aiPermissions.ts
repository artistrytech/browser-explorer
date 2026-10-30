import type { AiAgent } from '../../types';

/**
 * AI に与える権限の説明 (Codex はサンドボックス、Claude は権限モード)。
 * 設定画面 (既定値) と送信欄 (依頼ごとの指定) で共通に使う。
 */
const DESCRIPTIONS: Record<AiAgent, Record<string, string>> = {
  codex: {
    'read-only': '読み取りのみ',
    'workspace-write': 'ベースフォルダ内の書き込みを許可',
    'danger-full-access': '制限なし',
  },
  claude: {
    acceptEdits: 'ファイル編集を許可',
    auto: '自動で判断',
    plan: '計画のみ。変更しない',
    dontAsk: '許可済みの操作のみ',
    manual: '確認が必要な操作は拒否',
    bypassPermissions: 'すべて許可',
  },
};

/** 権限の値と説明 (例: "workspace-write (ベースフォルダ内の書き込みを許可)") */
export function permissionLabel(agent: AiAgent, value: string): string {
  const d = DESCRIPTIONS[agent][value];
  return d ? `${value} (${d})` : value;
}

/** 権限の呼び名 (Codex は「サンドボックス」、Claude は「権限モード」) */
export const PERMISSION_NAMES: Record<AiAgent, string> = { codex: 'サンドボックス', claude: '権限モード' };
