import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { useReview } from '../../stores/review';
import { useSettings } from '../../stores/settings';
import { toastError } from '../../stores/toast';
import { backupBranchRegex } from '../../lib/backupBranch';
import { BranchCombobox, type BranchOption } from './BranchCombobox';
import type { GitBranch, ReviewCompare } from '../../types';
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

/** レビュー対象: HEAD (現在のチェックアウトに追従) か、特定のブランチか、コミット (ハッシュを直接入力) か */
type Target = 'head' | 'branch' | 'commit';
/** 取り込み先: ブランチか、コミット (ハッシュを直接入力) か */
type BaseTarget = 'branch' | 'commit';

/** コミットのハッシュとして受け付ける形 (短縮形は 4 文字以上) */
const HASH_RE = /^[0-9a-f]{4,64}$/i;

/** ダイアログの選択 (対象の種類・比較方法・バックアップ除外) は次回も引き継ぐ */
const PREFS_KEY = 'review:create:prefs';

interface CreatePrefs {
  target: Target;
  baseTarget: BaseTarget;
  compare: ReviewCompare;
  excludeBackup: boolean;
}

function loadPrefs(): CreatePrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<CreatePrefs>;
    return {
      target: p.target === 'head' || p.target === 'commit' ? p.target : 'branch',
      baseTarget: p.baseTarget === 'commit' ? 'commit' : 'branch',
      compare: p.compare === 'direct' ? 'direct' : 'merge-base',
      excludeBackup: p.excludeBackup !== false,
    };
  } catch {
    return { target: 'branch', baseTarget: 'branch', compare: 'merge-base', excludeBackup: true };
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
 * レビュー作成: 比較する 2 ブランチ (対象はコミットのハッシュでも可) を選ぶ。
 * 差分は既定では GitHub の PR と同じ three-dot (base...head = 3 点比較)。
 * 2 点比較を選ぶと、base の先端と head を直接比べる (base..head)。
 * 対象がブランチ / コミットなら作成時点の比較の基準と head のコミットを固定し、
 * HEAD なら固定せず、開くたびに現在の HEAD との差分を取り直す。
 */
export function ReviewCreateDialog() {
  const { open, repo, close } = useCreateDialog();
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [target, setTarget] = useState<Target>('branch');
  const [baseTarget, setBaseTarget] = useState<BaseTarget>('branch');
  const [compare, setCompare] = useState<ReviewCompare>('merge-base');
  const [excludeBackup, setExcludeBackup] = useState(true);
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [commit, setCommit] = useState('');
  const [baseCommitText, setBaseCommitText] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const backupPattern = useSettings((s) => s.settings.backupBranchPattern);

  useEffect(() => {
    if (!open) return;
    const prefs = loadPrefs();
    setTarget(prefs.target);
    setBaseTarget(prefs.baseTarget);
    setCompare(prefs.compare);
    setExcludeBackup(prefs.excludeBackup);
    setTitle('');
    setBusy(false);
    setBase('');
    setHead('');
    setCommit('');
    setBaseCommitText('');
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
    const next = { target, baseTarget, compare, excludeBackup, ...p };
    setTarget(next.target);
    setBaseTarget(next.baseTarget);
    setCompare(next.compare);
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
  const byCommit = target === 'commit';
  const commitInput = commit.trim();
  const commitValid = HASH_RE.test(commitInput);
  const headRef = toHead ? 'HEAD' : byCommit ? (commitValid ? commitInput : '') : head;
  /** 表示用の対象名 (コミットは短縮形) */
  const headLabel = byCommit ? commitInput.slice(0, 12) : headRef;
  const baseByCommit = baseTarget === 'commit';
  const baseCommitInput = baseCommitText.trim();
  const baseCommitValid = HASH_RE.test(baseCommitInput);
  /** 取り込み先の指定 (ブランチ名 / ハッシュ)。未確定なら空 */
  const baseRef = baseByCommit ? (baseCommitValid ? baseCommitInput : '') : base;
  /** 表示用の取り込み先名 (コミットは短縮形) */
  const baseLabel = baseByCommit ? baseCommitInput.slice(0, 12) : base;
  const same =
    (target === 'branch' && !baseByCommit && !!base && base === head) ||
    (byCommit && baseByCommit && !!baseRef && baseRef.toLowerCase() === headRef.toLowerCase());
  /** HEAD が取り込み先と同じブランチ上にある (差分は空。HEAD が別ブランチへ移れば出る) */
  const headOnBase = toHead && !baseByCommit && !!base && base === current;
  const canCreate = !!baseRef && !!headRef && !same && !busy;
  const direct = compare === 'direct';
  /** 説明文に出す git diff の書き方 (3 点比較は ...、2 点比較は ..) */
  const range = `${baseLabel}${direct ? '..' : '...'}${toHead ? 'HEAD' : headLabel}`;

  const create = async () => {
    setBusy(true);
    try {
      const { review } = await api.reviewCreate({
        repo,
        title: title.trim(),
        baseBranch: baseRef,
        headBranch: headRef,
        headType: byCommit ? 'commit' : 'branch',
        baseType: baseByCommit ? 'commit' : 'branch',
        compare,
      });
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
              <input
                type="radio"
                checked={target === 'branch'}
                onChange={() => changePrefs({ target: 'branch' })}
              />
              ブランチを指定
            </label>
            <label className={cx('rv-radio')}>
              <input type="radio" checked={byCommit} onChange={() => changePrefs({ target: 'commit' })} />
              コミットを指定
            </label>
          </div>
          {target === 'branch' && (
            <>
              <label>対象ブランチ (head)</label>
              <BranchCombobox options={options} value={head} onChange={setHead} />
            </>
          )}
          {byCommit && (
            <>
              <label>対象コミット (head)</label>
              <input
                className={cx('rv-input rv-hash-input')}
                value={commit}
                spellCheck={false}
                autoComplete="off"
                placeholder="コミットのハッシュ (短縮形可。ログの右クリック →「ハッシュ値をコピー」)"
                onChange={(e) => setCommit(e.target.value)}
              />
            </>
          )}
          <label>取り込み先 (base)</label>
          <div className={cx('rv-radio-row')}>
            <label className={cx('rv-radio')}>
              <input
                type="radio"
                checked={!baseByCommit}
                onChange={() => changePrefs({ baseTarget: 'branch' })}
              />
              ブランチを指定
            </label>
            <label className={cx('rv-radio')}>
              <input type="radio" checked={baseByCommit} onChange={() => changePrefs({ baseTarget: 'commit' })} />
              コミットを指定
            </label>
          </div>
          <span />
          {baseByCommit ? (
            <input
              className={cx('rv-input rv-hash-input')}
              value={baseCommitText}
              spellCheck={false}
              autoComplete="off"
              placeholder="取り込み先コミットのハッシュ (短縮形可)"
              onChange={(e) => setBaseCommitText(e.target.value)}
            />
          ) : (
            <BranchCombobox options={options} value={base} onChange={setBase} />
          )}
          <span />
          <label className={cx('rv-check')}>
            <input
              type="checkbox"
              checked={excludeBackup}
              onChange={(e) => changePrefs({ excludeBackup: e.target.checked })}
            />
            バックアップブランチを候補から除外する
          </label>
          <label>比較方法</label>
          <div className={cx('rv-radio-row')}>
            <label
              className={cx('rv-radio')}
              title="取り込み先から分岐したあとの、対象側の変更だけを表示します (GitHub の PR と同じ)"
            >
              <input type="radio" checked={!direct} onChange={() => changePrefs({ compare: 'merge-base' })} />
              3 点比較 (分岐点から)
            </label>
            <label
              className={cx('rv-radio')}
              title="取り込み先の先端と対象をそのまま比べます。取り込み先側だけで進んだ変更も差分に出ます"
            >
              <input type="radio" checked={direct} onChange={() => changePrefs({ compare: 'direct' })} />
              2 点比較 (ファイルを直接比較)
            </label>
          </div>
          <label>レビュー名</label>
          <input
            className={cx('rv-input')}
            value={title}
            placeholder={headRef && baseRef ? `${headLabel} → ${baseLabel}` : '(自動)'}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className={cx('rv-note')}>
          {!baseRef || !headRef
            ? (byCommit && commitInput && !commitValid) || (baseByCommit && baseCommitInput && !baseCommitValid)
              ? ''
              : byCommit
                ? '取り込み先と、対象コミットのハッシュを指定してください。'
                : baseByCommit
                  ? '取り込み先のコミットのハッシュと、レビュー対象を指定してください。'
                  : '比較する 2 つのブランチを選んでください。'
            : same
              ? ''
              : `${
                direct
                  ? baseByCommit
                    ? `${baseLabel} と ${toHead ? 'HEAD' : headLabel} を直接比較します (git diff ${range})。`
                    : `${baseLabel} の先端と ${toHead ? 'HEAD' : headLabel} を直接比較します (git diff ${range})。${baseLabel} 側だけで進んだ変更も差分に出ます。`
                  : `${baseLabel} から分岐したあとの ${toHead ? 'HEAD' : headLabel} の変更が対象です (git diff ${range})。`
              }${
                toHead
                  ? 'コミットは固定せず、コミットやブランチの切り替えで HEAD が動くと差分も自動で更新されます。コメントは保存されません (入力欄の内容をコピーして使います)。'
                  : byCommit
                      ? '指定したコミットに固定します (ブランチが削除されてもクローズされません)。'
                      : '作成時点のコミットを固定するため、あとからブランチが進んでも表示は変わりません。'
              }`}
          {((byCommit && commitInput && !commitValid) || (baseByCommit && baseCommitInput && !baseCommitValid)) && (
            <span className={cx('rv-warn')}>ハッシュは 16 進数 4 文字以上で入力してください。</span>
          )}
          {same && <span className={cx('rv-warn')}>{baseByCommit ? '同じコミット' : '同じブランチ'}は指定できません。</span>}
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
