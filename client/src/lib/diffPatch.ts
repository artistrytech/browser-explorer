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

/** Hunk 本文 1 行に対応する行番号 (対応が無い側は null) */
export interface HunkLineNo {
  /** 変更前 (左) の行番号。追加行は null */
  old: number | null;
  /** 変更後 (右) の行番号。削除行は null */
  new: number | null;
}

/**
 * Hunk 本文の各行に、@@ ヘッダの開始行から数えた行番号を割り当てる。
 * 戻り値は hunk.lines と同じ長さ・同じ並び ("\\ No newline" 行は両方 null)。
 */
export function hunkLineNumbers(hunk: Hunk): HunkLineNo[] {
  const { oldStart, newStart } = parseHunkHeader(hunk.header);
  let oldNo = Number(oldStart);
  let newNo = Number(newStart);
  return hunk.lines.map((line) => {
    const tag = line[0];
    if (tag === '+') return { old: null, new: newNo++ };
    if (tag === '-') return { old: oldNo++, new: null };
    if (tag === '\\') return { old: null, new: null };
    return { old: oldNo++, new: newNo++ }; // 文脈行 (想定外の行も文脈扱い)
  });
}

/** その行が選択対象 (追加/削除) になり得るか */
export function isChangeLine(line: string): boolean {
  return line[0] === '+' || line[0] === '-';
}

/* ---------- 行内の変更箇所 (word diff) ---------- */

/** 行内の変更範囲 [開始, 終了) (行頭のタグ文字を除いた本文の文字位置) */
export type WordRange = [number, number];

/**
 * 変更が行のこの割合を超えたら「行ごと書き換わった」とみなし、行内強調はしない。
 * (ほぼ別物の行で断片的に一致した部分を残すと、かえって読みにくいため)
 */
const WORD_DIFF_MAX_RATIO = 0.6;

/** サロゲートペアの途中で切らないように境界を 1 文字戻す */
function safeBoundary(text: string, at: number): number {
  const code = text.charCodeAt(at - 1);
  return at > 0 && code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

/**
 * 対応する削除行 / 追加行の、変更された範囲を求める。
 * 前方一致と後方一致を取り除いた「真ん中」を変更箇所とみなす単純な方式で、
 * 識別子の書き換えや引数の追加のような小さな変更をそのまま拾える。
 * 変更が大きい場合 (行の 6 割超) は null を返し、行全体の色分けに任せる。
 */
export function intraLineRanges(
  oldText: string,
  newText: string,
): { old: WordRange; new: WordRange } | null {
  if (oldText === newText) return null;
  const minLen = Math.min(oldText.length, newText.length);
  const maxLen = Math.max(oldText.length, newText.length);
  if (maxLen === 0) return null;

  let prefix = 0;
  while (prefix < minLen && oldText[prefix] === newText[prefix]) prefix++;
  prefix = safeBoundary(oldText, prefix);

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }
  suffix = oldText.length - safeBoundary(oldText, oldText.length - suffix);

  const oldChanged = oldText.length - prefix - suffix;
  const newChanged = newText.length - prefix - suffix;
  // サロゲートペアの調整で前後が重なった場合は範囲を決められない
  if (oldChanged < 0 || newChanged < 0) return null;
  if (Math.max(oldChanged, newChanged) > maxLen * WORD_DIFF_MAX_RATIO) return null;
  return { old: [prefix, prefix + oldChanged], new: [prefix, prefix + newChanged] };
}

/**
 * Hunk 内で対応する削除行と追加行の組 (削除行の位置, 追加行の位置) を返す。
 * 連続した削除の並びの直後に、同じ本数の追加が続く場合のみ 1 対 1 で対応させる
 * (本数が違う場合は対応が一意に決まらないので、行内強調はあきらめる)。
 */
export function pairedLines(hunk: Hunk): [number, number][] {
  const pairs: [number, number][] = [];
  let i = 0;
  while (i < hunk.lines.length) {
    if (hunk.lines[i][0] !== '-') {
      i++;
      continue;
    }
    let del = i;
    while (del < hunk.lines.length && hunk.lines[del][0] === '-') del++;
    let add = del;
    while (add < hunk.lines.length && hunk.lines[add][0] === '+') add++;
    const dels = del - i;
    if (dels === add - del) {
      for (let k = 0; k < dels; k++) pairs.push([i + k, del + k]);
    }
    i = Math.max(add, del);
  }
  return pairs;
}
