import { useEffect, useRef, useState } from 'react';
import { useDialog } from '../stores/dialog';
import styles from './DialogHost.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

export function DialogHost() {
  const { current, close } = useDialog();
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (current) {
      setValue(current.defaultValue ?? '');
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

  const done = (v: string | boolean | null) => {
    current.resolve(v);
    close();
  };

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
        <div className={cx("dialog-buttons")}>
          <button className={cx("btn")} onClick={() => done(current.kind === 'confirm' ? false : null)}>
            キャンセル
          </button>
          <button
            className={cx(`btn primary${current.danger ? ' danger' : ''}`)}
            onClick={() => done(current.kind === 'confirm' ? true : value)}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
