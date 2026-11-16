import { useSelectionCopy } from '../lib/selectionCopy';
import { copyWithToast } from '../lib/copyPath';
import styles from './SelectionCopyPopup.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** 範囲選択の近くに出すコピーボタン (lib/selectionCopy が位置とコピーする文字列を決める) */
export function SelectionCopyPopup() {
  const popup = useSelectionCopy((s) => s.popup);
  if (!popup) return null;
  return (
    <button
      // 出し直すたびにアニメーションし直す
      key={`${popup.owner}:${popup.x}:${popup.y}:${popup.label}`}
      className={cx('sel-copy')}
      style={{ left: popup.x, top: popup.y }}
      title={`パスと選択箇所をコピー\n${popup.label}`}
      aria-label="パスと選択箇所をコピー"
      // 押しても選択・フォーカスを動かさない
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        useSelectionCopy.getState().hide();
        void copyWithToast(popup.text, `${popup.label} をコピーしました`);
      }}
    >
      <CopyIcon />
    </button>
  );
}

function CopyIcon() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
