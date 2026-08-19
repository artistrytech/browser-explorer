import { norm } from './fsService.js';

/** git の -z 付き差分出力 (--name-status / --numstat) の解析。ログ・レビューの両方で使う */

/**
 * -z 付き --name-status の解析。レコードは NUL 区切りで
 *   通常   : "<状態>\0<パス>"
 *   リネーム: "R<類似度>\0<変更前パス>\0<変更後パス>" (コピーは C)
 * の並びになる。変更後パスをキーに、状態と変更前パスを返す。
 */
export function parseNameStatusZ(raw: string): Map<string, { status: string; oldPath: string | null }> {
  const tokens = raw.split('\0').filter((t) => t.length > 0);
  const map = new Map<string, { status: string; oldPath: string | null }>();
  for (let i = 0; i < tokens.length; ) {
    const code = tokens[i++].match(/^([A-Z])\d*$/);
    if (!code) continue; // 想定外の並びは読み飛ばす
    const first = tokens[i++];
    if (first === undefined) break;
    if (code[1] === 'R' || code[1] === 'C') {
      const second = tokens[i++];
      if (second === undefined) break;
      map.set(norm(second), { status: code[1], oldPath: norm(first) });
    } else {
      map.set(norm(first), { status: code[1], oldPath: null });
    }
  }
  return map;
}

/**
 * -z 付き --numstat の解析。レコードは
 *   通常   : "<追加>\t<削除>\t<パス>"
 *   リネーム: "<追加>\t<削除>\t" + "\0<変更前パス>\0<変更後パス>" (3 番目が空)
 * の並びになる。
 */
export function parseNumstatZ(raw: string): { path: string; added: number | null; deleted: number | null }[] {
  const tokens = raw.split('\0').filter((t) => t.length > 0);
  const out: { path: string; added: number | null; deleted: number | null }[] = [];
  for (let i = 0; i < tokens.length; ) {
    const m = tokens[i++].match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!m) continue;
    let p = m[3];
    if (p.length === 0) {
      // リネーム: 変更前・変更後が続く。表示は変更後のパスで行う
      i++; // 変更前パスは name-status 側から取る
      const to = tokens[i++];
      if (to === undefined) break;
      p = to;
    }
    out.push({
      path: norm(p),
      added: m[1] === '-' ? null : Number(m[1]),
      deleted: m[2] === '-' ? null : Number(m[2]),
    });
  }
  return out;
}
