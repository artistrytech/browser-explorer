import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { api } from './api/client';
import { initTabClient } from './app/tabClient';
import { enterShellIfStandalone } from './lib/appTabs';
import './styles/global.module.scss';

/**
 * ブラウザ側の未捕捉例外 / Promise 拒否をサーバのアプリログへ送る (セッション ID 付き)。
 * トーストにも出ない失敗をあとから追えるようにするため。送信失敗は握りつぶす (api.logClient 内)
 */
window.addEventListener('error', (e) => {
  const err = e.error as unknown;
  void api.logClient('error', `uncaught: ${e.message}`, 'uncaught', {
    file: e.filename,
    line: e.lineno,
    col: e.colno,
    ...(err instanceof Error ? { name: err.name, stack: err.stack } : {}),
    url: location.href,
  });
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as unknown;
  const message = r instanceof Error ? r.message : String(r);
  void api.logClient('error', `unhandledrejection: ${message}`, 'uncaught', {
    ...(r instanceof Error ? { name: r.name, stack: r.stack } : {}),
    ...(r && typeof r === 'object' && 'requestId' in r ? { requestId: (r as { requestId: unknown }).requestId } : {}),
    url: location.href,
  });
});

// PWA のウィンドウで直接開いたときはアプリ内タブのシェルへ切り替える (この画面は描画しない)
if (!enterShellIfStandalone()) {
  // アプリ内タブ (tabs.html) の iframe として動くときの連携。App の初期化で URL を書き換える前に始める
  initTabClient();

  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
