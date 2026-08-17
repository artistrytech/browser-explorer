import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useGit, type LogFilter } from '../../stores/git';
import { fileIcon } from '../../lib/paths';
import type { FsEntry } from '../../types';
import styles from './LogPathFilter.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * ログのパス絞り込み入力 (002.md §1)。
 * ファイルタブの右クリック →「Gitログ」だけでなく、ログタブから直接パスを打って絞り込む。
 *
 * 補完は Windows の「ファイル名を指定して実行」と同じ考え方で、
 * 入力中のパスの「親フォルダ直下」を一覧し、打ちかけの名前で前方一致させる。
 * 候補を選ぶとフォルダなら末尾に '/' を足して次の階層へ進む。
 */

/** 候補の最大表示件数 (巨大フォルダで一覧が重くならないように) */
const MAX_SUGGESTIONS = 300;

/** 入力が落ち着いてから絞り込むまでの待ち時間 (ms) */
const APPLY_DELAY = 400;

/** 入力を「親フォルダ (末尾の / を含む)」と「入力途中の名前」に分ける */
function splitPath(v: string): [dir: string, name: string] {
  const i = v.lastIndexOf('/');
  return i < 0 ? ['', v] : [v.slice(0, i + 1), v.slice(i + 1)];
}

/** 絞り込みに使う形へ整える (先頭の ./ と /、末尾の / を落とす) */
function normalizeInput(v: string): string {
  return v.trim().replace(/^\.?\/+/, '').replace(/\/+$/, '');
}

