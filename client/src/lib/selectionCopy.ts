import { create } from 'zustand';
import type { monaco } from '../features/editor/monacoSetup';
import { api } from '../api/client';
import { baseName, parentPath, relativeTo } from './paths';

/**
 * 範囲選択のコピー: エディタや差分で文字列を範囲選択すると、少し待ってから選択の近くに
 * コピーボタンを出し、「パス:行範囲」と選択した文字列のコードブロックをクリップボードへコピーする。
 *
 * - Monaco (エディタ・コミット差分タブ) は attachMonacoSelectionCopy で選択を監視する
 * - HTML の差分表示は、要素に次の属性を付けておけば document の選択から拾う
 *   - data-sc-file: 1 ファイル分の差分の外枠。値はリポジトリ相対パス (data-sc-old-path に変更前のパス)
 *   - data-sc-line: 1 行。data-sc-old / data-sc-new に旧・新の行番号、本文 (先頭の +/- を含む) は data-sc-text の要素
 *   - data-sc-hunk: Hunk の見出し。値は "@@ … @@" の行 (複数の Hunk にまたがる選択のときだけ挟む)
 */

export interface SelectionCopyPopup {
  /** 表示元 (自分の出したものだけを消すのに使う) */
  owner: string;
  x: number;
  y: number;
  /** コピーする文字列 */
  text: string;
  /** ボタンの説明に出す 1 行目 (パス:行範囲) */
  label: string;
}

interface SelectionCopyStore {
  popup: SelectionCopyPopup | null;
  show: (popup: SelectionCopyPopup) => void;
  /** owner を渡すとその表示元のものだけを消す */
  hide: (owner?: string) => void;
}

export const useSelectionCopy = create<SelectionCopyStore>((set, get) => ({
  popup: null,
  show: (popup) => set({ popup }),
  hide: (owner) => {
    const p = get().popup;
    if (p && (owner === undefined || p.owner === owner)) set({ popup: null });
  },
}));

/** 選択が止まってからボタンを出すまでの時間 (ms) */
const SHOW_DELAY = 400;
/** ボタンの大きさ (配置の計算用。SelectionCopyPopup.module.scss と合わせる) */
const POP_W = 28;
const POP_H = 26;
const POP_GAP = 6;

// --- 表示の予約 (ドラッグ中は離すまで待つ) ---

let pointerDown = false;
const waiting = new Set<() => void>();
let pointerTracking = false;

function trackPointer(): void {
  if (pointerTracking) return;
  pointerTracking = true;
  const release = () => {
    if (!pointerDown) return;
    pointerDown = false;
    const list = [...waiting];
    waiting.clear();
    list.forEach((kick) => kick());
  };
  window.addEventListener('pointerdown', () => (pointerDown = true), true);
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  window.addEventListener('blur', release);
  // Esc で消す (選択はそのまま)
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') useSelectionCopy.getState().hide();
    },
    true,
  );
}

/**
 * kick するたびに表示を予約し直す。SHOW_DELAY 待ってもマウスのボタンを押したままなら、離してから予約し直す。
 * run の isCurrent は、待っている間 (非同期の処理中) に予約し直されていないか
 */
function createScheduler(run: (isCurrent: () => boolean) => void | Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gen = 0;
  const fire = () => {
    timer = undefined;
    if (pointerDown) {
      waiting.add(kick);
      return;
    }
    const g = gen;
    void run(() => g === gen);
  };
  const cancel = () => {
    gen++;
    clearTimeout(timer);
    timer = undefined;
    waiting.delete(kick);
  };
  const kick = () => {
    cancel();
    timer = setTimeout(fire, SHOW_DELAY);
  };
  return { kick, cancel };
}

/** ボタンの位置: 基準点 (選択の端) の下。下に収まらなければ上に出し、bounds (既定は画面) の中に収める */
function place(x: number, top: number, bottom: number, bounds?: DOMRect): { x: number; y: number } {
  const minX = Math.max(4, bounds?.left ?? 0);
  const maxX = Math.min(window.innerWidth, bounds?.right ?? Infinity) - POP_W - 4;
  const minY = Math.max(4, bounds?.top ?? 0);
  const maxY = Math.min(window.innerHeight, bounds?.bottom ?? Infinity) - POP_H - 4;
  let y = bottom + POP_GAP;
  if (y > maxY) y = top - POP_H - POP_GAP;
  return { x: Math.min(maxX, Math.max(minX, x)), y: Math.min(maxY, Math.max(minY, y)) };
}

