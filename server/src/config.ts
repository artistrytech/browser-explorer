import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(__dirname, '..', '..');

export interface AppConfig {
  host: string;
  port: number;
  clientPort: number;
  token: string;
}

export const config: AppConfig = JSON.parse(
  readFileSync(path.join(rootDir, 'config.json'), 'utf-8'),
);

export const dataDir = path.join(rootDir, 'data');
