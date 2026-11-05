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

/**
 * バイナリファイルの差分か。
 * git はバイナリの中身を Hunk にせず、ファイルヘッダに
 * "Binary files a/x and b/x differ" (--binary 指定時は "GIT binary patch") を置く。
 */
export function isBinaryDiff(parsed: FileDiff): boolean {
  return parsed.header.some((l) => l.startsWith('Binary files ') || l === 'GIT binary patch');
}

/**
 * 名前変更の差分ヘッダを、変更後パスだけの「修正」のヘッダに組み替える。
 * リネームのヘッダのまま部分解除 (--reverse) すると、選んだ Hunk と一緒に名前まで元に戻るため、
 * 部分ステージ/解除のパッチは変更後パスの内容変更として組み立てる。
 * 名前変更でなければそのまま返す。
 */
export function contentOnlyHeader(header: string[]): string[] {
  if (!header.some((l) => l.startsWith('rename from '))) return header;
  const plus = header.find((l) => l.startsWith('+++ '));
  if (!plus) return header;
  const bName = plus.slice(4); // b/<path> (特殊文字を含むと "b/<path>" のようにクォートされる)
  const aName = bName.replace(/^("?)b\//, '$1a/');
  return header.flatMap((l) => {
    if (l.startsWith('diff --git ')) return [`diff --git ${aName} ${bName}`];
    if (/^(similarity index|dissimilarity index|rename from|rename to) /.test(l)) return [];
    if (l.startsWith('--- ')) return [`--- ${aName}`];
    return [l];
  });
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

/* ---------- 色付けに使うファイル全体との突き合わせ ---------- */

/** ファイル全体をトークナイズに使う上限。これを超えたら Hunk の行だけで色付けする */
const SOURCE_MAX_LENGTH = 2_000_000;

/** Monaco の行分割に合わせる (CR / CRLF / LF)。行末の改行文字は含まれない */
export function splitLines(content: string): string[] {
  return content.split(/\r\n|\r|\n/);
}

/** 差分の行と、ファイルから取り出した行が同じ内容か (CR の有無は無視する) */
function sameLine(diffLine: string, fileLine: string | undefined): boolean {
  return fileLine !== undefined && diffLine.replace(/\r$/, '') === fileLine.replace(/\r$/, '');
}

/**
 * ファイル全体を色付けに使えるなら、その行の配列を返す (使えなければ null)。
 *
 * Hunk の行だけをトークナイズすると、ファイルの途中から始まる Hunk では言語の状態が
 * 初期状態からになる (Python の """ で囲んだ複数行文字列の「閉じ」だけが差分に含まれる場合、
 * そこを「開始」と解釈して以降が文字列として色付けされてしまう)。ファイル全体を渡せば
 * 正しい状態から数えられる。
 *
 * ただし使う前に、行番号で引いた内容が差分の行と全て一致することを確認する。
 * (作業ツリーが書き換わった・改行コードの扱いが違うなどで食い違うと、別の行の内容を
 * 表示してしまうため。1 行でもずれていたら null を返し、Hunk だけの色付けに落とす)
 */
export function usableFileLines(
  parsed: FileDiff,
  side: 'old' | 'new',
  content: string | null | undefined,
): string[] | null {
  if (typeof content !== 'string' || content.length > SOURCE_MAX_LENGTH) return null;
  const lines = splitLines(content);
  for (const hunk of parsed.hunks) {
    const nos = hunkLineNumbers(hunk);
    for (let l = 0; l < hunk.lines.length; l++) {
      const line = hunk.lines[l];
      const tag = line[0];
      if (tag === '\\' || (tag === '-' ? 'old' : 'new') !== side) continue;
      const no = (side === 'old' ? nos[l].old : nos[l].new) ?? 0;
      if (!sameLine(line.slice(1), lines[no - 1])) return null;
    }
  }
  return lines;
}

/* ---------- Hunk・選択行の直接編集 ---------- */

/** 差分の変更後側 (ステージ側はインデックス、変更側は作業ツリー) の行範囲。1 始まり・両端を含む。hi = lo - 1 は lo の前への挿入位置 */
export interface EditRange {
  lo: number;
  hi: number;
}

/**
 * Hunk の指定行 (lines のインデックス) を覆う、変更後側の行範囲を求める。
 * 追加行・文脈行はその行、削除行は変更後側に行が無いので「次の行の前」の挿入位置として扱う。
 * 対象の行が無ければ null
 */
export function hunkEditRange(hunk: Hunk, indices: Iterable<number>): EditRange | null {
  const m = hunk.header.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
  const newStart = Number(m?.[1] ?? 1);
  const newCount = m?.[2] === undefined ? 1 : Number(m[2]);
  // 変更後側が 0 行の Hunk は、開始行が「直前の行」を指す (unified diff の規則)
  let next = newCount === 0 ? newStart + 1 : newStart;
  const pos: EditRange[] = hunk.lines.map((line) => {
    const tag = line[0];
    if (tag === '-' || tag === '\\') return { lo: next, hi: next - 1 };
    const r = { lo: next, hi: next };
    next++;
    return r;
  });
  let lo = Infinity;
  let hi = -Infinity;
  for (const i of indices) {
    const p = pos[i];
    if (!p || hunk.lines[i][0] === '\\') continue;
    lo = Math.min(lo, p.lo);
    hi = Math.max(hi, p.hi);
  }
  if (lo === Infinity) return null;
  return { lo, hi: Math.max(hi, lo - 1) };
}

/** ファイル内容を行に分ける ('\r' は行末に残す)。最後の行に改行が無いか (= "\ No newline") も返す */
function contentLines(content: string): { lines: string[]; noEol: boolean } {
  if (content === '') return { lines: [], noEol: false };
  const lines = content.split('\n');
  const noEol = lines[lines.length - 1] !== '';
  if (!noEol) lines.pop();
  return { lines, noEol };
}

/** 編集ダイアログに出す、範囲の現在の内容 (改行は '\n'、行末の '\r' は除く) */
export function editRangeText(content: string, range: EditRange): string {
  const { lines } = contentLines(content);
  return lines
    .slice(range.lo - 1, range.hi)
    .map((l) => l.replace(/\r$/, ''))
    .join('\n');
}

const NO_EOL = '\\ No newline at end of file';
/** 置き換える範囲の前後に付ける文脈行の数 (git apply が位置を確かめるのに使う) */
const EDIT_CONTEXT = 3;

/**
 * 変更後側のファイル内容 (content) の range を newText で置き換えるパッチを作る。
 * ステージ側は git apply --cached、変更側は作業ツリーへの git apply で当てる。
 * 改行コードは元のファイルに合わせる (CRLF のファイルなら追加行も CRLF)。
 * 内容が変わらなければ null。header はファイルヘッダ (diff --git / --- / +++)
 */
export function buildEditPatch(
  header: string[],
  content: string,
  range: EditRange,
  newText: string,
): string | null {
  const { lines, noEol } = contentLines(content);
  const n = lines.length;
  const { lo, hi } = range;
  if (lo < 1 || hi > n || hi < lo - 1) return null;
  const crlf = /\r\n/.test(content);
  const oldMid = lines.slice(lo - 1, hi);
  const newMid = newText === '' ? [] : newText.split('\n').map((l) => (crlf ? `${l}\r` : l));
  if (oldMid.length === newMid.length && oldMid.every((l, i) => l === newMid[i])) return null;

  let before = lines.slice(Math.max(0, lo - 1 - EDIT_CONTEXT), lo - 1);
  const after = lines.slice(hi, Math.min(n, hi + EDIT_CONTEXT));
  let start = lo - before.length;
  // 改行の無い最終行の直後への挿入は、その最終行も置き換え対象に含める (改行の有無が変わるため)
  if (noEol && after.length === 0 && oldMid.length === 0 && before.length > 0) {
    const last = before[before.length - 1];
    before = before.slice(0, -1);
    oldMid.unshift(last);
    newMid.unshift(last);
  }
  const touchesEnd = noEol && hi + after.length === n;

  const out: string[] = before.map((l) => ` ${l}`);
  oldMid.forEach((l, i) => {
    out.push(`-${l}`);
    if (touchesEnd && after.length === 0 && i === oldMid.length - 1) out.push(NO_EOL);
  });
  newMid.forEach((l, i) => {
    out.push(`+${l}`);
    if (touchesEnd && after.length === 0 && i === newMid.length - 1) out.push(NO_EOL);
  });
  after.forEach((l, i) => {
    out.push(` ${l}`);
    if (touchesEnd && i === after.length - 1) out.push(NO_EOL);
  });
  const oldCount = before.length + oldMid.length + after.length;
  const newCount = before.length + newMid.length + after.length;
  if (oldCount === 0) start = 0;
  return [...header, `@@ -${start},${oldCount} +${newCount === 0 ? 0 : Math.max(start, 1)},${newCount} @@`, ...out].join('\n') + '\n';
}

/**
 * 編集パッチ用のファイルヘッダ (変更後側のパスの内容変更)。
 * 差分のヘッダの +++ 行からパス (特殊文字はクォート済み) を取る。新規・名前変更でも「既存ファイルの修正」にする
 */
export function editPatchHeader(header: string[]): string[] | null {
  const plus = header.find((l) => l.startsWith('+++ '));
  if (!plus || plus === '+++ /dev/null') return null;
  const bName = plus.slice(4);
  const aName = bName.replace(/^("?)b\//, '$1a/');
  return [`diff --git ${aName} ${bName}`, `--- ${aName}`, `+++ ${bName}`];
}
