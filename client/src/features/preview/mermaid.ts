/**
 * Markdown プレビュー用の mermaid 描画ヘルパ。
 * mermaid は依存ごと 2MB 超と大きいので、図を含むファイルを初めて開いたときに動的 import する
 * (図のない Markdown やアプリ起動時には読み込まない)。
 */

type MermaidApi = typeof import('mermaid').default;
type MermaidTheme = 'default' | 'dark';

let loading: Promise<MermaidApi> | null = null;
let appliedTheme: MermaidTheme | null = null;
let seq = 0;

async function loadMermaid(theme: MermaidTheme): Promise<MermaidApi> {
  loading ??= import('mermaid').then((m) => m.default);
  const mermaid = await loading;
  // initialize はグローバル設定なので、テーマが変わったときだけ再適用する
  if (appliedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      theme,
      // ラベル内の HTML はエスケープ (プレビュー本文と同じく信頼しない入力として扱う)
      securityLevel: 'strict',
      // 構文エラー時に mermaid 側が document.body へエラー図を挿入するのを抑止 (表示は呼び出し側で行う)
      suppressErrorRendering: true,
    });
    appliedTheme = theme;
  }
  return mermaid;
}

export interface MermaidRendered {
  svg: string;
  /** SVG を DOM に挿入した後に呼ぶ (クリック等のイベント登録)。無い場合もある */
  bindFunctions?: (element: Element) => void;
}

/** mermaid ソースを SVG 文字列に描画する。構文エラー等は例外として投げる */
export async function renderMermaid(source: string, theme: MermaidTheme): Promise<MermaidRendered> {
  const mermaid = await loadMermaid(theme);
  // render の id は描画ごとに一意である必要がある (同じ id を使い回すと前回の SVG と衝突する)
  const { svg, bindFunctions } = await mermaid.render(`md-mermaid-${++seq}`, source);
  return { svg, bindFunctions };
}
