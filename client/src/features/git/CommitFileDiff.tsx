import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { toastError } from '../../stores/toast';
import { parseFileDiff, hunkLineNumbers, type FileDiff } from '../../lib/diffPatch';
import styles from './WorkingDiff.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * ログタブのプレビュー: コミット内 1 ファイルの差分を表示する。
 * 見た目はコミットタブの WorkingDiff と同じだが、コミット済みのため読み取り専用
 * (Hunk・行のステージ/破棄は無い)。
 * label はヘッダに出す見出し (既定はハッシュ先頭 7 桁。stash@{n} など任意の rev で使う)。
 */
export function CommitFileDiff({
  repo,
  hash,
  path,
  label,
}: {
  repo: string;
  hash: string;
  path: string;
  label?: string;
}) {
  const [parsed, setParsed] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setParsed(null);
    api
      .gitCommitFilePatch(repo, hash, path)
      .then((r) => {
        if (!stale) setParsed(parseFileDiff(r.diff));
      })
      .catch((e) => {
        if (!stale) toastError(e);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true; // 選択が素早く変わった場合、古い応答で上書きしない
    };
  }, [repo, hash, path]);

  return (
    <div className={cx("work-diff")}>
      <div className={cx("work-diff-file")}>
        <div className={cx("work-diff-head")}>
          <span className={cx("wd-side wd-side-staged")}>{label ?? hash.slice(0, 7)}</span>
          <span className={cx("wd-path")} title={path}>
            {path}
          </span>
        </div>
        {loading ? (
          <div className={cx("empty-hint")}>読み込み中…</div>
        ) : !parsed || parsed.hunks.length === 0 ? (
          // バイナリ・モード変更のみのファイルは Hunk が無い
          <div className={cx("empty-hint")}>表示できる差分はありません (バイナリ等)</div>
        ) : (
          parsed.hunks.map((hunk, hIdx) => {
            const lineNos = hunkLineNumbers(hunk);
            return (
              <div key={hIdx} className={cx("wd-hunk")}>
                <div className={cx("wd-hunk-head")}>
                  <span className={cx("wd-hunk-info")}>{hunk.header}</span>
                </div>
                <pre className={cx("diff-view")}>
                  {hunk.lines.map((line, lIdx) => {
                    const tag = line[0];
                    const cls =
                      tag === '+' ? 'diff-add' : tag === '-' ? 'diff-del' : tag === '\\' ? 'diff-meta' : '';
                    const no = lineNos[lIdx];
                    return (
                      <div key={lIdx} className={cx(`diff-line ${cls}`)}>
                        <span className={cx("wd-lineno")} aria-hidden="true">{no.old ?? ''}</span>
                        <span className={cx("wd-lineno")} aria-hidden="true">{no.new ?? ''}</span>
                        <span className={cx("wd-linetext")}>{line || ' '}</span>
                      </div>
                    );
                  })}
                </pre>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
