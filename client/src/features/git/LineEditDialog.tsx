import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import styles from './LineEditDialog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';
import { useDialogKeys } from '../../lib/dialogKeys';

const cx = createCssModuleClassNames(styles);

/**
 * コミットタブの差分で、Hunk・選択行の範囲をテキストで直接書き換えるダイアログ。
 * openLineEditDialog で開き、編集後のテキスト (キャンセルは null) を Promise で返す。
 * 書き換え自体 (パッチの組み立てと適用) は呼び出し元 (WorkingDiff) が行う
 */

export interface LineEditRequest {
  title: string;
  path: string;
  /** 対象の説明 (「作業ツリー 12〜15 行目」など) */
  target: string;
  /** 補足 (ステージ側はインデックスだけを書き換える、など) */
  note?: string;
  text: string;
}

interface Store {
  req: LineEditRequest | null;
  resolve: ((v: string | null) => void) | null;
  show: (req: LineEditRequest, resolve: (v: string | null) => void) => void;
  close: () => void;
}

const useStore = create<Store>((set) => ({
  req: null,
  resolve: null,
  show: (req, resolve) => set({ req, resolve }),
  close: () => set({ req: null, resolve: null }),
}));

export function openLineEditDialog(req: LineEditRequest): Promise<string | null> {
  return new Promise((resolve) => {
    // 前の要求が残っていればキャンセル扱いにする
    useStore.getState().resolve?.(null);
    useStore.getState().show(req, resolve);
  });
}

export function LineEditDialog() {
  const { req, resolve, close } = useStore();
  const [text, setText] = useState('');
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!req) return;
    setText(req.text);
    requestAnimationFrame(() => textRef.current?.focus());
  }, [req]);

  const finish = (value: string | null) => {
    resolve?.(value);
    close();
  };

  const changed = req !== null && text !== req.text;
  // textarea の Enter は改行。Ctrl+Enter (mac は ⌘+Enter) で適用
  const dialogRef = useDialogKeys({
    enabled: !!req,
    onEnter: changed ? () => finish(text) : null,
    onEscape: () => finish(null),
  });

  if (!req) return null;

  const lineCount = text === '' ? 0 : text.split('\n').length;

  return (
    <div ref={dialogRef} className={cx('dialog-backdrop')} onMouseDown={() => finish(null)}>
      <div className={cx('dialog line-edit-dialog')} onMouseDown={(e) => e.stopPropagation()}>
        <div className={cx('dialog-title')}>{req.title}</div>
        <div className={cx('le-info')}>
          <span className={cx('le-path')} title={req.path}>
            {req.path}
          </span>
          <span className={cx('le-target')}>{req.target}</span>
        </div>
        {req.note && <div className={cx('le-note')}>{req.note}</div>}
        <textarea
          ref={textRef}
          className={cx('le-text')}
          value={text}
          spellCheck={false}
          wrap="off"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Tab はフォーカス移動ではなくタブ文字の入力にする
            if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: s, selectionEnd: t } = el;
            setText(text.slice(0, s) + '\t' + text.slice(t));
            requestAnimationFrame(() => el.setSelectionRange(s + 1, s + 1));
          }}
        />
        <div className={cx('dialog-buttons')}>
          <span className={cx('le-hint')}>
            {lineCount} 行 · 空にするとこの範囲の行を削除します · Ctrl+Enter で適用
          </span>
          <button className={cx('btn')} onClick={() => finish(null)}>
            キャンセル
          </button>
          <button className={cx('btn primary')} disabled={!changed} onClick={() => finish(text)}>
            適用
          </button>
        </div>
      </div>
    </div>
  );
}
