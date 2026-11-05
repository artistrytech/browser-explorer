import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import styles from './LineEditDialog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';
import { useDialogKeys } from '../../lib/dialogKeys';
import { confirmDialog } from '../../stores/dialog';

const cx = createCssModuleClassNames(styles);

/**
 * コミットタブの差分で、Hunk・選択行の範囲をテキストで直接書き換えるダイアログ。
 * openLineEditDialog で開き、選んだ範囲と編集後のテキスト (キャンセルは null) を Promise で返す。
 * 範囲が複数 (Hunk 全体 / 選択行) あればラジオボタンで切り替えられる。
 * 編集中に切り替えるときは確認のうえ編集内容を破棄し、切替先の内容を読み込み直す。
 * 書き換え自体 (パッチの組み立てと適用) は呼び出し元 (WorkingDiff) が行う
 */

/** 編集する範囲の候補 */
export interface LineEditScope {
  value: string;
  /** ラジオボタンの表示 */
  label: string;
  /** 対象の説明 (「作業ツリー 12〜15 行目」など) */
  target: string;
  /** 範囲の現在の内容 */
  text: string;
}

export interface LineEditRequest {
  title: string;
  path: string;
  /** 範囲の候補 (1 つならラジオボタンは出さない) */
  scopes: LineEditScope[];
  /** 最初に選ぶ範囲 (scopes の value) */
  scope: string;
}

export interface LineEditResult {
  scope: string;
  text: string;
}

interface Store {
  req: LineEditRequest | null;
  resolve: ((v: LineEditResult | null) => void) | null;
  show: (req: LineEditRequest, resolve: (v: LineEditResult | null) => void) => void;
  close: () => void;
}

const useStore = create<Store>((set) => ({
  req: null,
  resolve: null,
  show: (req, resolve) => set({ req, resolve }),
  close: () => set({ req: null, resolve: null }),
}));

export function openLineEditDialog(req: LineEditRequest): Promise<LineEditResult | null> {
  return new Promise((resolve) => {
    // 前の要求が残っていればキャンセル扱いにする
    useStore.getState().resolve?.(null);
    useStore.getState().show(req, resolve);
  });
}

export function LineEditDialog() {
  const { req, resolve, close } = useStore();
  const [text, setText] = useState('');
  const [scopeValue, setScopeValue] = useState('');
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!req) return;
    const first = req.scopes.find((s) => s.value === req.scope) ?? req.scopes[0];
    setScopeValue(first?.value ?? '');
    setText(first?.text ?? '');
    requestAnimationFrame(() => textRef.current?.focus());
  }, [req]);

  const scope = req?.scopes.find((s) => s.value === scopeValue) ?? null;

  const finish = (value: LineEditResult | null) => {
    resolve?.(value);
    close();
  };

  const changed = scope !== null && text !== scope.text;
  const submit = () => {
    if (scope && changed) finish({ scope: scope.value, text });
  };

  /** 範囲の切替。編集中なら確認のうえ編集内容を破棄して、切替先の内容にする */
  const switchScope = async (next: LineEditScope) => {
    if (next.value === scopeValue) return;
    if (changed && !(await confirmDialog('編集内容を破棄', '未保存の編集内容があります。破棄して切り替えますか?', true))) {
      return;
    }
    setScopeValue(next.value);
    setText(next.text);
    requestAnimationFrame(() => textRef.current?.focus());
  };

  // textarea の Enter は改行。Ctrl+Enter (mac は ⌘+Enter) で適用
  const dialogRef = useDialogKeys({
    enabled: !!req,
    onEnter: changed ? submit : null,
    onEscape: () => finish(null),
  });

  if (!req || !scope) return null;

  const lineCount = text === '' ? 0 : text.split('\n').length;

  return (
    <div ref={dialogRef} className={cx('dialog-backdrop')} onMouseDown={() => finish(null)}>
      <div className={cx('dialog line-edit-dialog')} onMouseDown={(e) => e.stopPropagation()}>
        <div className={cx('dialog-title')}>{req.title}</div>
        <div className={cx('le-info')}>
          <span className={cx('le-path')} title={req.path}>
            {req.path}
          </span>
          <span className={cx('le-target')}>{scope.target}</span>
        </div>
        {req.scopes.length > 1 && (
          <div className={cx('le-scopes')} role="radiogroup">
            {req.scopes.map((s) => (
              <label key={s.value} className={cx('le-scope')}>
                <input
                  type="radio"
                  name="line-edit-scope"
                  checked={s.value === scopeValue}
                  onChange={() => void switchScope(s)}
                />
                <span>{s.label}</span>
              </label>
            ))}
          </div>
        )}
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
          <button className={cx('btn primary')} disabled={!changed} onClick={submit}>
            適用
          </button>
        </div>
      </div>
    </div>
  );
}
