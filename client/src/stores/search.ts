import { create } from 'zustand';
import { api } from '../api/client';
import { toastError } from './toast';
import type { FsEntry } from '../types';

/** サーバの検索 (searchByName) が返す件数の上限。これに達したら「上限まで表示」と添える */
export const SEARCH_LIMIT = 200;

/**
 * 名前での検索 (左パネルの検索)。検索したときのフォルダ (root) を基準に結果を一覧にする。
 * フォルダを移動しても結果はそのまま残す (VSCode の検索と同様)。
 */
interface SearchStore {
  /** 入力欄の文字列 */
  input: string;
  /** 実行した検索 (結果の見出しに使う) */
  query: string;
  /** 検索したフォルダ (相対パスの基準) */
  root: string | null;
  results: FsEntry[] | null;
  loading: boolean;
  setInput: (input: string) => void;
  run: (dir: string, query: string) => Promise<void>;
  clear: () => void;
}

let seq = 0;

export const useSearch = create<SearchStore>((set) => ({
  input: '',
  query: '',
  root: null,
  results: null,
  loading: false,
  setInput: (input) => set({ input }),
  run: async (dir, query) => {
    const q = query.trim();
    if (!q) {
      useSearch.getState().clear();
      return;
    }
    const my = ++seq;
    set({ loading: true, query: q, root: dir });
    try {
      const { results } = await api.search(dir, q);
      if (my === seq) set({ results });
    } catch (e) {
      if (my === seq) toastError(e);
    } finally {
      if (my === seq) set({ loading: false });
    }
  },
  clear: () => {
    seq++;
    set({ input: '', query: '', root: null, results: null, loading: false });
  },
}));

/**
 * root からの相対パス (root 自身は空文字、root 外なら絶対パスのまま)。
 * Windows のドライブパスは大文字小文字を区別しない
 */
export function relativeTo(p: string, root: string): string {
  const base = root.endsWith('/') ? root : `${root}/`;
  const win = /^[A-Za-z]:/.test(base);
  const same = (a: string, b: string) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(p.replace(/\/+$/, ''), base.replace(/\/+$/, '')) || same(p, base)) return '';
  const head = p.slice(0, base.length);
  if (same(head, base)) return p.slice(base.length);
  return p;
}