// --- コピーする文字列 ---

export interface Snippet {
  /** 表示するパス (リポジトリ相対パス。リポジトリ外ならファイル名) */
  path: string;
  start: number;
  end: number;
  code: string;
  /** コードブロックの言語 (無ければ付けない) */
  lang?: string;
  /** 行範囲の後ろに添える注記 ("(変更前)" 等) */
  note?: string;
}

/** 「パス:L開始-L終了」(1 行なら L開始)。保存しないレビューコメントの位置と同じ書き方 */
export function snippetLocation(s: Pick<Snippet, 'path' | 'start' | 'end' | 'note'>): string {
  const lines = s.start === s.end ? `L${s.start}` : `L${s.start}-L${s.end}`;
  return `${s.path}:${lines}${s.note ? ` ${s.note}` : ''}`;
}

/** 「パス:行範囲」の行と、選択した文字列のコードブロック。本文に ``` があればフェンスを長くする */
export function formatSnippet(s: Snippet): string {
  const body = s.code.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${snippetLocation(s)}\n${fence}${s.lang ?? ''}\n${body}\n${fence}\n`;
}

function showSnippet(owner: string, pos: { x: number; y: number }, s: Snippet): void {
  useSelectionCopy.getState().show({ owner, ...pos, text: formatSnippet(s), label: snippetLocation(s) });
}

// --- リポジトリ相対パス ---

/** フォルダ → リポジトリのルート (リポジトリ外は null)。リポジトリ外の結果は覚えない (後から git init されることがある) */
const repoRoots = new Map<string, Promise<string | null>>();

/** 絶対パス → リポジトリ相対パス。リポジトリ外 (判定できない場合も) はファイル名だけ */
export async function repoRelativePath(abs: string): Promise<string> {
  const dir = parentPath(abs);
  let root = repoRoots.get(dir);
  if (!root) {
    root = api
      .isRepo(dir)
      .then((r) => (r.isRepo && r.root ? r.root : null))
      .catch(() => null);
    repoRoots.set(dir, root);
  }
  const r = await root;
  if (!r) repoRoots.delete(dir);
  return (r && relativeTo(abs, r)) || baseName(abs);
}

// --- Monaco ---

export interface MonacoSelectionSource {
  path: string;
  note?: string;
}

/**
 * Monaco エディタの範囲選択でコピーボタンを出す。resolve は表示する直前に呼び、
 * パス (と注記) を返す (null なら出さない)。戻り値は監視の解除
 */
export function attachMonacoSelectionCopy(
  editor: monaco.editor.ICodeEditor,
  owner: string,
  resolve: () => MonacoSelectionSource | null | Promise<MonacoSelectionSource | null>,
): () => void {
  trackPointer();
  const hide = () => useSelectionCopy.getState().hide(owner);
  const sched = createScheduler(async (isCurrent) => {
    const model = editor.getModel();
    const sel = editor.getSelection();
    if (!model || !sel || sel.isEmpty() || !editor.hasWidgetFocus()) return;
    const code = model.getValueInRange(sel);
    if (!code.trim()) return;
    // 次の行の先頭までの選択 (行の選択・トリプルクリック) は、その行を含めない
    const end =
      sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
    const src = await resolve();
    if (!src || !isCurrent()) return;
    const dom = editor.getDomNode();
    // カーソル側 (ドラッグを離した側) の端に出す。次の行の先頭なら、選んだ最後の行の末尾に出す
    const cursor = sel.getPosition();
    const anchor =
      cursor.column === 1 && cursor.lineNumber === sel.endLineNumber && end < sel.endLineNumber
        ? { lineNumber: end, column: model.getLineMaxColumn(end) }
        : cursor;
    const at = editor.getScrolledVisiblePosition(anchor);
    if (!dom || !at) return;
    const rect = dom.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const top = rect.top + at.top;
    const lang = model.getLanguageId();
    showSnippet(owner, place(rect.left + at.left, top, top + at.height, rect), {
      path: src.path,
      start: sel.startLineNumber,
      end,
      code,
      lang: lang === 'plaintext' ? undefined : lang,
      note: src.note,
    });
  });
  const restart = () => {
    hide();
    sched.kick();
  };
  const stop = () => {
    hide();
    sched.cancel();
  };
  const subs = [
    editor.onDidChangeCursorSelection(restart),
    editor.onDidScrollChange(restart),
    editor.onDidBlurEditorWidget(stop),
    editor.onDidChangeModel(stop),
  ];
  return () => {
    subs.forEach((d) => d.dispose());
    stop();
  };
}

// --- HTML の差分表示 ---

const DOM_OWNER = 'dom';

function closestElement(node: Node, selector: string): HTMLElement | null {
  const el = node instanceof Element ? node : node.parentElement;
  return el?.closest<HTMLElement>(selector) ?? null;
}

/** range と el の中身が重なる部分の文字列 */
function selectedTextIn(range: Range, el: Element): string {
  const r = document.createRange();
  r.selectNodeContents(el);
  if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
  return r.toString();
}

function lineNumber(el: HTMLElement, key: 'scOld' | 'scNew'): number | null {
  const v = el.dataset[key];
  return v ? Number(v) : null;
}

/** document の選択が 1 ファイル分の差分の中なら、選んだ行 (+/- 付き) をまとめて出す */
function showFromDomSelection(): void {
  const s = document.getSelection();
  if (!s || s.isCollapsed || s.rangeCount === 0) return;
  // 入力欄 (レビューのコメント欄等) の中の選択は対象外
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
  const range = s.getRangeAt(0);
  const file = closestElement(range.commonAncestorContainer, '[data-sc-file]');
  if (!file) return;
  const textOf = (el: HTMLElement) => el.querySelector('[data-sc-text]') ?? el;
  const items = [...file.querySelectorAll<HTMLElement>('[data-sc-line], [data-sc-hunk]')].filter((el) =>
    range.intersectsNode(el),
  );
  // 前後の端の行は、1 文字も選んでいなければ含めない (次の行の先頭までの選択等)
  const isSelectedLine = (el: HTMLElement) => el.dataset.scLine !== undefined && selectedTextIn(range, textOf(el)) !== '';
  while (items.length > 0 && !isSelectedLine(items[0])) items.shift();
  while (items.length > 0 && !isSelectedLine(items[items.length - 1])) items.pop();
  if (items.length === 0) return;

  const lines = items.filter((el) => el.dataset.scLine !== undefined);
  const news = lines.map((el) => lineNumber(el, 'scNew')).filter((n): n is number => n !== null);
  const olds = lines.map((el) => lineNumber(el, 'scOld')).filter((n): n is number => n !== null);
  // 変更後の行番号で示す。削除行だけの選択は変更前のファイルの行番号で、その旨を添える
  const useOld = news.length === 0;
  const nums = useOld ? olds : news;
  if (nums.length === 0) return;
  const path = (useOld ? file.dataset.scOldPath : undefined) || file.dataset.scFile || '';
  const code = items
    .map((el) => (el.dataset.scLine !== undefined ? (textOf(el).textContent ?? '') : (el.dataset.scHunk ?? '')))
    .join('\n');

  const rects = range.getClientRects();
  if (rects.length === 0) return;
  // 後ろから前へ選んだときは選択の先頭側、それ以外は末尾側に出す
  const backward = s.focusNode === range.startContainer && s.focusOffset === range.startOffset;
  const r = backward ? rects[0] : rects[rects.length - 1];
  if (r.bottom < 0 || r.top > window.innerHeight) return;
  showSnippet(DOM_OWNER, place(backward ? r.left : r.right, r.top, r.bottom), {
    path,
    start: Math.min(...nums),
    end: Math.max(...nums),
    code,
    lang: 'diff',
    note: useOld ? '(変更前)' : undefined,
  });
}

let domWatching = false;

/** HTML の差分表示の範囲選択の監視を始める (起動時に 1 回) */
export function watchDomSelectionCopy(): void {
  if (domWatching) return;
  domWatching = true;
  trackPointer();
  const sched = createScheduler(showFromDomSelection);
  const restart = () => {
    useSelectionCopy.getState().hide(DOM_OWNER);
    sched.kick();
  };
  document.addEventListener('selectionchange', restart);
  // スクロールしたら消し、止まってから位置を合わせて出し直す
  document.addEventListener(
    'scroll',
    () => {
      const s = document.getSelection();
      if (s && !s.isCollapsed) restart();
    },
    true,
  );
}
