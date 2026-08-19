import { useEffect, useMemo, useState } from 'react';
import { monaco, languageForPath } from '../features/editor/monacoSetup';
import { useSettings } from '../stores/settings';
import { intraLineRanges, pairedLines, type FileDiff, type WordRange } from './diffPatch';

/**
 * 差分表示のシンタックスハイライトと、行内の変更箇所の強調。
 *
 * 色付けはエディタで使っている Monaco のトークナイザ (monaco.editor.colorize) をそのまま流用する。
 * 色は現在のテーマ (vs / vs-dark) のトークン色で、Monaco が document に差し込む
 * .mtkN のスタイルがそのまま効く。差分の行背景 (追加=緑 / 削除=赤) は従来どおり残り、
 * その上に文字色だけが乗る (GitHub と同じ見え方)。
 */

/** 1 行の描画に必要な情報 */
export interface DiffLineRender {
  /** 色付き HTML (行内強調も適用済み)。色付けできない場合は null */
  html: string | null;
  /** 行内の変更範囲。html が null のとき素のテキストに対して使う */
  range: WordRange | null;
}

const NO_RENDER: DiffLineRender = { html: null, range: null };

/**
 * 複数行をまとめて色付けし、行ごとの HTML を返す。
 * 色付けできない場合 (プレーンテキスト・言語未対応・失敗) は null。
 * 出力は Monaco 側で HTML エスケープ済みなので、そのまま innerHTML に入れてよい。
 */
async function colorizeLines(lines: string[], path: string, dark: boolean): Promise<string[] | null> {
  if (lines.length === 0) return null;
  const language = languageForPath(path);
  if (language === 'plaintext') return null;
  try {
    // 色は「現在のテーマ」で決まるため、差分だけを見ている場合も明暗を合わせる
    monaco.editor.setTheme(dark ? 'vs-dark' : 'vs');
    const html = await monaco.editor.colorize(lines.join('\n'), language, { tabSize: 4 });
    // Monaco はエディタ内での桁ずれを防ぐため空白を NBSP で出力するが、
    // 差分表示は white-space: pre-wrap なので通常の空白で問題なく、
    // NBSP のままだとコピーしたテキストに紛れ込む
    const parts = html.replace(/ /g, ' ').split('<br/>');
    return lines.map((_, i) => parts[i] ?? '');
  } catch {
    return null; // 失敗しても素のテキストで表示できればよい
  }
}

/**
 * 色付き HTML の一部 (文字位置 [start, end)) を span で包む。
 * タグや実体参照をまたいでも位置がずれないよう、DOM に起こしてテキストノード単位で分割する。
 */
function markHtmlRange(html: string, [start, end]: WordRange, className: string): string {
  if (start >= end) return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const jobs: { node: Text; from: number; to: number }[] = [];
  let offset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const from = Math.max(start, offset);
    const to = Math.min(end, offset + node.data.length);
    if (from < to) jobs.push({ node, from: from - offset, to: to - offset });
    offset += node.data.length;
  }
  // 走査を終えてから分割する (走査中に木を書き換えないため)
  for (const job of jobs) {
    const middle = job.node.splitText(job.from);
    middle.splitText(job.to - job.from);
    const span = document.createElement('span');
    span.className = className;
    middle.parentNode?.insertBefore(span, middle);
    span.appendChild(middle);
  }
  return template.innerHTML;
}

/** 行内強調のクラス (global.module.scss で定義。CSS Module の外なのでハッシュされない) */
function wordClass(tag: string): string {
  return tag === '-' ? 'diff-word-del' : 'diff-word-add';
}

/**
 * 1 ファイル分の差分に対し、(Hunk 番号, 行番号) → 描画情報を引く関数を返す。
 *
 * 色付けは変更前 (文脈 + 削除) と変更後 (文脈 + 追加) を別々の仮想ドキュメントとして行う。
 * 1 本のテキストとして流すと追加行と削除行が交互に並び、文字列リテラルやブロックコメントの
 * 状態がずれて以降の行が総崩れになるため。
 */
