import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { api } from '../../api/client';
import { useGit } from '../../stores/git';
import { useExplorer } from '../../stores/explorer';
import { openConflictResolver } from '../../stores/conflict';
import styles from './GitCommandDialog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';
import { useDialogKeys } from '../../lib/dialogKeys';

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

/** HTTPS の認証で失敗したコマンドを、GCM のサインイン画面を許可して再実行するための情報 */
interface SignInRetry {
  repo: string;
  commands: string[][];
  continueOnError: boolean;
}

interface GitCommandStore {
  open: boolean;
  title: string;
  steps: CommandStep[];
  /** 最後の実行 (初回 or サインインして再試行) が始まった steps の位置。成否と件数はここから後で数える */
  runStart: number;
  running: boolean;
  /** GCM のサインイン画面を許可して実行中か (操作の案内を出す) */
  signingIn: boolean;
  /** 結果に成功/失敗の件数を出すか (一括実行時) */
  showCounts: boolean;
  /** 実行後に残っている未解決の競合数 (>0 なら競合解消ツールへの導線を出す) */
  conflicts: number;
  /** HTTPS の認証で失敗したとき、サインインして再試行できるコマンド */
  signInRetry: SignInRetry | null;
  start: (title: string, showCounts?: boolean) => void;
  restart: () => void;
  addStep: (command: string) => void;
  finishStep: (output: string, ok: boolean) => void;
  done: (conflicts: number, signInRetry: SignInRetry | null) => void;
  close: () => void;
}

export const useGitCommand = create<GitCommandStore>((set) => ({
  open: false,
  title: '',
  steps: [],
  runStart: 0,
  running: false,
  signingIn: false,
  showCounts: false,
  conflicts: 0,
  signInRetry: null,
  start: (title, showCounts = false) =>
    set({
      open: true,
      title,
      steps: [],
      runStart: 0,
      running: true,
      signingIn: false,
      showCounts,
      conflicts: 0,
      signInRetry: null,
    }),
  // 前回の出力は残したまま、続けて再試行する
  restart: () =>
    set((s) => ({ runStart: s.steps.length, running: true, signingIn: true, conflicts: 0, signInRetry: null })),
  addStep: (command) =>
    set((s) => ({ steps: [...s.steps, { command, output: '', ok: null }] })),
  finishStep: (output, ok) =>
    set((s) => ({
      steps: s.steps.map((st, i) => (i === s.steps.length - 1 ? { ...st, output, ok } : st)),
    })),
  done: (conflicts, signInRetry) => set({ running: false, signingIn: false, conflicts, signInRetry }),
  close: () => set({ open: false, signInRetry: null }),
}));

/**
 * コマンド列を順に実行してダイアログに追記する。
 * 戻り値の retry は、HTTPS の認証で失敗したためサインインして再試行できるコマンド
 * (打ち切った場合は、失敗したコマンドとその後の未実行のコマンド)。
 */
async function runSteps(
  repo: string,
  commands: string[][],
  continueOnError: boolean,
  interactive: boolean,
): Promise<{ allOk: boolean; retry: string[][] }> {
  let allOk = true;
  const retry: string[][] = [];
  for (let i = 0; i < commands.length; i++) {
    const args = commands[i];
    useGitCommand.getState().addStep(`git ${args.join(' ')}`);
    try {
      const r = await api.gitExec(repo, args, { interactive });
      useGitCommand.getState().finishStep(r.output || '(出力なし)', r.ok);
      if (!r.ok) {
        allOk = false;
        if (!continueOnError) {
          if (r.needsSignIn) retry.push(...commands.slice(i));
          break;
        }
        if (r.needsSignIn) retry.push(args);
      }
    } catch (e) {
      useGitCommand.getState().finishStep(e instanceof Error ? e.message : String(e), false);
      allOk = false;
      if (!continueOnError) break;
    }
  }
  return { allOk, retry };
}

/** 実行後の後始末: 状態を最新化してからダイアログを完了させる */
async function finishRun(repo: string, retry: string[][], continueOnError: boolean): Promise<void> {
  // stash の復元や cherry-pick はここで競合により失敗し得るので、
  // 残った競合の件数を拾ってダイアログに解消ツールへの導線を出す
  await useGit.getState().refreshStatus();
  useGitCommand
    .getState()
    .done(
      useGit.getState().mergeState.conflicted.length,
      retry.length > 0 ? { repo, commands: retry, continueOnError } : null,
    );
  void useExplorer.getState().refresh();
}

