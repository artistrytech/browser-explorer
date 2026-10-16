import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { useReview } from '../../stores/review';
import { useSettings } from '../../stores/settings';
import { toastError } from '../../stores/toast';
import { backupBranchRegex } from '../../lib/backupBranch';
import { BranchCombobox, type BranchOption } from './BranchCombobox';
import type { GitBranch } from '../../types';
import styles from './Review.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';
import { useDialogKeys } from '../../lib/dialogKeys';

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

/** レビュー対象: HEAD (現在のチェックアウトに追従) か、特定のブランチか */
type Target = 'head' | 'branch';

/** ダイアログの選択 (対象の種類・バックアップ除外) は次回も引き継ぐ */
const PREFS_KEY = 'review:create:prefs';

interface CreatePrefs {
  target: Target;
  excludeBackup: boolean;
}

function loadPrefs(): CreatePrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<CreatePrefs>;
    return { target: p.target === 'head' ? 'head' : 'branch', excludeBackup: p.excludeBackup !== false };
  } catch {
    return { target: 'branch', excludeBackup: true };
  }
}

function savePrefs(p: CreatePrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* 無視 */
  }
}

/**
 * レビュー作成: 比較する 2 ブランチを選ぶ。
 * 差分は GitHub の PR と同じ three-dot (base...head)。
 * 対象がブランチなら作成時点の merge-base と head のコミットを固定し、
 * HEAD なら固定せず、開くたびに現在の HEAD との差分を取り直す。
 */
export function ReviewCreateDialog() {
  const { open, repo, close } = useCreateDialog();
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [target, setTarget] = useState<Target>('branch');
  const [excludeBackup, setExcludeBackup] = useState(true);
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const backupPattern = useSettings((s) => s.settings.backupBranchPattern);

  useEffect(() => {
    if (!open) return;
    const prefs = loadPrefs();
    setTarget(prefs.target);
    setExcludeBackup(prefs.excludeBackup);
    setTitle('');
    setBusy(false);
    setBase('');
    setHead('');
    api
      .gitBranches(repo)
      .then((r) => {
        setBranches(r.branches);
        setCurrent(r.current || null);
        // 既定は「現在のブランチ」を、既定ブランチ (main 等) に取り込む向き
        setHead(r.current || '');
        const def = r.defaultBranch && r.defaultBranch !== r.current ? r.defaultBranch : '';
        setBase(def || r.branches.map(shortName).find((n) => n !== r.current) || '');
      })
      .catch(toastError);
  }, [open, repo]);

  const changePrefs = (p: Partial<CreatePrefs>) => {
    const next = { target, excludeBackup, ...p };
    setTarget(next.target);
    setExcludeBackup(next.excludeBackup);
    savePrefs(next);
  };

  // バックアップの判定はブランチタブと同じ (ローカルブランチのうち、名前が設定のパターンに一致するもの)
  const backupRe = excludeBackup ? backupBranchRegex(backupPattern) : null;
  const options: BranchOption[] = [
    ...branches
      .filter((b) => !b.name.startsWith('remotes/') && !backupRe?.test(b.name))
      .map((b): BranchOption => ({ name: shortName(b), group: 'local', current: b.name === current })),
    ...branches
      .filter((b) => b.name.startsWith('remotes/') && !/^remotes\/[^/]+\/HEAD$/.test(b.name))
      .map((b): BranchOption => ({ name: shortName(b), group: 'remote' })),
  ];

  const toHead = target === 'head';
  const headRef = toHead ? 'HEAD' : head;
  const same = !toHead && !!base && base === head;
  /** HEAD が取り込み先と同じブランチ上にある (差分は空。HEAD が別ブランチへ移れば出る) */
  const headOnBase = toHead && !!base && base === current;
  const canCreate = !!base && !!headRef && !same && !busy;

  const create = async () => {
    setBusy(true);
    try {
      const { review } = await api.reviewCreate({ repo, title: title.trim(), baseBranch: base, headBranch: headRef });
      close();
      await useReview.getState().loadList(repo).catch(() => undefined);
      useReview.getState().open(review.id);
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };

  const dialogRef = useDialogKeys({
    enabled: open,
    onEnter: canCreate ? () => void create() : null,
    onEscape: close,
  });

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      className={cx('dialog-backdrop')}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div className={cx('dialog rv-create')}>
        <div className={cx('dialog-title')}>レビューを作成</div>
        <div className={cx('rv-form-grid')}>
          <label>レビュー対象</label>
          <div className={cx('rv-radio-row')}>
            <label className={cx('rv-radio')}>
              <input type="radio" checked={toHead} onChange={() => changePrefs({ target: 'head' })} />
              HEAD{current ? ` (${current})` : ''}
            </label>
            <label className={cx('rv-radio')}>
              <input type="radio" checked={!toHead} onChange={() => changePrefs({ target: 'branch' })} />
              ブランチを指定
            </label>
          </div>
          {!toHead && (
            <>
              <label>対象ブランチ (head)</label>
              <BranchCombobox options={options} value={head} onChange={setHead} />
            </>
          )}
          <label>取り込み先 (base)</label>
          <BranchCombobox options={options} value={base} onChange={setBase} />
          <span />
          <label className={cx('rv-check')}>
            <input
              type="checkbox"
              checked={excludeBackup}
              onChange={(e) => changePrefs({ excludeBackup: e.target.checked })}
            />
            バックアップブランチを候補から除外する
          </label>
          <label>レビュー名</label>
          <input
            className={cx('rv-input')}
            value={title}
            placeholder={headRef && base ? `${headRef} → ${base}` : '(自動)'}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className={cx('rv-note')}>
          {!base || !headRef
            ? '比較する 2 つのブランチを選んでください。'
            : toHead
              ? `${base} から分岐したあとの HEAD の変更が対象です (git diff ${base}...HEAD)。コミットは固定せず、コミットやブランチの切り替えで HEAD が動くと差分も自動で更新されます。コメントは保存されません (入力欄の内容をコピーして使います)。`
              : same
                ? ''
                : `${base} から分岐したあとの ${head} の変更が対象です (git diff ${base}...${head})。作成時点のコミットを固定するため、あとからブランチが進んでも表示は変わりません。`}
          {same && <span className={cx('rv-warn')}>同じブランチは指定できません。</span>}
          {headOnBase && (
            <span className={cx('rv-warn')}> 現在 HEAD は {base} 上にあるため、差分は空になります。</span>
          )}
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
