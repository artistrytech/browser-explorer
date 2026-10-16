import { useGit, type OverlayCode } from '../stores/git';
import styles from './GitOverlay.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** plan §8.1: ✔ Normal / ● Modified / ＋ Staged / ？ Untracked / ⚠ Conflicted / － Ignored */
const OVERLAY_MARK: Record<OverlayCode, { mark: string; cls: string; title: string }> = {
  normal: { mark: '✔', cls: 'ov-normal', title: '変更なし' },
  modified: { mark: '●', cls: 'ov-modified', title: '変更あり' },
  staged: { mark: '＋', cls: 'ov-staged', title: 'ステージ済み' },
  untracked: { mark: '？', cls: 'ov-untracked', title: 'Git 管理外' },
  conflicted: { mark: '⚠', cls: 'ov-conflicted', title: '競合' },
  ignored: { mark: '－', cls: 'ov-ignored', title: '無視 (.gitignore)' },
};

/**
 * アイコンの右下に重ねる Git 状態のマーク (ファイル一覧 / プロジェクトツリーで共通)。
 * 親要素に position: relative が必要。big は大アイコン表示用の大きいマーク
 */
export function GitOverlay({ path, dirCode, big = false }: { path: string; dirCode?: OverlayCode; big?: boolean }) {
  const repoRoot = useGit((s) => s.repoRoot);
  const code = useGit((s) => s.overlay[path]);
  if (!repoRoot || !path.startsWith(repoRoot)) return null;
  // /status 由来 (変更/ステージ/競合) を優先し、無ければフォルダ単位の判定 (無視/管理外)
  const info = OVERLAY_MARK[code ?? dirCode ?? 'normal'];
  return (
    <span className={cx(`git-overlay ${info.cls}${big ? ' big' : ''}`)} title={info.title}>
      {info.mark}
    </span>
  );
}
