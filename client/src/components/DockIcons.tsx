/** パネルの表示位置のアイコン (AI チャット・ターミナルのタイトルバーのボタン用) */

/** 右パネルに固定するアイコン (枠の右側を塗る) */
export function DockRightIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" />
      <rect x="9" y="3" width="5" height="10" fill="currentColor" />
    </svg>
  );
}

/** 下パネルに固定するアイコン (枠の下側を塗る) */
export function DockBottomIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" />
      <rect x="2" y="8.5" width="12" height="4.5" fill="currentColor" />
    </svg>
  );
}

/** フローティングで表示するアイコン (重なった 2 枚の枠) */
export function FloatIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
      <rect x="1.5" y="5.5" width="9" height="8" rx="1" />
      <path d="M5.5 5.5V2.5h9v8h-4" />
    </svg>
  );
}

/** ターミナルのアイコン (枠の中に >_) */
export function TerminalIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4.5 6l2.5 2-2.5 2M8.5 10.5h3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