export function useDiffHighlight(
  parsed: FileDiff | null,
  path: string,
): (hunkIndex: number, lineIndex: number) => DiffLineRender {
  const dark = useSettings((s) => s.settings.theme) === 'dark';
  const [map, setMap] = useState<Map<string, string>>(new Map());

  // 行内の変更範囲は色付けの成否に関係なく使うので、同期的に求めておく
  const ranges = useMemo(() => {
    const out = new Map<string, WordRange>();
    parsed?.hunks.forEach((hunk, h) => {
      for (const [delIndex, addIndex] of pairedLines(hunk)) {
        const found = intraLineRanges(hunk.lines[delIndex].slice(1), hunk.lines[addIndex].slice(1));
        if (!found) continue;
        out.set(`${h}:${delIndex}`, found.old);
        out.set(`${h}:${addIndex}`, found.new);
      }
    });
    return out;
  }, [parsed]);

  useEffect(() => {
    if (!parsed) {
      setMap(new Map());
      return;
    }
    let stale = false;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    const slots: { key: string; tag: string; side: 'old' | 'new'; index: number }[] = [];
    parsed.hunks.forEach((hunk, h) => {
      hunk.lines.forEach((line, l) => {
        const tag = line[0];
        if (tag === '\\') return; // "\ No newline at end of file" は色付け対象外
        const key = `${h}:${l}`;
        if (tag === '-') {
          slots.push({ key, tag, side: 'old', index: oldLines.length });
          oldLines.push(line.slice(1));
        } else {
          slots.push({ key, tag, side: 'new', index: newLines.length });
          newLines.push(line.slice(1));
        }
      });
    });
    void Promise.all([colorizeLines(oldLines, path, dark), colorizeLines(newLines, path, dark)]).then(
      ([oldHtml, newHtml]) => {
        if (stale || (!oldHtml && !newHtml)) return;
        const next = new Map<string, string>();
        for (const slot of slots) {
          const html = (slot.side === 'old' ? oldHtml : newHtml)?.[slot.index];
          if (!html) continue;
          const range = ranges.get(slot.key);
          // 行内強調は描画のたびに DOM を起こさなくて済むよう、ここで焼き込む
          next.set(slot.key, range ? markHtmlRange(html, range, wordClass(slot.tag)) : html);
        }
        setMap(next);
      },
    );
    return () => {
      stale = true; // 表示対象が変わったら古い結果は捨てる
    };
  }, [parsed, path, dark, ranges]);

  return (hunkIndex, lineIndex) => {
    const key = `${hunkIndex}:${lineIndex}`;
    const html = map.get(key);
    const range = ranges.get(key);
    if (!html && !range) return NO_RENDER;
    return { html: html ?? null, range: range ?? null };
  };
}

/**
 * 差分 1 行の本文。色付き HTML があればそれを、無ければ素のテキストを描画する。
 * line は先頭のタグ文字 (' ' / '+' / '-') を含む差分の行そのまま。
 * className は呼び出し側の CSS Module で解決済みのクラス名を渡す。
 */
export function DiffLineText({
  line,
  render,
  className,
}: {
  line: string;
  render: DiffLineRender;
  className: string;
}) {
  const tag = line[0] ?? ' ';
  if (render.html) {
    return (
      <span className={className}>
        {tag}
        <span dangerouslySetInnerHTML={{ __html: render.html }} />
      </span>
    );
  }
  if (render.range) {
    // 色付けが無い (プレーンテキスト等) 場合も、行内の変更箇所だけは強調する
    const body = line.slice(1);
    const [start, end] = render.range;
    return (
      <span className={className}>
        {tag}
        {body.slice(0, start)}
        <span className={wordClass(tag)}>{body.slice(start, end)}</span>
        {body.slice(end)}
      </span>
    );
  }
  return <span className={className}>{line || ' '}</span>;
}
