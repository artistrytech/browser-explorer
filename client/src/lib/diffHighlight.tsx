import { useEffect, useState } from 'react';
import { monaco, languageForPath } from '../features/editor/monacoSetup';
import { useSettings } from '../stores/settings';
import type { FileDiff } from './diffPatch';

/**
 * 差分表示のシンタックスハイライト。
 *
 * エディタで使っている Monaco のトークナイザ (monaco.editor.colorize) をそのまま流用する。
 * 色は現在のテーマ (vs / vs-dark) のトークン色で、Monaco が document に差し込む
 * .mtkN のスタイルがそのまま効く。差分の行背景 (追加=緑 / 削除=赤) は従来どおり残り、
 * その上に文字色だけが乗る (GitHub と同じ見え方)。
 */

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
 * 1 ファイル分の差分に対し、(Hunk 番号, 行番号) → 色付き HTML を引く関数を返す。
 *
 * 変更前 (文脈 + 削除) と変更後 (文脈 + 追加) を別々の仮想ドキュメントとして色付けする。
 * 1 本のテキストとして流すと追加行と削除行が交互に現れて言語の状態がずれるため。
 */
export function useDiffHighlight(
  parsed: FileDiff | null,
  path: string,
): (hunkIndex: number, lineIndex: number) => string | null {
  const dark = useSettings((s) => s.settings.theme) === 'dark';
  const [map, setMap] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!parsed) {
      setMap(new Map());
      return;
    }
    let stale = false;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    const slots: { key: string; side: 'old' | 'new'; index: number }[] = [];
    parsed.hunks.forEach((hunk, h) => {
      hunk.lines.forEach((line, l) => {
        const tag = line[0];
        if (tag === '\\') return; // "\ No newline at end of file" は色付け対象外
        const key = `${h}:${l}`;
        if (tag === '-') {
          slots.push({ key, side: 'old', index: oldLines.length });
          oldLines.push(line.slice(1));
        } else {
          slots.push({ key, side: 'new', index: newLines.length });
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
          if (html) next.set(slot.key, html);
        }
        setMap(next);
      },
    );
    return () => {
      stale = true; // 表示対象が変わったら古い結果は捨てる
    };
  }, [parsed, path, dark]);

  return (hunkIndex, lineIndex) => map.get(`${hunkIndex}:${lineIndex}`) ?? null;
}

/**
 * 差分 1 行の本文。html があれば色付き、無ければ素のテキストで描画する。
 * line は先頭のタグ文字 (' ' / '+' / '-') を含む差分の行そのまま。
 * className は呼び出し側の CSS Module で解決済みのクラス名を渡す。
 */
export function DiffLineText({
  line,
  html,
  className,
}: {
  line: string;
  html: string | null;
  className: string;
}) {
  if (!html) return <span className={className}>{line || ' '}</span>;
  return (
    <span className={className}>
      {line[0] ?? ' '}
      <span dangerouslySetInnerHTML={{ __html: html }} />
    </span>
  );
}
