import { useEffect, useRef, useState } from 'react';
import { useDialog, type ConfirmResult } from '../stores/dialog';
import styles from './DialogHost.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';
import { useDialogKeys } from '../lib/dialogKeys';

const cx = createCssModuleClassNames(styles);

export function DialogHost() {
  const { current, close } = useDialog();
  const [value, setValue] = useState('');
  const [checked, setChecked] = useState(false);
  const [choice, setChoice] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (current) {
      setValue(current.defaultValue ?? '');
      setChecked(current.checkbox?.checked === true);
      setChoice(current.choices?.value ?? '');
      setTimeout(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        if (current.selectStem && current.defaultValue) {
          const dot = current.defaultValue.lastIndexOf('.');
          el.setSelectionRange(0, dot > 0 ? dot : current.defaultValue.length);
        } else {
          el.select();
        }
      }, 0);
    }
  }, [current]);

  const done = (v: string | boolean | null | ConfirmResult) => {
    current?.resolve(v);
    close();
  };

  /** confirm の戻り値。チェックボックス付きなら { ok, checked }、選択肢付きなら選んだ value (キャンセルは null) を返す */
  const confirmValue = (ok: boolean): boolean | ConfirmResult | string | null =>
    current?.choices ? (ok ? choice : null) : current?.checkbox ? { ok, checked: ok && checked } : ok;

  // Enter = OK / Escape = キャンセル (prompt の入力欄からもそのまま決定できる)
  const dialogRef = useDialogKeys({
    enabled: current !== null,
    onEnter: () => done(current?.kind === 'confirm' ? confirmValue(true) : value),
    onEscape: () => done(current?.kind === 'confirm' ? confirmValue(false) : null),
  });

  if (!current) return null;

  return (
    <div ref={dialogRef} className={cx("dialog-backdrop")} onMouseDown={(e) => e.target === e.currentTarget && done(null)}>
      <div className={cx("dialog")} role="dialog">
        <div className={cx("dialog-title")}>{current.title}</div>
        {current.message && <div className={cx("dialog-message")}>{current.message}</div>}
        {current.kind === 'prompt' && (
          <input
            ref={inputRef}
            className={cx("dialog-input")}
            value={value}
            placeholder={current.placeholder}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        {current.kind === 'confirm' && current.checkbox && (
          <label className={cx("dialog-checkbox")}>
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            <span>{current.checkbox.label}</span>
          </label>
        )}
        {current.kind === 'confirm' && current.choices && (
          <div className={cx("dialog-choices")} role="radiogroup">
            {current.choices.options.map((o) => (
              <label key={o.value} className={cx("dialog-checkbox")}>
                <input
                  type="radio"
                  name="dialog-choice"
                  checked={choice === o.value}
                  onChange={() => setChoice(o.value)}
                />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
        )}
        <div className={cx("dialog-buttons")}>
          <button
            className={cx("btn")}
            onClick={() => done(current.kind === 'confirm' ? confirmValue(false) : null)}
          >
            キャンセル
          </button>
          <button
            className={cx(`btn primary${current.danger ? ' danger' : ''}`)}
            onClick={() => done(current.kind === 'confirm' ? confirmValue(true) : value)}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
