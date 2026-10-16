import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import styles from './Review.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

export interface BranchOption {
  /** 表示名 (remotes/ を落とした形: origin/foo) */
  name: string;
  group: 'local' | 'remote';
  /** 現在チェックアウト中のブランチ */
  current?: boolean;
}

const GROUP_LABEL: Record<BranchOption['group'], string> = { local: 'ローカル', remote: 'リモート' };

/** 一致した部分を強調して表示する */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className={cx('rv-combo-mark')}>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/**
 * ブランチ選択のコンボボックス。
 * 入力した文字列で候補を絞り込み (部分一致・大文字小文字を区別しない)、確定するとチップになる。
 * チップの × で解除して入力に戻る。
 * 候補を開いている間の Enter / Escape は、ダイアログの既定ボタン / キャンセルより優先する
 * (lib/dialogKeys.ts が role="combobox" + aria-expanded を見て譲る)。
 */
export function BranchCombobox({
  options,
  value,
  onChange,
  placeholder = 'ブランチ名で絞り込み',
}: {
  /** ローカル → リモートの順に並んだ候補 */
  options: BranchOption[];
  value: string;
  onChange: (name: string) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** チップの × で解除した直後は、入力欄にフォーカスを移して候補を開く */
  const focusAfterClear = useRef(false);
  const listId = useId();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;
  }, [options, query]);

  useEffect(() => setActive(0), [query, open]);

  // キー操作で移動した候補を見える位置へ
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  useEffect(() => {
    if (value || !focusAfterClear.current) return;
    focusAfterClear.current = false;
    inputRef.current?.focus();
  }, [value]);

  const choose = (name: string) => {
    onChange(name);
    setQuery('');
    setOpen(false);
  };

  if (value) {
    return (
      <div className={cx('rv-combo')}>
        <span className={cx('rv-chip')} title={value}>
          <span className={cx('rv-chip-text')}>{value}</span>
          <button
            type="button"
            className={cx('rv-chip-x')}
            title="選択を解除"
            onClick={() => {
              focusAfterClear.current = true;
              onChange('');
            }}
          >
            ×
          </button>
        </span>
      </div>
    );
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) setOpen(true);
        else setActive((i) => Math.min(filtered.length - 1, i + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case 'Enter':
        if (!open) return;
        e.preventDefault();
        if (filtered[active]) choose(filtered[active].name);
        break;
      case 'Escape':
        if (!open) return;
        e.preventDefault();
        setOpen(false);
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  return (
    <div className={cx('rv-combo')}>
      <input
        ref={inputRef}
        className={cx('rv-input')}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        value={query}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onMouseDown={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div className={cx('rv-combo-list')} id={listId} role="listbox" ref={listRef}>
          {filtered.length === 0 ? (
            <div className={cx('rv-combo-empty')}>一致するブランチはありません</div>
          ) : (
            filtered.map((o, i) => (
              <Fragment key={`${o.group}:${o.name}`}>
                {(i === 0 || filtered[i - 1].group !== o.group) && (
                  <div className={cx('rv-combo-group')}>{GROUP_LABEL[o.group]}</div>
                )}
                <div
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  className={cx(`rv-combo-option${i === active ? ' active' : ''}`)}
                  // 入力欄のフォーカスを外さずに確定する (blur で候補が閉じるため)
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(o.name);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className={cx('rv-combo-name')}>
                    <Highlight text={o.name} query={query} />
                  </span>
                  {o.current && <span className={cx('rv-combo-tag')}>現在</span>}
                </div>
              </Fragment>
            ))
          )}
        </div>
      )}
    </div>
  );
}
