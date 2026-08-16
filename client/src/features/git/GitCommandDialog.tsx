import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { useGit } from '../../stores/git';
import { useExplorer } from '../../stores/explorer';
import { openConflictResolver } from '../../stores/conflict';
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
  /** 実行後に残っている未解決の競合数 (>0 なら競合解消ツールへの導線を出す) */
  conflicts: number;
  start: (title: string, showCounts?: boolean) => void;
  addStep: (command: string) => void;
  finishStep: (output: string, ok: boolean) => void;
  done: (conflicts: number) => void;
  close: () => void;
}

export const useGitCommand = create<GitCommandStore>((set) => ({
  open: false,
  title: '',
  steps: [],
  running: false,
  showCounts: false,
  conflicts: 0,
  start: (title, showCounts = false) =>
    set({ open: true, title, steps: [], running: true, showCounts, conflicts: 0 }),
  addStep: (command) =>
    set((s) => ({ steps: [...s.steps, { command, output: '', ok: null }] })),
  finishStep: (output, ok) =>
    set((s) => ({
      steps: s.steps.map((st, i) => (i === s.steps.length - 1 ? { ...st, output, ok } : st)),
    })),
  done: (conflicts) => set({ running: false, conflicts }),
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
  // 状態を最新化してから完了させる。
  // stash の復元や cherry-pick はここで競合により失敗し得るので、
  // 残った競合の件数を拾ってダイアログに解消ツールへの導線を出す
  await useGit.getState().refreshStatus();
  useGitCommand.getState().done(useGit.getState().mergeState.conflicted.length);
  void useExplorer.getState().refresh();
  return allOk;
}

export function GitCommandDialog() {
  const { open, title, steps, running, showCounts, conflicts, close } = useGitCommand();
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
            `✖ 失敗しました${counts}${conflicts > 0 ? ` — 未解決の競合が ${conflicts} 件あります` : ''}`
          ) : (
            `✔ 成功しました${counts}`
          )}
        </div>
        <div className={cx("dialog-buttons")}>
          <button className={cx(`btn${conflicts > 0 ? '' : ' primary'}`)} disabled={running} onClick={close}>
            閉じる
          </button>
          {/* stash 復元や cherry-pick が競合で失敗したときの導線 (002.md §2) */}
          {conflicts > 0 && (
            <button
              className={cx("btn primary")}
              disabled={running}
              onClick={() => {
                close();
                openConflictResolver('');
              }}
            >
              競合を解消… ({conflicts} 件)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
