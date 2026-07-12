import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(__dirname, '..', '..');

export interface AppConfig {
  host: string;
  port: number;
  clientPort: number;
  token: string;
  /** コミット差分ファイル一覧の表示上限 (省略時 100) */
  commitFilesLimit?: number;
  /** Explorer コンテキストメニューの表示設定 (false で非表示、省略時は表示) */
  contextMenu?: Record<string, boolean>;
  /**
   * コンテキストメニューから起動する外部ツール。
   * command は実行ファイル (絶対パス推奨)。args の "${paths}" が選択パス群に展開される
   * (省略時や "${paths}" が無い場合は末尾に選択パスを追加)。
   */
  externalTools?: { label: string; command: string; args?: string[] }[];
  /**
   * 差分表示に使う外部ツール (WinMerge / Meld など)。
   * args のプレースホルダ "${left}" "${right}" が比較対象のファイルパスに、
   * "${leftTitle}" "${rightTitle}" が表示用の見出しに展開される
   * (${left}/${right} をどちらも書かない場合は末尾に左右のパスを追加)。
   * default: true を付けたツールが、ファイルをダブルクリックした際の既定の差分表示になる
   * (複数指定した場合は先頭のものを使う。未指定ならアプリ内の 2 ペイン差分)。
   */
  diffTools?: { label: string; command: string; args?: string[]; default?: boolean }[];
}

/**
 * JSONC (コメント付き JSON) のコメントを除去する。
 * 文字列リテラル内の // や /* は保持する。
 */
export function stripJsonComments(src: string): string {
  let out = '';
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i++;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

// config.jsonc (コメント可) を優先し、旧 config.json にもフォールバック
const jsoncPath = path.join(rootDir, 'config.jsonc');
const jsonPath = path.join(rootDir, 'config.json');
const configPath = existsSync(jsoncPath) ? jsoncPath : jsonPath;

export const config: AppConfig = JSON.parse(stripJsonComments(readFileSync(configPath, 'utf-8')));

export const dataDir = path.join(rootDir, 'data');
