import fs from 'node:fs/promises';
import { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface FsEntry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'symlink';
  size: number;
  mtime: number;
  hidden: boolean;
  ext: string;
  linkTarget?: string;
}

export interface VolumeInfo {
  name: string;
  path: string;
}

/** パス区切りを '/' に統一(Windows でも C:/Users/... 形式で扱う) */
export function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

export function parentOf(p: string): string {
  const n = norm(p);
  const parent = norm(path.dirname(n));
  return parent;
}

export async function listVolumes(): Promise<VolumeInfo[]> {
  const volumes: VolumeInfo[] = [];
  if (process.platform === 'win32') {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    await Promise.all(
      letters.map(async (l) => {
        try {
          await fs.access(`${l}:/`);
          volumes.push({ name: `${l}:`, path: `${l}:/` });
        } catch {
          /* drive not present */
        }
      }),
    );
    volumes.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    volumes.push({ name: 'Macintosh HD', path: '/' });
    try {
      const mounts = await fs.readdir('/Volumes', { withFileTypes: true });
      for (const m of mounts) {
        volumes.push({ name: m.name, path: `/Volumes/${m.name}` });
      }
    } catch {
      /* not macOS or no /Volumes */
    }
  }
  return volumes;
}

async function toEntry(dir: string, d: Dirent): Promise<FsEntry | null> {
  const full = path.join(dir, d.name);
  let st: Stats;
  let linkTarget: string | undefined;
  const isSymlink = d.isSymbolicLink();
  try {
    st = isSymlink ? await fs.lstat(full) : await fs.stat(full);
    if (isSymlink) {
      try {
        linkTarget = norm(await fs.readlink(full));
      } catch {
        /* ignore */
      }
    }
  } catch {
    return null; // アクセス不可のエントリはスキップ
  }
  const isDir = isSymlink
    ? await fs
        .stat(full)
        .then((s) => s.isDirectory())
        .catch(() => false)
    : st.isDirectory();
  return {
    name: d.name,
    path: norm(full),
    type: isSymlink ? 'symlink' : isDir ? 'dir' : 'file',
    size: isDir ? 0 : st.size,
    mtime: st.mtimeMs,
    hidden: d.name.startsWith('.'),
    ext: isDir ? '' : path.extname(d.name).replace(/^\./, '').toLowerCase(),
    ...(linkTarget ? { linkTarget } : {}),
  };
}

export async function listDir(dirPath: string): Promise<FsEntry[]> {
  const dirents = await fs.readdir(dirPath, { withFileTypes: true });
  const entries = await Promise.all(dirents.map((d) => toEntry(dirPath, d)));
  return entries.filter((e): e is FsEntry => e !== null);
}

export async function statEntry(p: string): Promise<FsEntry & { ctime: number; mode: number }> {
  const st = await fs.lstat(p);
  const isSymlink = st.isSymbolicLink();
  let linkTarget: string | undefined;
  if (isSymlink) {
    try {
      linkTarget = norm(await fs.readlink(p));
    } catch {
      /* ignore */
    }
  }
  const name = path.basename(p);
  return {
    name,
    path: norm(p),
    type: isSymlink ? 'symlink' : st.isDirectory() ? 'dir' : 'file',
    size: st.size,
    mtime: st.mtimeMs,
    ctime: st.birthtimeMs,
    mode: st.mode,
    hidden: name.startsWith('.'),
    ext: st.isDirectory() ? '' : path.extname(name).replace(/^\./, '').toLowerCase(),
    ...(linkTarget ? { linkTarget } : {}),
  };
}

const SEARCH_SKIP = new Set(['node_modules', '.git', 'Library', 'AppData', '$Recycle.Bin', 'System Volume Information']);

export async function searchByName(
  dir: string,
  query: string,
  limit = 200,
  maxDepth = 6,
): Promise<FsEntry[]> {
  const results: FsEntry[] = [];
  const q = query.toLowerCase();

  async function walk(current: string, depth: number): Promise<void> {
    if (results.length >= limit || depth > maxDepth) return;
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (results.length >= limit) return;
      if (d.name.toLowerCase().includes(q)) {
        const entry = await toEntry(current, d);
        if (entry) results.push(entry);
      }
      if (d.isDirectory() && !SEARCH_SKIP.has(d.name) && !d.name.startsWith('.')) {
        await walk(path.join(current, d.name), depth + 1);
      }
    }
  }

  await walk(dir, 0);
  return results;
}

/** 重複しない貼り付け先パスを生成する (name.txt → name (2).txt) */
export async function uniqueDest(destDir: string, name: string): Promise<string> {
  let candidate = path.join(destDir, name);
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let i = 2;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(destDir, `${base} (${i})${ext}`);
      i++;
    } catch {
      return candidate;
    }
  }
}

export function homeDir(): string {
  return norm(os.homedir());
}
