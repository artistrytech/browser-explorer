import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

export { monaco };

/**
 * Monaco に渡す等幅フォント。CSS 変数 --font-mono (styles/global.module.scss) と同じ内容。
 * Monaco は文字幅を自前で計測するため CSS の継承では効かず、オプションで渡す必要がある。
 */
export const MONACO_FONT_FAMILY = "'UDEV Gothic', Consolas, 'Courier New', monospace";

// Web フォントは実際に使われるまで読み込まれないため、ここで先読みしておく。
// フォールバック字体で計測した文字幅のまま描画されると桁がずれるので、読み込み後に再計測させる。
document.fonts
  .load("13px 'UDEV Gothic'")
  .then(() => monaco.editor.remeasureFonts())
  .catch(() => {});

/** パスから Monaco の言語 ID を推定 */
export function languageForPath(path: string): string {
  const uri = monaco.Uri.file(path);
  const langs = monaco.languages.getLanguages();
  const ext = `.${path.split('.').pop()?.toLowerCase() ?? ''}`;
  for (const l of langs) {
    if (l.extensions?.includes(ext)) return l.id;
  }
  void uri;
  return 'plaintext';
}
