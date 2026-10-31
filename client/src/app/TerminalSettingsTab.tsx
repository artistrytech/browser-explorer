import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { toastError } from '../stores/toast';
import type { AppSettings, TerminalShell } from '../types';
import styles from './SettingsDialog.module.scss';
import { createCssModuleClassNames } from '../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/** 設定画面の「ターミナル」タブ: 「＋」で開くシェル */
export function TerminalSettingsTab({
  draft,
  patch,
}: {
  draft: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
}) {
  const [shells, setShells] = useState<TerminalShell[] | null>(null);

  useEffect(() => {
    api
      .terminals()
      .then((r) => setShells(r.shells))
      .catch(toastError);
  }, []);

  const known = shells?.some((s) => s.id === draft.terminalShell) ?? true;

  return (
    <>
      <p className={cx('settings-hint')}>
        アプリ内のターミナル (ツールバーのターミナルのアイコン / Ctrl+`) の設定です。
        ここで選んだシェルを「＋」で開きます。ほかのシェルは「＋」の隣の「▾」から選べます。
      </p>
      <div className={cx('settings-row')}>
        <span className={cx('settings-label')}>既定のシェル</span>
        {shells ? (
          <select value={draft.terminalShell} onChange={(e) => patch({ terminalShell: e.target.value })}>
            {!known && <option value={draft.terminalShell}>{draft.terminalShell} (見つかりません)</option>}
            {shells.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        ) : (
          <span className={cx('settings-hint')}>確認中…</span>
        )}
      </div>
      {!known && (
        <p className={cx('settings-warn')}>
          設定されたシェルが見つからないため、一覧の先頭のシェルで開きます。
        </p>
      )}
    </>
  );
}
