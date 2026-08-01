import { spawn } from 'node:child_process';

/**
 * Windows で、指定フォルダを表示している Explorer ウィンドウを前面に出す (ベストエフォート)。
 *
 * このサーバはブラウザから見て「フォアグラウンドではない別プロセス」なので、
 * ここから起動した Explorer ウィンドウは Windows のフォアグラウンドロックにより
 * フォーカスを受け取れず、タスクバーで点滅するだけになる。
 * 実測では SetForegroundWindow 単体も AttachThreadInput 併用も失敗し、
 * 「ALT の空打ちで入力があったことにしてから AttachThreadInput + SetForegroundWindow」
 * だけが成功したため、その手順を PowerShell 経由で実行する。
 *
 * 起動は投げっぱなし (await しない) で、失敗しても無視する。
 */
export function focusExplorerWindow(dir: string): void {
  if (process.platform !== 'win32') return;
  // PowerShell の単一引用符文字列に埋め込むため、' は '' にエスケープする
  const target = dir.replace(/\\/g, '/').replace(/'/g, "''");
  const script = buildScript(target);
  try {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      // detached にすると (コンソールを持たないため) PowerShell 自体が動かないので付けない。
      // unref で子の終了待ちはしない (最大 5 秒で自分から終わる)
      { stdio: 'ignore', windowsHide: true },
    );
    child.on('error', () => {});
    child.unref();
  } catch {
    /* 前面化できなくても開く動作自体は成功しているので無視する */
  }
}

/**
 * 対象フォルダの Explorer ウィンドウを探して前面化する PowerShell スクリプト。
 *
 * ウィンドウは起動直後には現れず、現れた直後は Explorer 自身がまだ初期化中で
 * 前面化が効かないことがある。そのため「探す → 前面化 → 実際に前面になったか確認 →
 * ダメならウィンドウを取り直して再試行」を最大 8 秒繰り返す。成功した時点で終了する。
 * C# 部分は ASCII のみ (Add-Type のソースに非 ASCII を混ぜると環境により壊れるため)。
 */
function buildScript(target: string): string {
  return `$ErrorActionPreference = 'SilentlyContinue'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ExplorerFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public static bool IsForeground(IntPtr h) { return GetForegroundWindow() == h; }
  public static void Activate(IntPtr h) {
    keybd_event(0x12, 0, 0, UIntPtr.Zero);  // ALT down / lifts the foreground lock
    keybd_event(0x12, 0, 2, UIntPtr.Zero);  // ALT up
    uint dummy; uint target = GetWindowThreadProcessId(h, out dummy);
    uint me = GetCurrentThreadId();
    AttachThreadInput(me, target, true);
    ShowWindow(h, 9);                       // SW_RESTORE
    SetForegroundWindow(h);
    AttachThreadInput(me, target, false);
  }
}
'@
$target = '${target}'.TrimEnd('/').ToLower()
$deadline = (Get-Date).AddSeconds(8)
do {
  $hwnd = [IntPtr]::Zero
  foreach ($w in (New-Object -ComObject Shell.Application).Windows()) {
    $url = $w.LocationURL
    if (-not $url) { continue }
    $loc = ([uri]::UnescapeDataString($url) -replace '^file:///', '' -replace '\\\\', '/').TrimEnd('/').ToLower()
    if ($loc -eq $target) { $hwnd = [IntPtr]$w.HWND; break }
  }
  if ($hwnd -ne [IntPtr]::Zero) {
    [ExplorerFocus]::Activate($hwnd)
    Start-Sleep -Milliseconds 400
    if ([ExplorerFocus]::IsForeground($hwnd)) { exit }
  }
  Start-Sleep -Milliseconds 200
} while ((Get-Date) -lt $deadline)
`;
}
