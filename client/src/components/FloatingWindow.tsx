import { useEffect, useRef, useState, type ReactNode } from 'react';
import styles from './FloatingWindow.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * モードレスのフローティングウィンドウ。背後の画面はそのまま操作できる。
 * タイトルバーのドラッグで移動、四辺・四隅のドラッグでサイズ変更。
 * タイトルバーのダブルクリックで本体を折り畳み、タイトルバーだけの表示にする (もう一度で戻す)。
 * 位置とサイズは localStorage (storageKey) に保持し、次に開いたときに復元する。
 */

export interface WindowRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_W = 360;
const MIN_H = 260;
/** 画面外へ出しすぎないよう、タイトルバーのこの幅だけは画面内に残す */
const KEEP_VISIBLE = 80;
const TITLE_H = 34;

type Dir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const DIRS: Dir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

function clampRect(r: WindowRect): WindowRect {
  const w = Math.round(Math.max(MIN_W, Math.min(r.w, innerWidth)));
  const h = Math.round(Math.max(MIN_H, Math.min(r.h, innerHeight)));
  return {
    w,
    h,
    x: Math.round(Math.min(Math.max(r.x, KEEP_VISIBLE - w), innerWidth - KEEP_VISIBLE)),
    y: Math.round(Math.min(Math.max(r.y, 0), innerHeight - TITLE_H)),
  };
}

function loadRect(key: string, fallback: () => WindowRect): WindowRect {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const r = JSON.parse(raw) as Partial<WindowRect>;
      if ([r.x, r.y, r.w, r.h].every((v) => typeof v === 'number' && Number.isFinite(v))) {
        return clampRect(r as WindowRect);
      }
    }
  } catch {
    /* 読めなければ既定の位置 */
  }
  return clampRect(fallback());
}

function saveRect(key: string, r: WindowRect): void {
  try {
    localStorage.setItem(key, JSON.stringify(r));
  } catch {
    /* storage full 等は無視 */
  }
}

export function FloatingWindow({
  title,
  storageKey,
  defaultRect,
  onClose,
  headerExtra,
  children,
}: {
  title: ReactNode;
  storageKey: string;
  /** 保存された位置が無いときの位置・サイズ */
  defaultRect: () => WindowRect;
  onClose: () => void;
  /** タイトルバーの右側 (閉じるボタンの手前) に置く要素 */
  headerExtra?: ReactNode;
  children: ReactNode;
}) {
  const [rect, setRect] = useState(() => loadRect(storageKey, defaultRect));
  /** 本体を折り畳んでタイトルバーだけを表示しているか (開き直したら展開した状態に戻る) */
  const [collapsed, setCollapsed] = useState(false);
  const rectRef = useRef(rect);
  rectRef.current = rect;

  // ブラウザのウィンドウを縮めたときに画面外へ取り残されないようにする
  useEffect(() => {
    const onResize = () => setRect((r) => clampRect(r));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /** ドラッグ中の移動量から新しい位置・サイズを求める (move = 移動、それ以外はサイズ変更の方向) */
  const startDrag = (e: React.PointerEvent, dir: Dir | 'move') => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = rectRef.current;
    const sx = e.clientX;
    const sy = e.clientY;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    document.body.classList.add(dir === 'move' ? 'fw-moving' : 'fw-resizing');
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (dir === 'move') {
        setRect(clampRect({ ...start, x: start.x + dx, y: start.y + dy }));
        return;
      }
      let { x, y, w, h } = start;
      if (dir.includes('e')) w = Math.max(MIN_W, start.w + dx);
      if (dir.includes('s')) h = Math.max(MIN_H, start.h + dy);
      if (dir.includes('w')) {
        w = Math.max(MIN_W, start.w - dx);
        x = start.x + start.w - w;
      }
      if (dir.includes('n')) {
        h = Math.max(MIN_H, start.h - dy);
        y = Math.max(0, start.y + start.h - h);
        h = start.y + start.h - y;
      }
      setRect({ x, y, w, h });
    };
    const onUp = (ev: PointerEvent) => {
      onMove(ev); // 最後の移動量を反映してから確定する
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('fw-moving', 'fw-resizing');
      const r = clampRect(rectRef.current);
      setRect(r);
      saveRect(storageKey, r);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };

  return (
    <div
      className={cx(`fw-window${collapsed ? ' collapsed' : ''}`)}
      // 折り畳んでも本体の大きさは変えずに隠すだけにする (会話のスクロール位置等を保つ)
      style={{ left: rect.x, top: rect.y, width: rect.w, height: collapsed ? TITLE_H + 2 : rect.h }}
      role="dialog"
      aria-modal="false"
      // ウィンドウ内のキー操作が背後の画面 (Alt+← 等のグローバルキー) へ伝わらないようにする
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className={cx('fw-title')}
        onPointerDown={(e) => {
          // タイトルバー上のボタン類は押せるようにする
          if ((e.target as HTMLElement).closest('button, input, select, a')) return;
          startDrag(e, 'move');
        }}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('button, input, select, a')) return;
          setCollapsed((v) => !v);
        }}
      >
        <span className={cx('fw-title-text')} title={collapsed ? 'ダブルクリックで展開' : 'ダブルクリックで折り畳む'}>
          {title}
        </span>
        {headerExtra}
        <button className={cx('fw-close')} title="閉じる" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className={cx('fw-body')} style={collapsed ? { flex: 'none', height: rect.h - TITLE_H - 2 } : undefined}>
        {children}
      </div>
      {/* 折り畳み中は幅だけ変えられる */}
      {(collapsed ? (['e', 'w'] as Dir[]) : DIRS).map((d) => (
        <div key={d} className={cx(`fw-handle fw-${d}`)} onPointerDown={(e) => startDrag(e, d)} />
      ))}
    </div>
  );
}
