import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(__dirname, '..', '..');

/**
 * config.jsonc で設定する項目 (再起動が必要なもののみ)。
 * commitFilesLimit / contextMenu / externalTools / diffTools は設定画面 (GUI) で編集し
 * DB (data/app.db) に保存する → server/services/appConfigStore.ts を参照。
 */
export interface AppConfig {
  host: string;
  port: number;
  clientPort: number;
  token: string;
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