export function LogPathFilter({ repoRoot, filter }: { repoRoot: string; filter: LogFilter | null }) {
  const [value, setValue] = useState(filter?.path ?? '');
  /** 現在の親フォルダ直下のエントリ (前方一致で絞る前) */
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [listOpen, setListOpen] = useState(false);
  /** 候補一覧のカーソル位置。-1 は「候補未選択 (入力中の文字列がそのまま対象)」 */
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** フォルダ単位の一覧キャッシュ (打鍵のたびに読み直さない) */
  const cache = useRef(new Map<string, FsEntry[]>());
  /** 現在適用済みのパス。入力欄の再適用・上書きの判定に使う */
  const applied = useRef(filter?.path ?? '');
  /** 適用の世代番号 (実体の確認が非同期なので、古い結果で上書きしない) */
  const applySeq = useRef(0);

  const [dirPart, namePart] = splitPath(value);

  // 外から絞り込みが変わったら (ファイルタブからの「Gitログ」・解除) 入力欄も合わせる。
  // 自動適用による変化では入力中の文字列 (末尾の / など) を書き換えない
  useEffect(() => {
    const path = filter?.path ?? '';
    if (path === applied.current) return;
    applied.current = path;
    setValue(path);
  }, [filter]);

  // リポジトリが変われば別物なのでキャッシュを捨てる
  useEffect(() => {
    cache.current.clear();
    setEntries([]);
  }, [repoRoot]);

  // 親フォルダの一覧を取得 (一覧を開いている間だけ)
  useEffect(() => {
    if (!listOpen) return;
    const cached = cache.current.get(dirPart);
    if (cached) {
      setEntries(cached);
      return;
    }
    let stale = false;
    api
      .list(dirPart ? `${repoRoot}/${dirPart}` : repoRoot)
      .then((r) => {
        if (stale) return;
        // フォルダを先に、その中は名前順。.git はログの対象になり得ないので出さない
        const list = r.entries
          .filter((e) => !(dirPart === '' && e.name === '.git'))
          .sort((a, b) => {
            const aDir = a.type === 'dir';
            const bDir = b.type === 'dir';
            return aDir === bDir ? a.name.localeCompare(b.name) : aDir ? -1 : 1;
          });
        cache.current.set(dirPart, list);
        setEntries(list);
      })
      .catch(() => {
        if (!stale) setEntries([]); // 存在しないフォルダ = 候補なし (入力途中なので黙って無視)
      });
    return () => {
      stale = true;
    };
  }, [repoRoot, dirPart, listOpen]);

  const lower = namePart.toLowerCase();
  const suggestions = entries
    .filter((e) => e.name.toLowerCase().startsWith(lower))
    .slice(0, MAX_SUGGESTIONS);

  // 候補が変わったらカーソルは未選択に戻す
  useEffect(() => setActive(-1), [dirPart, namePart]);

  // カーソル位置が見えるようにスクロールする
  useEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  /** 候補を確定する。フォルダなら '/' を足して次の階層の候補を出す */
  const complete = (e: FsEntry) => {
    setValue(dirPart + e.name + (e.type === 'dir' ? '/' : ''));
    setActive(-1);
    setListOpen(true);
    inputRef.current?.focus();
  };

  /**
   * 絞り込みを適用する (空なら解除)。
   * replace は打鍵途中の自動適用でブラウザ履歴を汚さないためのフラグ。
   */
  const applyPath = async (path: string, replace: boolean) => {
    applied.current = path;
    const seq = ++applySeq.current;
    // --follow (リネーム追跡) は単一ファイルにだけ意味があるため、実体を見て決める。
    // 既に消えたパス (履歴だけに残るファイル) は判定できないので通常の絞り込みにする
    const stat = path ? await api.stat(`${repoRoot}/${path}`).catch(() => null) : null;
    if (seq !== applySeq.current) return; // 追い越された適用は捨てる
    useGit.getState().showLogFor(path, stat !== null && stat.type !== 'dir', { replace });
  };

  // 入力が落ち着いたら自動で絞り込む (打鍵の途中経過は履歴に積まない)
  useEffect(() => {
    const path = normalizeInput(value);
    if (path === applied.current) return;
    const timer = setTimeout(() => void applyPath(path, true), APPLY_DELAY);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, repoRoot]);

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!listOpen) {
        setListOpen(true);
        return;
      }
      const d = ev.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => Math.min(suggestions.length - 1, Math.max(-1, a + d)));
    } else if (ev.key === 'Tab') {
      // シェルと同じ感覚で、Tab は先頭 (またはカーソル位置) の候補を補完する
      const hit = suggestions[active >= 0 ? active : 0];
      if (hit) {
        ev.preventDefault();
        complete(hit);
      }
    } else if (ev.key === 'Enter') {
      // 候補を選んでいれば確定。選んでいなければ待ち時間を飛ばして即座に絞り込む
      if (active >= 0 && suggestions[active]) {
        complete(suggestions[active]);
      } else {
        setListOpen(false);
        setActive(-1);
        void applyPath(normalizeInput(value), false);
      }
    } else if (ev.key === 'Escape') {
      ev.stopPropagation();
      if (listOpen) {
        setListOpen(false);
        setActive(-1);
      } else {
        setValue(filter?.path ?? ''); // 適用済みの内容へ戻す
      }
    }
  };

  return (
    <div className={cx('log-filter-bar')}>
      <span className={cx('log-filter-label')}>パス絞り込み</span>
      <div className={cx('log-filter-field')}>
        <input
          ref={inputRef}
          className={cx('log-filter-input')}
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="リポジトリ相対パス (↓ / Tab で補完。入力が止まると自動で絞り込み)"
          value={value}
          title={value}
          onChange={(ev) => {
            setValue(ev.target.value);
            setListOpen(true);
          }}
          onFocus={() => setListOpen(true)}
          onBlur={() => setListOpen(false)}
          onKeyDown={onKeyDown}
        />
        {listOpen && suggestions.length > 0 && (
          <div className={cx('log-filter-suggest')} ref={listRef}>
            {suggestions.map((e, i) => (
              <div
                key={e.name}
                data-idx={i}
                className={cx(`log-filter-item${i === active ? ' active' : ''}`)}
                title={dirPart + e.name}
                // mousedown で処理する (blur で一覧が閉じて click が届かなくなるのを防ぐ)
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  complete(e);
                }}
              >
                <span className={cx('log-filter-icon')}>{fileIcon(e)}</span>
                <span className={cx('log-filter-name')}>{e.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
