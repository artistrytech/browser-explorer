import { useEffect, useRef, type RefObject } from 'react';

/**
 * ダイアログ共通のキー操作 (Enter で既定ボタン / Escape でキャンセル)。
 *
 * ダイアログは重なって開くことがある (Stash → コミットの詳細、設定 → ツール編集、
 * 各操作 → Git コマンドの実行結果など) ため、window のリスナは 1 本だけ張り、
 * 最後に開いたダイアログ (スタックの末尾) だけがキーを受け取る。
 *
 * キャプチャ段階で拾って preventDefault / stopPropagation するので、ダイアログの外
 * (ダイアログを開いたボタンや背後のファイル一覧) にフォーカスが残っていても、
 * そちらが Enter で反応することはない。
 */

type KeyHandler = (e: KeyboardEvent) => void;

/** 開いているダイアログのハンドラ。末尾 = 最前面 */
const stack: { handler: KeyHandler }[] = [];

function dispatch(e: KeyboardEvent): void {
  stack[stack.length - 1]?.handler(e);
}

/**
 * IME 変換中か。変換中の Enter は変換の確定、Escape は変換の取り消しであって
 * ダイアログの操作ではないので、アプリ側では拾わない。
 * (keyCode 229 は isComposing を出さない古い挙動へのフォールバック)
 */
function composing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}

/** Enter がその要素自身の操作になる要素か (ボタン・リンクは既定動作に任せる) */
function activatesOnEnter(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button';
}

/** 改行を入力できる要素か (Enter は改行。決定は Ctrl/Cmd+Enter) */
function acceptsNewline(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'TEXTAREA' || el.isContentEditable;
}

export interface DialogKeyOptions {
  /** ダイアログが開いている間だけ true (閉じている間はキーを拾わない) */
  enabled?: boolean;
  /** Enter で実行する既定の動作。実行できない状態なら null / undefined を渡す */
  onEnter?: (() => void) | null;
  /** Escape で実行するキャンセル動作 */
  onEscape?: (() => void) | null;
}

/**
 * ダイアログに Enter / Escape を割り当てる。
 * onEnter には「見た目上の既定ボタン (btn primary)」と同じ動作を渡す。
 *
 * 戻り値の ref は、ダイアログの外枠 (dialog-backdrop) に付ける。
 * ダイアログ内のどこにフォーカスがあるかで Enter の扱いを変えるために使う
 * (入力欄の改行やボタンの既定動作を潰さないため)。ref を付けない場合は
 * 「フォーカスは常にダイアログの外」とみなして Enter を既定の動作に割り当てる。
 */
export function useDialogKeys({
  enabled = true,
  onEnter,
  onEscape,
}: DialogKeyOptions): RefObject<HTMLDivElement> {
  const root = useRef<HTMLDivElement>(null);
  // 毎レンダーで作り直されるコールバックでスタックの順序が入れ替わらないよう、ref 経由で参照する
  const handlers = useRef({ onEnter, onEscape });
  handlers.current = { onEnter, onEscape };

  useEffect(() => {
    if (!enabled) return;
    const entry: { handler: KeyHandler } = {
      handler: (e) => {
        if (e.defaultPrevented || composing(e)) return;
        const { onEnter: enter, onEscape: escape } = handlers.current;
        const accept = () => {
          e.preventDefault();
          e.stopPropagation();
        };
        if (e.key === 'Escape') {
          if (!escape) return;
          accept();
          escape();
          return;
        }
        if (e.key !== 'Enter' || !enter || e.altKey || e.shiftKey) return;
        const el = document.activeElement;
        // ダイアログの中にフォーカスがある場合だけ、その要素本来の Enter を優先する
        if (el && root.current?.contains(el)) {
          if (acceptsNewline(el) && !(e.ctrlKey || e.metaKey)) return;
          if (activatesOnEnter(el)) return; // フォーカス中のボタンが押される
        }
        accept();
        enter();
      },
    };
    stack.push(entry);
    if (stack.length === 1) window.addEventListener('keydown', dispatch, true);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0) window.removeEventListener('keydown', dispatch, true);
    };
  }, [enabled]);

  return root;
}
