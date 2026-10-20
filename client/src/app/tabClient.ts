import { useEditor } from '../stores/editor';
import { appTabId, postToShell, tabCommandFromKey, TAB_MESSAGE_TYPE, type AppTabWindow } from '../lib/appTabs';

/**
 * アプリ内タブ (tabs.html のシェルの iframe) として動くときの連携。シェル外では何もしない。
 * - URL・タイトル・テーマの変化をシェルへ通知する (タブのラベル・復元・シェルの配色に使う)
 * - タブ操作のショートカットをシェルへ転送する (フォーカスが iframe 内にあるとシェルにキーが届かないため)
 * - タブを閉じる前の未保存確認用に、エディタの未保存の有無をシェルから同期で引けるようにする
 */
export function initTabClient(): void {
  if (!appTabId) return;

  let scheduled = false;
  const notify = () => {
    if (scheduled) return;
    scheduled = true;
    // pushState → title 変更のように続けて変わることが多いので、まとめて 1 回送る
    queueMicrotask(() => {
      scheduled = false;
      postToShell({
        type: TAB_MESSAGE_TYPE,
        kind: 'state',
        url: location.pathname + location.search,
        title: document.title,
        theme: document.body.dataset.theme ?? null,
      });
    });
  };

  // URL: アプリは history.pushState / replaceState で URL を更新するので、それを横取りして通知する
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method].bind(history);
    history[method] = (...args: Parameters<History['pushState']>) => {
      original(...args);
      notify();
    };
  }
  window.addEventListener('popstate', notify);

  // タイトル (App が document.title を更新する) とテーマ (body の data-theme)
  const observer = new MutationObserver(notify);
  observer.observe(document.head, { subtree: true, childList: true, characterData: true });
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });

  // ダイアログ等のキー処理より先に拾うため、キャプチャで登録する
  window.addEventListener(
    'keydown',
    (e) => {
      const command = tabCommandFromKey(e);
      if (!command) return;
      e.preventDefault();
      e.stopPropagation();
      postToShell({ type: TAB_MESSAGE_TYPE, kind: 'command', command });
    },
    true,
  );

  (window as AppTabWindow).ebTabHasUnsaved = () => useEditor.getState().tabs.some((t) => t.dirty);

  notify();
}
