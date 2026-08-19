import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { toastError } from '../../stores/toast';
import { parseFileDiff, hunkLineNumbers, type FileDiff } from '../../lib/diffPatch';
import { DiffLineText, useDiffHighlight } from '../../lib/diffHighlight';
import styles from './WorkingDiff.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** 一覧・見出しに出すパス。名前変更・コピーは「変更前 → 変更後」で表示する */
export function commitFileLabel(f: { path: string; oldPath?: string | null }): string {
  return f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
}

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
  oldPath,
  label,
}: {
  repo: string;
  hash: string;
  path: string;
  /** 名前変更されたファイルの変更前パス (変更前の内容を引き当てるのに必要) */
  oldPath?: string | null;
  label?: string;
}) {
  const [parsed, setParsed] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const highlight = useDiffHighlight(parsed, path);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setParsed(null);
    api
      .gitCommitFilePatch(repo, hash, path, oldPath)
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
  }, [repo, hash, path, oldPath]);

  const title = oldPath ? `${oldPath} → ${path}` : path;

  return (
    <div className={cx("work-diff")}>
      <div className={cx("work-diff-file")}>
        <div className={cx("work-diff-head")}>
          <span className={cx("wd-side wd-side-staged")}>{label ?? hash.slice(0, 7)}</span>
          <span className={cx("wd-path")} title={title}>
            {title}
          </span>
        </div>
        {loading ? (
          <div className={cx("empty-hint")}>読み込み中…</div>
        ) : !parsed || parsed.hunks.length === 0 ? (
          // 内容が変わらない名前変更・バイナリ・モード変更のみのファイルは Hunk が無い
          <div className={cx("empty-hint")}>
            {oldPath
              ? '名前の変更のみで、内容の変更はありません'
              : '表示できる差分はありません (バイナリ等)'}
          </div>
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
                        <DiffLineText
                          line={line}
                          render={highlight(hIdx, lIdx)}
                          className={cx("wd-linetext")}
                        />
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
