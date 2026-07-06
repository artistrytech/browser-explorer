import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { useGit } from '../../stores/git';
import { useExplorer } from '../../stores/explorer';

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
  start: (title: string) => void;
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
  start: (title) => set({ open: true, title, steps: [], running: true }),
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
 * 途中で失敗したらそこで打ち切る。戻り値は全コマンド成功なら true。
 */
export async function runGitCommands(
  repo: string,
  commands: string[][],
  title = 'Git コマンド',
): Promise<boolean> {
  const store = useGitCommand.getState();
  store.start(title);
  let allOk = true;
  for (const args of commands) {
    useGitCommand.getState().addStep(`git ${args.join(' ')}`);
    try {
      const r = await api.gitExec(repo, args);
      useGitCommand.getState().finishStep(r.output || '(出力なし)', r.ok);
      if (!r.ok) {
        allOk = false;
        break;
      }
    } catch (e) {
      useGitCommand.getState().finishStep(e instanceof Error ? e.message : String(e), false);
      allOk = false;
      break;
    }
  }
  useGitCommand.getState().done();
  // 結果はダイアログで見せつつ、裏で状態を最新化しておく
  void useGit.getState().refreshStatus();
  void useExplorer.getState().refresh();
  return allOk;
}

export function GitCommandDialog() {
  const { open, title, steps, running, close } = useGitCommand();
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight);
  }, [steps]);

  if (!open) return null;

  const failed = steps.some((s) => s.ok === false);
  const status = running ? 'running' : failed ? 'error' : 'ok';

  return (
    <div className="dialog-backdrop">
      <div className="dialog gitcmd-dialog">
        <div className="dialog-title">{title}</div>
        <div className="gitcmd-body" ref={bodyRef}>
          {steps.map((s, i) => (
            <div key={i} className="gitcmd-step">
              <div className="gitcmd-command">
                <span className="gitcmd-prompt">$</span> {s.command}
                {s.ok === null && <span className="gitcmd-running"> 実行中…</span>}
              </div>
              {s.output && (
                <pre className={`gitcmd-output${s.ok === false ? ' failed' : ''}`}>{s.output}</pre>
              )}
            </div>
          ))}
        </div>
        <div className={`gitcmd-status ${status}`}>
          {status === 'running' ? (
            <>
              <span className="spinner-ring small" /> 実行中…
            </>
          ) : status === 'error' ? (
            '✖ 失敗しました'
          ) : (
            '✔ 成功しました'
          )}
        </div>
        <div className="dialog-buttons">
          <button className="btn primary" disabled={running} onClick={close}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
