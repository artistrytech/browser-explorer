import { useSideBar, type SidePanel } from '../stores/sideBar';
import { isMacBrowser } from '../stores/settings';
import styles from './ActivityBar.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** エクスプローラ (左パネル) のアイコン: 重なった 2 枚の書類 */
function ExplorerIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M8.5 3.5h6l4 4v10a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z" />
      <path d="M14.5 3.5v4h4" />
      <path d="M7.5 7.5h-2a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1" />
    </svg>
  );
}

/** 検索のアイコン: 虫眼鏡 */
function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5.5 5.5" />
    </svg>
  );
}

/**
 * 左端のレーン (VSCode のアクティビティバー相当)。
 * アイコンで左パネルの内容を切り替え、表示中の内容のアイコンをもう一度押すと左パネルを畳む。
 */
export function ActivityBar() {
  const open = useSideBar((s) => s.open);
  const panel = useSideBar((s) => s.panel);
  const activate = useSideBar((s) => s.activate);
  const mod = isMacBrowser() ? '⌘' : 'Ctrl';

  const item = (p: SidePanel, label: string, icon: JSX.Element) => {
    const active = open && panel === p;
    return (
      <button
        key={p}
        className={cx(`lane-btn${active ? ' active' : ''}`)}
        title={label}
        aria-label={label}
        aria-pressed={active}
        onClick={() => activate(p)}
      >
        {icon}
      </button>
    );
  };

  return (
    <nav className={cx('lane')} aria-label="左パネルの切り替え">
      {item('explorer', `エクスプローラ (左パネルの表示 / 非表示: ${mod}+B)`, <ExplorerIcon />)}
      {item('search', '名前で検索', <SearchIcon />)}
    </nav>
  );
}
