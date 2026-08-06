import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { useGit } from '../../stores/git';
import { useExplorer } from '../../stores/explorer';
import styles from './GitCommandDialog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

/**
 * Git コマンド実行ダイアログ:
 * 実行したコマンドとその出力・成否を表示する。成否にかかわらず
 * ダイアログは手動で閉じる仕様とし、結果をユーザーに確認させる。
 */

export interface CommandStep {
  command: string;
  output: string;
  /** null = 実行中 */
  ok: boolean | null;
}

interface GitCommandStore {
  open: boolean;
  title: string;
  steps: CommandStep[];
  running: boolean;
  /** 結果に成功/失敗の件数を出すか (一括実行時) */
  showCounts: boolean;
  start: (title: string, showCounts?: boolean) => void;
  addStep: (command: string) => void;
  finishStep: (output: string, ok: boolean) => void;
  done: () => void;
  close: () => void;
}

export const useGitCommand = create<GitCommandStore>((set) => ({
  open: false,
  title: '',
  steps: [],
  running: false,
  showCounts: false,
  start: (title, showCounts = false) => set({ open: true, title, steps: [], running: true, showCounts }),
  addStep: (command) =>
    set((s) => ({ steps: [...s.steps, { command, output: '', ok: null }] })),
  finishStep: (output, ok) =>
    set((s) => ({
      steps: s.steps.map((st, i) => (i === s.steps.length - 1 ? { ...st, output, ok } : st)),
    })),
  done: () => set({ running: false }),
  close: () => set({ open: false }),
}));

/**
 * git コマンド列を順に実行し、結果ダイアログに表示する。
 * 既定は途中で失敗したらそこで打ち切る (continueOnError で後続も続行し、件数を結果に出す)。
 * 戻り値は全コマンド成功なら true。
 */
export async function runGitCommands(
  repo: string,
  commands: string[][],
  title = 'Git コマンド',
  opts: { continueOnError?: boolean } = {},
): Promise<boolean> {
  const store = useGitCommand.getState();
  store.start(title, opts.continueOnError === true);
  let allOk = true;
  for (const args of commands) {
    useGitCommand.getState().addStep(`git ${args.join(' ')}`);
    try {
      const r = await api.gitExec(repo, args);
      useGitCommand.getState().finishStep(r.output || '(出力なし)', r.ok);
      if (!r.ok) {
        allOk = false;
        if (!opts.continueOnError) break;
      }
    } catch (e) {
      useGitCommand.getState().finishStep(e instanceof Error ? e.message : String(e), false);
      allOk = false;
      if (!opts.continueOnError) break;
    }
  }
  useGitCommand.getState().done();
  // 結果はダイアログで見せつつ、裏で状態を最新化しておく
  void useGit.getState().refreshStatus();
  void useExplorer.getState().refresh();
  return allOk;
}

export function GitCommandDialog() {
  const { open, title, steps, running, showCounts, close } = useGitCommand();
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight);
  }, [steps]);

  if (!open) return null;

  const failed = steps.some((s) => s.ok === false);
  const status = running ? 'running' : failed ? 'error' : 'ok';
  // 一括実行では最後にまとめて件数を出す (失敗しても後続を続けるため)
  const counts = showCounts
    ? ` (成功 ${steps.filter((s) => s.ok === true).length} 件 / 失敗 ${steps.filter((s) => s.ok === false).length} 件)`
    : '';

  return (
    <div className={cx("dialog-backdrop")}>
      <div className={cx("dialog gitcmd-dialog")}>
        <div className={cx("dialog-title")}>{title}</div>
        <div className={cx("gitcmd-body")} ref={bodyRef}>
          {steps.map((s, i) => (
            <div key={i} className={cx("gitcmd-step")}>
              <div className={cx("gitcmd-command")}>
                <span className={cx("gitcmd-prompt")}>$</span> {s.command}
                {s.ok === null && <span className={cx("gitcmd-running")}> 実行中…</span>}
              </div>
              {s.output && (
                <pre className={cx(`gitcmd-output${s.ok === false ? ' failed' : ''}`)}>{s.output}</pre>
              )}
            </div>
          ))}
        </div>
        <div className={cx(`gitcmd-status ${status}`)}>
          {status === 'running' ? (
            <>
              <span className={cx("spinner-ring small")} /> 実行中…
            </>
          ) : status === 'error' ? (
            `✖ 失敗しました${counts}`
          ) : (
            `✔ 成功しました${counts}`
          )}
        </div>
        <div className={cx("dialog-buttons")}>
          <button className={cx("btn primary")} disabled={running} onClick={close}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
