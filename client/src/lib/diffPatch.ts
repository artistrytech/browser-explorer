/**
 * unified diff (1 ファイル分) のパースと、Hunk・行単位の部分ステージ/解除用パッチ生成。
 *
 * 生成したパッチはサーバの /git/apply-patch (git apply --cached [--reverse] --recount) に渡す。
 * 行単位パッチの変換規則は git add -p / lazygit と同じ:
 *   - 文脈行 ' ' : そのまま
 *   - 追加 '+'   : 選択なら '+' / 非選択かつ reverse なら ' '(文脈化) / 非選択かつ forward なら破棄
 *   - 削除 '-'   : 選択なら '-' / 非選択かつ reverse なら破棄 / 非選択かつ forward なら ' '(文脈化)
 * forward=ステージ (作業ツリー diff を index へ), reverse=解除 (index diff を --reverse で index へ)。
 * 行番号のズレは git apply --recount が吸収するため、@@ の開始行はそのまま流用する。
 */

export interface Hunk {
  /** @@ で始まるヘッダ行 */
  header: string;
  /** ヘッダを除いた本文行 (先頭に ' ' / '+' / '-' / '\\') */
  lines: string[];
}

export interface FileDiff {
  /** 最初の @@ より前のファイルヘッダ (diff --git / index / --- / +++) */
  header: string[];
  hunks: Hunk[];
}

/** 1 ファイル分の unified diff を、ファイルヘッダと Hunk 配列に分解する */
export function parseFileDiff(diff: string): FileDiff {
  // 行区切りは '\n' のみで分割し、各行末の '\r' (CRLF) は保持したまま扱う
  const raw = diff.split('\n');
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop(); // 末尾改行由来の空要素を除去
  const header: string[] = [];
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < raw.length && !raw[i].startsWith('@@')) {
    header.push(raw[i]);
    i++;
  }
  let cur: Hunk | null = null;
  for (; i < raw.length; i++) {
    const line = raw[i];
    if (line.startsWith('@@')) {
      cur = { header: line, lines: [] };
      hunks.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return { header, hunks };
}

/** @@ -a,b +c,d @@ の開始行番号と末尾の見出し (関数名など) を取り出す */
function parseHunkHeader(header: string): { oldStart: string; newStart: string; tail: string } {
  const m = header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
  return { oldStart: m?.[1] ?? '1', newStart: m?.[2] ?? '1', tail: m?.[3] ?? '' };
}

/** "行数を数え直した" 新しい Hunk ヘッダを組み立てる */
function rebuildHeader(orig: string, oldCount: number, newCount: number): string {
  const { oldStart, newStart, tail } = parseHunkHeader(orig);
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${tail}`;
}

/** ファイルヘッダ + 指定 Hunk 群 (丸ごと) のパッチ。Hunk 単位のステージ/解除に使う */
export function buildHunkPatch(header: string[], hunks: Hunk[]): string {
  const body = hunks.flatMap((h) => [h.header, ...h.lines]);
  return [...header, ...body].join('\n') + '\n';
}

/**
 * 1 つの Hunk 内で選択された行だけを対象にしたパッチを組み立てる。
 * selected は「その Hunk の lines 配列のインデックス集合」。reverse は解除方向。
 * 対象となる変更行が 1 つも選択されていなければ null を返す。
 */
export function buildLinesPatch(
  header: string[],
  hunk: Hunk,
  selected: Set<number>,
  reverse: boolean,
): string | null {
  const out: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  let anyChange = false;
  let prevEmitted = true; // 直前のソース行を出力したか (\\ No newline 行の追従用)

  hunk.lines.forEach((line, idx) => {
    const tag = line[0];
    if (tag === '\\') {
      // "\\ No newline at end of file" は直前の行に追従させる
      if (prevEmitted) out.push(line);
      return;
    }
    if (tag === ' ') {
      out.push(line);
      oldCount++;
      newCount++;
      prevEmitted = true;
    } else if (tag === '+') {
      if (selected.has(idx)) {
        out.push(line);
        newCount++;
        anyChange = true;
        prevEmitted = true;
      } else if (reverse) {
        out.push(' ' + line.slice(1)); // 文脈化 (index に残す)
        oldCount++;
        newCount++;
        prevEmitted = true;
      } else {
        prevEmitted = false; // 破棄
      }
    } else if (tag === '-') {
      if (selected.has(idx)) {
        out.push(line);
        oldCount++;
        anyChange = true;
        prevEmitted = true;
      } else if (reverse) {
        prevEmitted = false; // 破棄
      } else {
        out.push(' ' + line.slice(1)); // 文脈化 (index に残す)
        oldCount++;
        newCount++;
        prevEmitted = true;
      }
    } else {
      // 想定外の行はそのまま文脈として扱う
      out.push(line);
      oldCount++;
      newCount++;
      prevEmitted = true;
    }
  });

  if (!anyChange) return null;
  const newHeader = rebuildHeader(hunk.header, oldCount, newCount);
  return [...header, newHeader, ...out].join('\n') + '\n';
}

/** その行が選択対象 (追加/削除) になり得るか */
export function isChangeLine(line: string): boolean {
  return line[0] === '+' || line[0] === '-';
}
