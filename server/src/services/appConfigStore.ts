import { randomUUID } from 'node:crypto';
import { db } from './stateStore.js';

/**
 * 画面で編集可能な設定 (commitFilesLimit / contextMenu / externalTools / diffTools / extDefaults) を
 * DB (settings テーブル) に保持する。設定は設定画面 (GUI) からのみ編集する (config.jsonc からは取り込まない)。
 * run-tool / difftool の実行コマンドはここ (サーバ側 DB) からのみ参照する → allowlist 境界を維持。
 */

export interface ExternalToolDef {
  id: string;
  label: string;
  command: string;
  args?: string[];
  group?: string;
  /** 対象種別。既定 any (ファイル/フォルダ両方) */
  kind?: 'file' | 'dir' | 'any';
  /** 対象拡張子 (ドット無し・小文字。空/未指定=全拡張子)。FsEntry.ext と同形式で比較 */
  extensions?: string[];
  /** 起動前に確認ダイアログを出すか */
  confirm?: boolean;
}

export interface DiffToolDef {
  id: string;
  label: string;
  command: string;
  args?: string[];
  default?: boolean;
}

export interface AppConfig {
  commitFilesLimit: number;
  contextMenu: Record<string, boolean>;
  externalTools: ExternalToolDef[];
  diffTools: DiffToolDef[];
  /** 拡張子 (ドット無し・小文字) → externalTool.id。ダブルクリック時の既定起動ツール */
  extDefaults: Record<string, string>;
}

/** GUI から更新できる設定キー */
export type AppConfigKey = keyof AppConfig;

/** 拡張子の正規化: 前後空白除去・先頭ドット除去・小文字化 (FsEntry.ext と同形式) */
export function normExt(s: unknown): string {
  return typeof s === 'string' ? s.trim().replace(/^\.+/, '').toLowerCase() : '';
}

function readSetting<T>(key: string): T | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return undefined;
  }
}

function writeSetting(key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value));
}

/** config.jsonc の externalTool を DB 保存形式 (id 採番・kind 既定) に変換 */
function sanitizeTool(raw: unknown): ExternalToolDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const label = typeof t.label === 'string' ? t.label : '';
  const command = typeof t.command === 'string' ? t.command : '';
  if (!label && !command) return null;
  const args = Array.isArray(t.args) ? t.args.filter((a): a is string => typeof a === 'string') : undefined;
  const extensions = Array.isArray(t.extensions)
    ? [...new Set(t.extensions.map(normExt).filter(Boolean))]
    : undefined;
  const kind = t.kind === 'file' || t.kind === 'dir' ? t.kind : 'any';
  return {
    id: typeof t.id === 'string' && t.id ? t.id : randomUUID(),
    label,
    command,
    ...(args && args.length ? { args } : {}),
    ...(typeof t.group === 'string' && t.group ? { group: t.group } : {}),
    kind,
    ...(extensions && extensions.length ? { extensions } : {}),
    ...(t.confirm === true ? { confirm: true } : {}),
  };
}

function sanitizeDiffTool(raw: unknown): DiffToolDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const label = typeof t.label === 'string' ? t.label : '';
  const command = typeof t.command === 'string' ? t.command : '';
  if (!label && !command) return null;
  const args = Array.isArray(t.args) ? t.args.filter((a): a is string => typeof a === 'string') : undefined;
  return {
    id: typeof t.id === 'string' && t.id ? t.id : randomUUID(),
    label,
    command,
    ...(args && args.length ? { args } : {}),
    ...(t.default === true ? { default: true } : {}),
  };
}

function getExternalTools(): ExternalToolDef[] {
  return readSetting<ExternalToolDef[]>('externalTools') ?? [];
}

function getDiffTools(): DiffToolDef[] {
  return readSetting<DiffToolDef[]>('diffTools') ?? [];
}

function getContextMenu(): Record<string, boolean> {
  return readSetting<Record<string, boolean>>('contextMenu') ?? {};
}

function getCommitFilesLimit(): number {
  return readSetting<number>('commitFilesLimit') ?? 100;
}

function getExtDefaults(): Record<string, string> {
  return readSetting<Record<string, string>>('extDefaults') ?? {};
}

/** 現在有効な設定 (未設定の項目は既定値) をまとめて返す */
export function getAppConfig(): AppConfig {
  return {
    commitFilesLimit: getCommitFilesLimit(),
    contextMenu: getContextMenu(),
    externalTools: getExternalTools(),
    diffTools: getDiffTools(),
    extDefaults: getExtDefaults(),
  };
}

/** id で外部ツール定義を取得 (run-tool 用) */
export function getToolById(id: unknown): ExternalToolDef | undefined {
  if (typeof id !== 'string' || !id) return undefined;
  return getExternalTools().find((t) => t.id === id);
}

/** id で差分ツール定義を取得 (difftool 用) */
export function getDiffToolById(id: unknown): DiffToolDef | undefined {
  if (typeof id !== 'string' || !id) return undefined;
  return getDiffTools().find((t) => t.id === id);
}

/** GUI からの設定保存。指定されたキーのみ検証・正規化して書き込む */
export function saveAppConfig(partial: Partial<Record<AppConfigKey, unknown>>): AppConfig {
  const tx = db.transaction(() => {
    if (partial.externalTools !== undefined) {
      const tools = Array.isArray(partial.externalTools)
        ? partial.externalTools.map(sanitizeTool).filter((t): t is ExternalToolDef => t !== null)
        : [];
      writeSetting('externalTools', tools);
    }
    if (partial.diffTools !== undefined) {
      const tools = Array.isArray(partial.diffTools)
        ? partial.diffTools.map(sanitizeDiffTool).filter((t): t is DiffToolDef => t !== null)
        : [];
      // default は先頭の 1 つだけ有効にする
      let seenDefault = false;
      for (const t of tools) {
        if (t.default) {
          if (seenDefault) delete t.default;
          else seenDefault = true;
        }
      }
      writeSetting('diffTools', tools);
    }
    if (partial.contextMenu !== undefined && partial.contextMenu && typeof partial.contextMenu === 'object') {
      const src = partial.contextMenu as Record<string, unknown>;
      const cleaned: Record<string, boolean> = {};
      for (const [k, val] of Object.entries(src)) cleaned[k] = val !== false ? Boolean(val) : false;
      writeSetting('contextMenu', cleaned);
    }
    if (partial.commitFilesLimit !== undefined) {
      const n = Number(partial.commitFilesLimit);
      writeSetting('commitFilesLimit', Number.isFinite(n) && n > 0 ? Math.floor(n) : 100);
    }
    if (partial.extDefaults !== undefined && partial.extDefaults && typeof partial.extDefaults === 'object') {
      const src = partial.extDefaults as Record<string, unknown>;
      const cleaned: Record<string, string> = {};
      for (const [k, val] of Object.entries(src)) {
        const ext = normExt(k);
        if (ext && typeof val === 'string' && val) cleaned[ext] = val;
      }
      writeSetting('extDefaults', cleaned);
    }
  });
  tx();
  return getAppConfig();
}
