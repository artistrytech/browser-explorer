import { useExplorer } from '../stores/explorer';
import { useEditor } from '../stores/editor';
import { useGit } from '../stores/git';
import { useUi } from '../stores/ui';
import { useSettings } from '../stores/settings';
import type { Eol } from '../types';
import styles from './StatusBar.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

const ENCODINGS = ['UTF-8', 'Shift_JIS', 'EUC-JP', 'UTF-16LE', 'UTF-16BE'];
const EOLS: Eol[] = ['LF', 'CRLF', 'CR'];

export function StatusBar() {
  const { entries, selection, searchResults } = useExplorer();
  const showHidden = useSettings((s) => s.settings.showHidden);
  const status = useGit((s) => s.status);
  const view = useUi((s) => s.view);
  const { tabs, activePath, cursor, setEncoding, setEol, setBom, reload } = useEditor();
  const tab = tabs.find((t) => t.path === activePath);

  const visible = (searchResults ?? entries).filter((e) => showHidden || !e.hidden);

  return (
    <div className={cx("statusbar")}>
      <span>{visible.length} 項目</span>
      {selection.length > 0 && <span>{selection.length} 個を選択</span>}
      {status?.branch && (
        <span title={status.tracking ?? ''}>
          🌿 {status.branch}
          {status.tracking ? ` ↑${status.ahead}↓${status.behind}` : ''}
        </span>
      )}
      <span className={cx("status-spacer")} />
      {view === 'editor' && tab && (
        <>
          <span>
            行 {cursor.line}, 列 {cursor.col}
          </span>
          <select
            className={cx("status-select")}
            title="エンコーディング (変更後「再読込」でこのエンコで開き直し / Ctrl+S でこのエンコに変換保存)"
            value={tab.encoding}
            onChange={(e) => setEncoding(tab.path, e.target.value)}
          >
            {[...new Set([tab.encoding, ...ENCODINGS])].map((enc) => (
              <option key={enc} value={enc}>
                {enc}
              </option>
            ))}
          </select>
          <button
            className={cx("status-btn")}
            title="選択中のエンコーディングでファイルを開き直す"
            onClick={() => void reload(tab.path, tab.encoding)}
          >
            再読込
          </button>
          <select
            className={cx("status-select")}
            title="改行コード"
            value={tab.eol}
            onChange={(e) => setEol(tab.path, e.target.value as Eol)}
          >
            {EOLS.map((eol) => (
              <option key={eol} value={eol}>
                {eol}
              </option>
            ))}
          </select>
          <button
            className={cx(`status-btn${tab.bom ? ' on' : ''}`)}
            title="BOM の有無を切替"
            onClick={() => setBom(tab.path, !tab.bom)}
          >
            BOM{tab.bom ? ' 有' : ' 無'}
          </button>
        </>
      )}
    </div>
  );
}
