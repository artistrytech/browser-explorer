import type { DiffToolDef, ExternalToolDef } from '../types';

/** プリセット (id は追加時に採番するので持たない) */
export type ExternalToolPreset = Omit<ExternalToolDef, 'id'>;
export type DiffToolPreset = Omit<DiffToolDef, 'id'>;

/**
 * 外部ツールのおすすめプリセット (OS 別)。追加後にコマンドやパスを編集して使う想定。
 * 実際に使えるかどうか (インストール状況・パス) は問わない。
 */
export function externalToolPresets(platform: string): ExternalToolPreset[] {
  if (platform === 'darwin') {
    return [
      { label: 'ターミナルで開く', command: 'open', args: ['-a', 'Terminal', '${paths}'], kind: 'dir' },
      { label: 'シェルで実行', command: '/bin/bash', kind: 'file', extensions: ['sh'], confirm: true },
      { label: 'Chrome で開く', command: 'open', args: ['-a', 'Google Chrome', '${paths}'] },
      { label: 'VS Code で開く', command: 'open', args: ['-a', 'Visual Studio Code', '${paths}'] },
    ];
  }
  if (platform === 'win32') {
    return [
      { label: 'メモ帳で開く', command: 'notepad.exe', kind: 'file' },
      { label: 'CMD で実行', command: 'cmd.exe', args: ['/k'], kind: 'dir' },
      { label: 'PowerShell で開く', command: 'powershell.exe', args: ['-NoExit'], kind: 'dir' },
      { label: 'シェルで実行', command: 'C:/Program Files/Git/bin/bash.exe', kind: 'file', extensions: ['sh'], confirm: true },
      { label: 'Chrome で開く', command: 'chrome.exe', args: ['${paths}'] },
      // VS Code は code.cmd 不可のため Code.exe を直接指定 (パスは環境に合わせて編集)
      { label: 'VS Code で開く', command: 'C:/Program Files/Microsoft VS Code/Code.exe', args: ['-n', '${paths}'] },
    ];
  }
  return [
    { label: 'ターミナルで開く', command: 'x-terminal-emulator', kind: 'dir' },
    { label: 'シェルで実行', command: '/bin/bash', kind: 'file', extensions: ['sh'], confirm: true },
    { label: 'Chrome で開く', command: 'google-chrome', args: ['${paths}'] },
    { label: 'VS Code で開く', command: 'code', args: ['-n', '${paths}'] },
  ];
}

/** 差分ツールのおすすめプリセット (OS 別) */
export function diffToolPresets(platform: string): DiffToolPreset[] {
  const meld: DiffToolPreset = { label: 'Meld で比較', command: 'meld', args: ['${left}', '${right}'] };
  if (platform === 'win32') {
    return [
      {
        label: 'WinMerge で比較',
        command: 'C:/Program Files/WinMerge/WinMergeU.exe',
        args: ['/u', '/wl', '/dl', '${leftTitle}', '/dr', '${rightTitle}', '${left}', '${right}'],
      },
      { label: 'VS Code で比較', command: 'C:/Program Files/Microsoft VS Code/Code.exe', args: ['-d', '${left}', '${right}'] },
      meld,
    ];
  }
  if (platform === 'darwin') {
    return [
      { label: 'VS Code で比較', command: 'open', args: ['-a', 'Visual Studio Code', '--args', '-d', '${left}', '${right}'] },
      meld,
    ];
  }
  return [{ label: 'VS Code で比較', command: 'code', args: ['-d', '${left}', '${right}'] }, meld];
}
