import type { FileListMode } from '../lib/fileTree';
import styles from './FileListModeToggle.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

const MODES: { mode: FileListMode; title: string; icon: string }[] = [
  { mode: 'list', title: '一覧で表示', icon: 'M2 4h12M2 8h12M2 12h12' },
  { mode: 'tree', title: 'ツリーで表示', icon: 'M2 3.5h7M4 3.5V12M4 8h3M4 12h3M9 8h5M9 12h5' },
];

/** 変更ファイル一覧の表示形式 (一覧 / ツリー) の切り替えボタン */
export function FileListModeToggle({
  mode,
  onChange,
}: {
  mode: FileListMode;
  onChange: (mode: FileListMode) => void;
}) {
  return (
    <span className={cx('flm')}>
      {MODES.map((m) => (
        <button
          key={m.mode}
          type="button"
          className={cx(`flm-btn${mode === m.mode ? ' on' : ''}`)}
          title={m.title}
          aria-pressed={mode === m.mode}
          onClick={() => onChange(m.mode)}
        >
          <svg className={cx('flm-icon')} viewBox="0 0 16 16" aria-hidden="true">
            <path d={m.icon} />
          </svg>
        </button>
      ))}
    </span>
  );
}
