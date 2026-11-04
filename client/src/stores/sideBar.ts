import { create } from 'zustand';

/**
 * 左パネル (サイドバー) の表示状態と、その中に出す内容 (VSCode のアクティビティバーと同様)。
 * - explorer: クイックアクセス・リポジトリ・場所 (従来の左パネル)
 * - search: 名前での検索と、その結果の一覧
 * 表示 / 非表示と内容は localStorage に控え、読み込み直しても保つ。
 */
export type SidePanel = 'explorer' | 'search';

const OPEN_KEY = 'sidebar.open';
const PANEL_KEY = 'sidebar.panel';

function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

function loadPanel(): SidePanel {
  try {
    return localStorage.getItem(PANEL_KEY) === 'search' ? 'search' : 'explorer';
  } catch {
    return 'explorer';
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 保存できなくても動作は続ける */
  }
}

interface SideBarStore {
  open: boolean;
  panel: SidePanel;
  /** 検索欄へフォーカスを移す要求 (値が変わるたびに検索パネルがフォーカスする) */
  focusSearchSeq: number;
  /**
   * 表示 / 非表示を切り替える。persist=false は一時的な切り替え
   * (レビュー詳細を開いている間だけ畳む等。次回の起動時の状態には残さない)
   */
  setOpen: (open: boolean, persist?: boolean) => void;
  toggle: () => void;
  /** レーンのアイコン: 表示中の内容なら畳み、そうでなければその内容で開く */
  activate: (panel: SidePanel) => void;
  /** 検索パネルを開いて検索欄にフォーカスする */
  focusSearch: () => void;
}

export const useSideBar = create<SideBarStore>((set, get) => ({
  open: loadOpen(),
  panel: loadPanel(),
  focusSearchSeq: 0,
  setOpen: (open, persist = true) => {
    if (persist) save(OPEN_KEY, open ? '1' : '0');
    if (get().open !== open) set({ open });
  },
  toggle: () => get().setOpen(!get().open),
  activate: (panel) => {
    const s = get();
    if (s.open && s.panel === panel) {
      s.setOpen(false);
      return;
    }
    save(PANEL_KEY, panel);
    set({ panel });
    s.setOpen(true);
    if (panel === 'search') set((p) => ({ focusSearchSeq: p.focusSearchSeq + 1 }));
  },
  focusSearch: () => {
    save(PANEL_KEY, 'search');
    set((p) => ({ panel: 'search', focusSearchSeq: p.focusSearchSeq + 1 }));
    get().setOpen(true);
  },
}));
