import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDialogKeys } from '../../lib/dialogKeys';
import styles from './MermaidDialog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * mermaid 図の拡大表示ダイアログ。プレビュー本文の図 (描画済み SVG) を複製して表示する。
 * ホイールでカーソル位置を中心に拡大縮小、ドラッグで移動、ダブルクリックで全体表示。
 * + / - / 0 キーでも拡大・縮小・全体表示できる。
 */

const MIN_SCALE = 0.1;
const MAX_SCALE = 10;
/** ボタン・キー操作 1 回あたりの倍率 */
const STEP = 1.25;
/** 全体表示のときの周囲の余白 (px) */
const FIT_PAD = 24;

interface View {
  scale: number;
  /** 図の左上の、表示領域内での位置 (px) */
  x: number;
  y: number;
}

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** SVG の本来の大きさ (viewBox 由来。無ければ描画済みの大きさ) */
function naturalSize(svg: SVGSVGElement): { w: number; h: number } {
  const vb = svg.viewBox?.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) return { w: vb.width, h: vb.height };
  const r = svg.getBoundingClientRect();
  return { w: r.width || 300, h: r.height || 150 };
}

export function MermaidDialog({ svg: source, onClose }: { svg: SVGSVGElement; onClose: () => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View | null>(null);
  const viewRef = useRef<View | null>(null);
  viewRef.current = view;
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const dialogRef = useDialogKeys({ onEscape: onClose });

  /** 表示領域に収まる倍率で中央に置く */
  const fitView = (s = size): View | null => {
    const vp = viewportRef.current;
    if (!vp || !s) return null;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    const scale = clampScale(Math.min((vw - FIT_PAD * 2) / s.w, (vh - FIT_PAD * 2) / s.h));
    return { scale, x: (vw - s.w * scale) / 2, y: (vh - s.h * scale) / 2 };
  };

  // 図を複製して表示領域に入れ、全体表示から始める。
  // 大きさは width/height で指定する (CSS transform の scale だと拡大時に文字がぼやけることがあるため)
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const clone = source.cloneNode(true) as SVGSVGElement;
    // mermaid は max-width を style に、width="100%" を属性に入れるので外して自前で大きさを決める
    clone.removeAttribute('style');
    clone.removeAttribute('width');
    clone.removeAttribute('height');
    clone.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    host.replaceChildren(clone);
    const s = naturalSize(source);
    setSize(s);
    setView(fitView(s));
    return () => host.replaceChildren();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // 倍率に合わせて SVG の大きさを更新
  useLayoutEffect(() => {
    const svg = hostRef.current?.firstElementChild as SVGSVGElement | null;
    if (!svg || !size || !view) return;
    svg.setAttribute('width', String(size.w * view.scale));
    svg.setAttribute('height', String(size.h * view.scale));
  }, [size, view]);

  /** 表示領域内の点 (cx, cy) を動かさずに倍率を next にする */
  const zoomAt = (next: number, cx?: number, cy?: number) => {
    const v = viewRef.current;
    const vp = viewportRef.current;
    if (!v || !vp) return;
    const scale = clampScale(next);
    const px = cx ?? vp.clientWidth / 2;
    const py = cy ?? vp.clientHeight / 2;
    const k = scale / v.scale;
    setView({ scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
  };

  const setActual = () => zoomAt(1);

  const fit = () => {
    const v = fitView();
    if (v) setView(v);
  };

  // ホイールで拡大縮小 (カーソル位置を中心)。ブラウザのズーム・背後のスクロールを抑止するため passive にしない
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (!v || e.deltaY === 0) return;
      const r = vp.getBoundingClientRect();
      // トラックパッドの細かい delta でも滑らかに拡縮できるよう delta に比例させる
      const factor = Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) * 0.0025);
      zoomAt(v.scale * factor, e.clientX - r.left, e.clientY - r.top);
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // + / - / 0 キー (Ctrl 有無どちらでも)。プレビュー本文の拡縮キーより先に拾って横取りする
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.defaultPrevented) return;
      const v = viewRef.current;
      if (!v) return;
      if (e.key === '+' || (e.key === '=' && !e.shiftKey)) zoomAt(v.scale * STEP);
      else if (e.key === '-' && !e.shiftKey) zoomAt(v.scale / STEP);
      else if (e.key === '0' && !e.shiftKey) fit();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  // ダイアログの大きさが変わったら (ウィンドウのリサイズ等)、図の中心を保ったまま位置を合わせる
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    let prev = { w: vp.clientWidth, h: vp.clientHeight };
    const ro = new ResizeObserver(() => {
      const w = vp.clientWidth;
      const h = vp.clientHeight;
      const v = viewRef.current;
      if (v && (w !== prev.w || h !== prev.h)) setView({ ...v, x: v.x + (w - prev.w) / 2, y: v.y + (h - prev.h) / 2 });
      prev = { w, h };
    });
    ro.observe(vp);
    return () => ro.disconnect();
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !view) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const v = viewRef.current;
    if (!d || !v) return;
    setView({ ...v, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py });
  };

  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  const percent = view ? Math.round(view.scale * 100) : 100;

  return createPortal(
    <div ref={dialogRef} className={cx('mm-backdrop')} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('mm-dialog')} role="dialog" aria-label="mermaid 図の拡大表示">
        <div className={cx('mm-header')}>
          <span className={cx('mm-title')}>mermaid 図</span>
          <span className={cx('mm-hint')}>ホイールで拡大縮小・ドラッグで移動・ダブルクリックで全体表示</span>
          <div className={cx('mm-tools')}>
            <button className={cx('mm-btn')} title="縮小 (-)" onClick={() => view && zoomAt(view.scale / STEP)}>
              −
            </button>
            <button className={cx('mm-btn mm-zoom')} title="実寸 (100%) で表示" onClick={setActual}>
              {percent}%
            </button>
            <button className={cx('mm-btn')} title="拡大 (+)" onClick={() => view && zoomAt(view.scale * STEP)}>
              ＋
            </button>
            <button className={cx('mm-btn')} title="全体を表示 (0)" onClick={fit}>
              全体表示
            </button>
            <button className={cx('mm-btn mm-close')} title="閉じる (Esc)" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <div
          ref={viewportRef}
          className={cx(`mm-viewport${dragging ? ' dragging' : ''}`)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={fit}
        >
          <div
            ref={hostRef}
            className={cx('mm-canvas')}
            style={view ? { transform: `translate(${view.x}px, ${view.y}px)` } : { visibility: 'hidden' }}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
