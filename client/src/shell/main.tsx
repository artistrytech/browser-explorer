import React from 'react';
import { createRoot } from 'react-dom/client';
import { TabsShell, applySavedTheme } from './TabsShell';
import { acquirePrimary, sendOpenToPrimary, takeOpenParam } from './shellWindow';
import '../styles/global.module.scss';

applySavedTheme();
void start();

async function start() {
  const open = takeOpenParam();
  const primary = await acquirePrimary();
  if (!primary && open) {
    // 既にシェルのウィンドウがあるので、そこへタブとして渡してこのウィンドウは閉じる。
    // スクリプトから閉じられないウィンドウ (closed が立たない) なら、渡さずにここで開く
    window.close();
    if (window.closed) {
      sendOpenToPrimary(open);
      return;
    }
  }
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <TabsShell primary={primary} initialOpen={open} />
    </React.StrictMode>,
  );
}
