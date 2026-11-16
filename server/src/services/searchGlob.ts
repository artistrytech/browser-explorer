/**
 * 検索インデックス・内容検索で使う glob (リポジトリルートからの相対パス、'/' 区切り)。
 *
 * - `/` を含まないパターン (`node_modules`, `*.min.js`) はどの階層の名前にも一致する (先頭に `**` と `/` を補う)
 * - `/` を含むパターン (`client/dist`, `docs/*.md`) はリポジトリルートからのパス。先頭の `/` `./` は無視する
 * - フォルダに一致したら、その中のファイルもすべて一致する
 * - `*` は `/` 以外の 0 文字以上、`**` は `/` を含む 0 文字以上、`?` は 1 文字、`{a,b}` はどちらか、`[abc]` は文字クラス
 * - 大文字小文字は区別しない
 */

function globBody(glob: string): string {
  let re = '';
  let inGroup = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      inGroup++;
      re += '(?:';
    } else if (c === '}' && inGroup > 0) {
      inGroup--;
      re += ')';
    } else if (c === ',' && inGroup > 0) {
      re += '|';
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) {
        re += '\\[';
      } else {
        let cls = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        re += `[${cls}]`;
        i = end;
      }
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  while (inGroup-- > 0) re += ')';
  return re;
}

/** パターンを正規化する (空なら null) */
function normalizePattern(pattern: string): string | null {
  let p = pattern.trim().replace(/\\/g, '/');
  if (!p) return null;
  p = p.replace(/^\.\//, '');
  const anchored = p.startsWith('/');
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!p) return null;
  if (!anchored && !p.includes('/') && !p.startsWith('**')) p = `**/${p}`;
  return p;
}

function compileAll(patterns: string[]): RegExp[] {
  const res: RegExp[] = [];
  for (const raw of patterns) {
    const p = normalizePattern(raw);
    if (!p) continue;
    try {
      res.push(new RegExp(`^${globBody(p)}$`, 'i'));
    } catch {
      /* 不正なパターンは無視する */
    }
  }
  return res;
}

/** パス (または祖先のフォルダ) がどれかのパターンに一致するかを返す関数。パターンが空なら null */
export function compileGlobs(patterns: string[]): ((rel: string) => boolean) | null {
  const res = compileAll(patterns);
  if (res.length === 0) return null;
  return (rel: string) => {
    // フォルダに一致すれば中身も一致とみなすので、祖先のパスも順に試す
    let i = rel.indexOf('/');
    while (i >= 0) {
      const head = rel.slice(0, i);
      if (res.some((r) => r.test(head))) return true;
      i = rel.indexOf('/', i + 1);
    }
    return res.some((r) => r.test(rel));
  };
}

/** パス自身だけを見る一致判定 (祖先は見ない)。フォルダを辿りながら枝を刈るときに使う */
export function compileGlobsSelf(patterns: string[]): ((rel: string) => boolean) | null {
  const res = compileAll(patterns);
  if (res.length === 0) return null;
  return (rel: string) => res.some((r) => r.test(rel));
}

/** カンマ区切りの入力 (内容検索の「含めるファイル」「除外するファイル」) をパターンの配列にする。{a,b} の中のカンマは区切らない */
export function splitGlobList(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of input) {
    if (c === '{') depth++;
    else if (c === '}' && depth > 0) depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
