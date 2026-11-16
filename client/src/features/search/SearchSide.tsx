import { SearchPanel } from '../../app/SearchPanel';
import { useGit } from '../../stores/git';
import { useIndexStatus } from '../../stores/searchIndex';
import { IndexStatusBar } from './IndexControls';
import { RichSearchPanel } from './RichSearchPanel';

/**
 * 左パネルの「検索」。表示中のリポジトリでインデックスを有効にしていれば内容の逐次検索 (RichSearchPanel)、
 * そうでなければ従来の名前での検索。リポジトリ内では上部にインデックスの状態と有効化の切り替えを出す。
 */
export function SearchSide() {
  const repo = useGit((s) => s.repoRoot);
  const status = useIndexStatus(repo);
  if (repo && status?.enabled) return <RichSearchPanel repo={repo} />;
  return <SearchPanel header={repo ? <IndexStatusBar repo={repo} /> : null} />;
}
