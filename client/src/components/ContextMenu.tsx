import { useEffect, useRef } from 'react';
import { create } from 'zustand';

export interface MenuItem {
  label?: string;
  /** クリックイベントを受け取れる (Ctrl+クリック等の修飾キー判定用) */
  action?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
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
    <div ref={ref} className="context-menu" style={{ left: x, top: y }}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="menu-separator" />
        ) : (
          <button
            key={i}
            className={`menu-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            onClick={(e) => {
              close();
              item.action?.(e);
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