/**
 * git コマンド列を順に実行し、結果ダイアログに表示する。
 * 既定は途中で失敗したらそこで打ち切る (continueOnError で後続も続行し、件数を結果に出す)。
 * 戻り値は全コマンド成功なら true。
 * HTTPS の認証で失敗した場合は、ダイアログに「サインインして再試行」を出す (再試行の結果は戻り値に含まない)。
 */
export async function runGitCommands(
  repo: string,
  commands: string[][],
  title = 'Git コマンド',
  opts: { continueOnError?: boolean } = {},
): Promise<boolean> {
  const continueOnError = opts.continueOnError === true;
  useGitCommand.getState().start(title, continueOnError);
  const { allOk, retry } = await runSteps(repo, commands, continueOnError, false);
  await finishRun(repo, retry, continueOnError);
  return allOk;
}

/** 認証で失敗したコマンドを、GCM のサインイン画面 (ブラウザ / コード / トークン) を許可して再実行する */
async function retryWithSignIn(): Promise<void> {
  const retry = useGitCommand.getState().signInRetry;
  if (!retry) return;
  useGitCommand.getState().restart();
  const r = await runSteps(retry.repo, retry.commands, retry.continueOnError, true);
  await finishRun(retry.repo, r.retry, retry.continueOnError);
}

export function GitCommandDialog() {
  const { open, title, steps, runStart, running, signingIn, showCounts, conflicts, signInRetry, close } =
    useGitCommand();
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight);
  }, [steps]);

  /**
   * 見た目上の既定ボタンと同じ動作:
   * 認証で失敗していればサインインして再試行、競合が残っていれば閉じて解消ツールへ、それ以外は閉じるだけ
   */
  const accept = () => {
    if (signInRetry) {
      void retryWithSignIn();
      return;
    }
    close();
    if (conflicts > 0) openConflictResolver('');
  };

  // 実行中は結果が確定していないので、キーでは閉じない
  const dialogRef = useDialogKeys({
    enabled: open,
    onEnter: running ? null : accept,
    onEscape: running ? null : close,
  });

  if (!open) return null;

  // 成否と件数は最後の実行分で判定する (サインインして再試行する前の失敗は数えない)
  const lastRun = steps.slice(runStart);
  const failed = lastRun.some((s) => s.ok === false);
  const status = running ? 'running' : failed ? 'error' : 'ok';
  // 一括実行では最後にまとめて件数を出す (失敗しても後続を続けるため)
  const counts = showCounts
    ? ` (成功 ${lastRun.filter((s) => s.ok === true).length} 件 / 失敗 ${lastRun.filter((s) => s.ok === false).length} 件)`
    : '';
  const primary = signInRetry ? 'sign-in' : conflicts > 0 ? 'conflicts' : 'close';

  return (
    <div ref={dialogRef} className={cx("dialog-backdrop")}>
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
        {running && signingIn && (
          <div className={cx("gitcmd-note")}>
            サインイン画面 (Git Credential Manager) で認証してください。ブラウザ / コード / トークンのいずれでも認証できます。
            画面が見当たらない場合は、タスクバーを確認してください。
          </div>
        )}
        {!running && signInRetry && (
          <div className={cx("gitcmd-note")}>
            リモート (HTTPS) の認証に失敗しました。「サインインして再試行」で Git Credential Manager
            のサインイン画面を開き、認証してから同じコマンドを再実行します。認証した資格情報は Windows
            の資格情報マネージャーに保存され、次回からはそのまま使われます。
          </div>
        )}
        <div className={cx("dialog-buttons")}>
          <button className={cx(`btn${primary === 'close' ? ' primary' : ''}`)} disabled={running} onClick={close}>
            閉じる
          </button>
          {/* stash 復元や cherry-pick が競合で失敗したときの導線 (002.md §2) */}
          {conflicts > 0 && (
            <button
              className={cx(`btn${primary === 'conflicts' ? ' primary' : ''}`)}
              disabled={running}
              onClick={() => {
                close();
                openConflictResolver('');
              }}
            >
              競合を解消… ({conflicts} 件)
            </button>
          )}
          {signInRetry && (
            <button className={cx("btn primary")} disabled={running} onClick={() => void retryWithSignIn()}>
              サインインして再試行
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
