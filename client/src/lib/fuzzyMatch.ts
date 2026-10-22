/** 絞り込みの一致結果。score が大きいほど上に並べる。indices は一致した文字の位置 (強調表示に使う) */
export interface TextMatch {
  score: number;
  indices: number[];
}

/** 語の先頭か (直前が区切り文字) */
function isWordStart(text: string, i: number): boolean {
  return i === 0 || /[\s:()（）\-_/\\.]/.test(text[i - 1]);
}

/**
 * 入力 (query) で text を絞り込む。大文字小文字は区別しない。一致しなければ null。
 * 1. スペース区切りの語がすべて部分一致する (先頭・語頭での一致ほど上に並べる)
 * 2. 1 が無ければ、文字が順に現れる飛び飛びの一致 (`spl` → `Sync: Pull` のような打ち方)
 */
export function matchText(query: string, text: string): TextMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();

  const indices = new Set<number>();
  let score = 0;
  let allFound = true;
  for (const word of q.split(/\s+/)) {
    const i = t.indexOf(word);
    if (i < 0) {
      allFound = false;
      break;
    }
    for (let k = 0; k < word.length; k++) indices.add(i + k);
    score += i === 0 ? 300 : isWordStart(t, i) ? 200 : 100;
  }
  if (allFound) return { score, indices: [...indices].sort((a, b) => a - b) };

  const seq: number[] = [];
  let from = 0;
  for (const c of q.replace(/\s+/g, '')) {
    const i = t.indexOf(c, from);
    if (i < 0) return null;
    seq.push(i);
    from = i + 1;
  }
  return { score: 10, indices: seq };
}
