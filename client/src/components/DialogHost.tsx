import { useEffect, useRef, useState } from 'react';
import { useDialog, type ConfirmResult } from '../stores/dialog';
import styles from './DialogHost.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

export function DialogHost() {
  const { current, close } = useDialog();
  const [value, setValue] = useState('');
  const [checked, setChecked] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (current) {
      setValue(current.defaultValue ?? '');
      setChecked(current.checkbox?.checked === true);
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

  if (!current) return null;

  const done = (v: string | boolean | null | ConfirmResult) => {
    current.resolve(v);
    close();
  };

  /** confirm の戻り値。チェックボックス付きなら { ok, checked } を返す */
  const confirmValue = (ok: boolean): boolean | ConfirmResult =>
    current.checkbox ? { ok, checked: ok && checked } : ok;

  return (
    <div className={cx("dialog-backdrop")} onMouseDown={(e) => e.target === e.currentTarget && done(null)}>
      <div className={cx("dialog")} role="dialog">
        <div className={cx("dialog-title")}>{current.title}</div>
        {current.message && <div className={cx("dialog-message")}>{current.message}</div>}
        {current.kind === 'prompt' && (
          <input
            ref={inputRef}
            className={cx("dialog-input")}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') done(value);
              if (e.key === 'Escape') done(null);
            }}
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
