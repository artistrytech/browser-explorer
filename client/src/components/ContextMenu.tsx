import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import styles from './ContextMenu.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';
import { middleClickProps } from '../lib/appTabs';

const cx = createCssModuleClassNames(styles);

export interface MenuItem {
  label?: string;
  /** ラベルの下に小さく薄字で添える補足 (コピーされるパスなど) */
  detail?: string;
  /** マウスオーバー時のツールチップ (detail を省略表示したときの全文など) */
  title?: string;
  /** クリックイベントを受け取れる (Ctrl+クリック等の修飾キー判定用) */
  action?: (e: React.MouseEvent) => void;
  /**
   * 別タブで開ける項目 (Ctrl+クリックで別タブ)。中クリックでも action を呼ぶ
   * (action 側は lib/appTabs.ts の wantsNewTab で別タブかを判定する)。
   * 指定の無い項目は、誤操作を避けるため中クリックに反応しない
   */
  newTab?: boolean;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  /** 指定するとマウスオーバーで開くサブメニューになる (action は無視される) */
  submenu?: MenuItem[];
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
  visible: boolean;
  open: (x: number, y: number, items: MenuItem[]) => void;
  close: () => void;
}

export const useContextMenu = create<MenuState>((set) => ({
  x: 0,
  y: 0,
  items: [],
  visible: false,
  open: (x, y, items) => set({ x, y, items, visible: true }),
  close: () => set({ visible: false }),
}));

/**
 * サブメニューの開閉の遅延 (ms)。マウスを斜めに動かしてサブメニューへ移る途中で別の項目を横切っても
 * すぐには切り替えず、少しの間メニューの外に出ても閉じないようにする (Windows のメニューと同じ考え方)
 */
const SUBMENU_OPEN_DELAY = 150;
const SUBMENU_CLOSE_DELAY = 300;

/** サブメニュー: 親項目の右側に開く。画面外にはみ出す場合は左側/上方向へ寄せる */
function Submenu({ items, close }: { items: MenuItem[]; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.right > innerWidth) {
      el.style.left = 'auto';
      el.style.right = '100%';
    }
    if (rect.bottom > innerHeight) {
      el.style.top = `${Math.min(0, innerHeight - rect.bottom - 8)}px`;
    }
  }, []);
  return (
    <div ref={ref} className={cx("context-menu submenu")}>
      <MenuList items={items} close={close} />
    </div>
  );
}

function MenuList({ items, close }: { items: MenuItem[]; close: () => void }) {
  // マウスオーバー中のサブメニュー (クリックでも開く: タッチ/キーボード操作向け)
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  /** 遅延してから openIndex を next にする (既にそうなっていれば予約を取り消すだけ) */
  const schedule = (next: number | null, delay: number) => {
    clearTimeout(timer.current);
    if (openIndex !== next) timer.current = setTimeout(() => setOpenIndex(next), delay);
  };
  /** 今すぐ開く (クリック時) */
  const openNow = (i: number) => {
    clearTimeout(timer.current);
    setOpenIndex(i);
  };

  return (
    <>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className={cx("menu-separator")} />
        ) : item.submenu ? (
          <div
            key={i}
            className={cx("menu-group")}
            // サブメニューはこの要素の中にあるので、サブメニューへ入ったときも mouseenter で予約を取り消せる
            onMouseEnter={() => schedule(i, SUBMENU_OPEN_DELAY)}
            onMouseLeave={() => schedule(null, SUBMENU_CLOSE_DELAY)}
          >
            <button
              className={cx(`menu-item has-submenu${openIndex === i ? ' open' : ''}`)}
              disabled={item.disabled}
              onClick={() => openNow(i)}
            >
              <span>{item.label}</span>
              <span className={cx("menu-arrow")}>▶</span>
            </button>
            {openIndex === i && <Submenu items={item.submenu} close={close} />}
          </div>
        ) : (
          <button
            key={i}
            className={cx(`menu-item${item.danger ? ' danger' : ''}`)}
            disabled={item.disabled}
            title={item.title}
            // 通常の項目に乗ったら、開いているサブメニューは少し待ってから閉じる
            onMouseEnter={() => schedule(null, SUBMENU_CLOSE_DELAY)}
            onClick={(e) => {
              close();
              item.action?.(e);
            }}
            {...(item.newTab
              ? middleClickProps((e) => {
                  close();
                  item.action?.(e);
                })
              : {})}
          >
            {item.label}
            {item.detail && <span className={cx("menu-detail")}>{item.detail}</span>}
          </button>
        ),
      )}
    </>
  );
}

export function ContextMenuHost() {
  const { x, y, items, visible, close } = useContextMenu();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [visible, close]);

  useEffect(() => {
    // 画面外にはみ出す場合は位置を調整
    if (visible && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      if (rect.bottom > innerHeight) {
        ref.current.style.top = `${Math.max(4, innerHeight - rect.height - 8)}px`;
      }
      if (rect.right > innerWidth) {
        ref.current.style.left = `${Math.max(4, innerWidth - rect.width - 8)}px`;
      }
    }
  }, [visible, x, y]);

  if (!visible) return null;

  return (
    <div ref={ref} className={cx("context-menu")} style={{ left: x, top: y }}>
      <MenuList items={items} close={close} />
    </div>
  );
}
