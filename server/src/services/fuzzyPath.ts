/**
 * ファイルパスのあいまい一致 (クイックオープン用。VSCode の Ctrl+P と同様)。
 * 入力の文字がパスに順に現れれば一致とし、次の位置ほど点を高くする:
 * - ファイル名 (最後の / より後) の中での一致
 * - 連続した一致
 * - 語の先頭 (/ _ - . 空白の直後、camelCase の大文字) での一致
 * 短いパスほど上に並べる。
 */

export interface PathMatch {
  score: number;
  /** 一致した文字の位置 (強調表示用) */
  indices: number[];
}

const NEG = -1e9;

/** 作業用の配列 (呼び出しごとに確保しないよう使い回す) */
let rowPrev = new Float64Array(256);
let rowCur = new Float64Array(256);
let back = new Int32Array(256 * 16);

function ensure(n: number, m: number): void {
  if (rowPrev.length < n) {
    rowPrev = new Float64Array(n * 2);
    rowCur = new Float64Array(n * 2);
  }
  if (back.length < n * m) back = new Int32Array(n * m * 2);
}

function boundaryBonus(text: string, j: number): number {
  if (j === 0) return 6;
  const prev = text[j - 1];
  if (prev === '/') return 8;
  if (prev === '_' || prev === '-' || prev === '.' || prev === ' ') return 6;
  const c = text[j];
  if (c >= 'A' && c <= 'Z' && prev >= 'a' && prev <= 'z') return 5;
  return 0;
}

/**
 * query は小文字・空白なしにしたもの。text は相対パス ('/' 区切り)。一致しなければ null
 */
export function fuzzyMatchPath(query: string, text: string, lower: string = text.toLowerCase()): PathMatch | null {
  const m = query.length;
  const n = text.length;
  if (m === 0) return { score: 0, indices: [] };
  if (m > n) return null;
  // 先に、文字が順に現れるかだけを安く確かめる
  let k = 0;
  for (let j = 0; j < n && k < m; j++) if (lower.charCodeAt(j) === query.charCodeAt(k)) k++;
  if (k < m) return null;

  ensure(n, m);
  const baseStart = text.lastIndexOf('/') + 1;
  let prev = rowPrev;
  let cur = rowCur;

  for (let i = 0; i < m; i++) {
    const qc = query.charCodeAt(i);
    // prev[0..j-2] の最大値 (飛び飛びの一致の直前の位置)
    let runMax = NEG;
    let runIdx = -1;
    for (let j = 0; j < n; j++) {
      if (i > 0 && j >= 2 && prev[j - 2] > runMax) {
        runMax = prev[j - 2];
        runIdx = j - 2;
      }
      if (lower.charCodeAt(j) !== qc) {
        cur[j] = NEG;
        continue;
      }
      const base = 1 + boundaryBonus(text, j) + (j >= baseStart ? 3 : 0);
      if (i === 0) {
        // 先頭の文字は、パスの前の方 / ファイル名の先頭に近いほど少し高くする
        cur[j] = base - Math.min(j, 40) * 0.02;
        back[j] = -1;
        continue;
      }
      let best = NEG;
      let from = -1;
      if (j >= 1 && prev[j - 1] > NEG) {
        best = prev[j - 1] + 5; // 連続
        from = j - 1;
      }
      if (runMax > NEG && runMax - 1 > best) {
        best = runMax - 1; // 間が空く
        from = runIdx;
      }
      if (from < 0) {
        cur[j] = NEG;
        continue;
      }
      cur[j] = best + base;
      back[i * n + j] = from;
    }
    const t = prev;
    prev = cur;
    cur = t;
  }

  let end = -1;
  let score = NEG;
  for (let j = 0; j < n; j++) {
    if (prev[j] > score) {
      score = prev[j];
      end = j;
    }
  }
  if (end < 0 || score <= NEG / 2) return null;

  const indices = new Array<number>(m);
  let j = end;
  for (let i = m - 1; i >= 0; i--) {
    indices[i] = j;
    j = i > 0 ? back[i * n + j] : -1;
  }
  if (indices[0] >= baseStart) score += 10; // すべてファイル名の中
  const baseLower = lower.slice(baseStart);
  if (baseLower.startsWith(query)) score += 15;
  if (baseLower === query || baseLower.replace(/\.[^.]*$/, '') === query) score += 20;
  score -= n * 0.05;
  return { score, indices };
}
