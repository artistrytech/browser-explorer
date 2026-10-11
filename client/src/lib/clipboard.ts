/**
 * テキストをクリップボードへコピーする。
 * navigator.clipboard は安全なコンテキスト (https / localhost) でしか使えないため、
 * 使えない場合は textarea + execCommand('copy') で代替する。
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}
