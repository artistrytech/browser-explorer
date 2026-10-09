import styles from './SyncBadge.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** リモートとの差分 (▲ahead ▼behind) を丸枠で表示する。0 の側は薄字にする */
export function SyncBadge({ ahead, behind, className }: { ahead: number; behind: number; className?: string }) {
  return (
    <span
      className={cx('sync-badge', ahead > 0 || behind > 0 ? 'active' : null, className)}
      title={`リモートより ${ahead} 件進んでいる / ${behind} 件遅れている`}
    >
      <span className={cx('sync-badge-count', ahead > 0 ? 'nonzero' : null)}>▲{ahead}</span>
      <span className={cx('sync-badge-count', behind > 0 ? 'nonzero' : null)}>▼{behind}</span>
    </span>
  );
}
