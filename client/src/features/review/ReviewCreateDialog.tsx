import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { useReview } from '../../stores/review';
import { toastError } from '../../stores/toast';
import type { GitBranch } from '../../types';
import styles from './Review.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

interface CreateDialogStore {
  open: boolean;
  repo: string;
  show: (repo: string) => void;
  close: () => void;
}

const useCreateDialog = create<CreateDialogStore>((set) => ({
  open: false,
  repo: '',
  show: (repo) => set({ open: true, repo }),
  close: () => set({ open: false }),
}));

export function openReviewCreateDialog(repo: string): void {
  useCreateDialog.getState().show(repo);
}

/** ブランチ一覧の表示名 (remotes/origin/foo → origin/foo) */
function shortName(b: GitBranch): string {
  return b.name.replace(/^remotes\//, '');
}

/**
 * レビュー作成: 比較する 2 ブランチを選ぶ。
 * 差分は GitHub の PR と同じ three-dot (base...head) で、
 * 作成時点の merge-base と head のコミットを固定する。
 */
export function ReviewCreateDialog() {
  const { open, repo, close } = useCreateDialog();
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setBusy(false);
    api
      .gitBranches(repo)
      .then((r) => {
        setBranches(r.branches);
        // 既定は「現在のブランチ」を、既定ブランチ (main 等) に取り込む向き
        setHead(r.current || '');
        const def = r.defaultBranch && r.defaultBranch !== r.current ? r.defaultBranch : '';
        setBase(def || r.branches.map(shortName).find((n) => n !== r.current) || '');
      })
      .catch(toastError);
  }, [open, repo]);

  if (!open) return null;

  const locals = branches.filter((b) => !b.name.startsWith('remotes/')).map(shortName);
  const remotes = branches
    .filter((b) => b.name.startsWith('remotes/') && !/^remotes\/[^/]+\/HEAD$/.test(b.name))
    .map(shortName);
  const same = base === head;
  const canCreate = !!base && !!head && !same && !busy;

  const create = async () => {
    setBusy(true);
    try {
      const { review } = await api.reviewCreate({ repo, title: title.trim(), baseBranch: base, headBranch: head });
      close();
      await useReview.getState().loadList(repo).catch(() => undefined);
      useReview.getState().open(review.id);
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };

  const branchSelect = (value: string, onChange: (v: string) => void) => (
    <select className={cx('rv-select')} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">(選択してください)</option>
      <optgroup label="ローカル">
        {locals.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </optgroup>
      {remotes.length > 0 && (
        <optgroup label="リモート">
          {remotes.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );

  return (
    <div className={cx('dialog-backdrop')} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={cx('dialog rv-create')}>
        <div className={cx('dialog-title')}>レビューを作成</div>
        <div className={cx('rv-form-grid')}>
          <label>レビュー対象 (head)</label>
          {branchSelect(head, setHead)}
          <label>取り込み先 (base)</label>
          {branchSelect(base, setBase)}
          <label>レビュー名</label>
          <input
            className={cx('rv-input')}
            value={title}
            placeholder={head && base ? `${head} → ${base}` : '(自動)'}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className={cx('rv-note')}>
          {base && head && !same
            ? `${base} から分岐したあとの ${head} の変更が対象です (git diff ${base}...${head})。作成時点のコミットを固定するため、あとからブランチが進んでも表示は変わりません。`
            : '比較する 2 つのブランチを選んでください。'}
          {same && <span className={cx('rv-warn')}> 同じブランチは指定できません。</span>}
        </div>
        <div className={cx('dialog-buttons')}>
          <button className={cx('btn')} onClick={close}>
            キャンセル
          </button>
          <button className={cx('btn primary')} disabled={!canCreate} onClick={() => void create()}>
            {busy ? '作成中…' : '作成'}
          </button>
        </div>
      </div>
    </div>
  );
}
