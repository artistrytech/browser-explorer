import { memo, useMemo } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { copyText } from '../../lib/clipboard';
import { useToast, toastError } from '../../stores/toast';
import type { AiItem, AiTurn } from '../../types';
import { AI_LABELS } from './aiChatStore';
import { permissionLabel } from './aiPermissions';
import styles from './AiChat.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

const md = new Marked({ gfm: true, breaks: true });

/** AI の返答 (Markdown) を HTML にする。サニタイズ済み */
function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(md.parse(text, { async: false }), { USE_PROFILES: { html: true } });
}

/**
 * 返答中のリンクはアプリのタブを遷移させないよう横取りする。
 * http(s) だけ別ウィンドウで開き、ローカルのパス等は何もしない
 */
function onMarkdownClick(e: React.MouseEvent) {
  const a = (e.target as HTMLElement).closest('a');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href') ?? '';
  if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener');
}

const TextItem = memo(function TextItem({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={cx('ai-md')} onClick={onMarkdownClick} dangerouslySetInnerHTML={{ __html: html }} />;
});

const STATUS_ICON = { running: '⏳', done: '✓', error: '✗' } as const;

function ItemView({ item }: { item: AiItem }) {
  switch (item.kind) {
    case 'text':
      return <TextItem text={item.text} />;
    case 'reasoning':
      return (
        <details className={cx('ai-reasoning')}>
          <summary>💭 思考</summary>
          <div className={cx('ai-reasoning-text')}>{item.text}</div>
        </details>
      );
    case 'tool':
      return (
        <details className={cx(`ai-tool ${item.status}`)}>
          <summary>
            <span className={cx('ai-tool-icon')}>{STATUS_ICON[item.status]}</span>
            <span className={cx('ai-tool-title')} title={item.title}>
              {item.title}
            </span>
          </summary>
          {item.detail && <pre className={cx('ai-pre')}>{item.detail}</pre>}
          {item.output && <pre className={cx('ai-pre output')}>{item.output}</pre>}
          {!item.detail && !item.output && <div className={cx('ai-tool-empty')}>(出力なし)</div>}
        </details>
      );
    case 'error':
      return <div className={cx('ai-error')}>{item.text}</div>;
  }
}

const STATUS_LABEL: Record<AiTurn['status'], string> = {
  running: '実行中…',
  done: '完了',
  error: 'エラー',
  canceled: '停止しました',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function duration(t: AiTurn): string {
  if (!t.finishedAt) return '';
  const sec = Math.max(0, Math.round((Date.parse(t.finishedAt) - Date.parse(t.createdAt)) / 1000));
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
}

/** 返答の本文 (テキスト項目) だけをつなげたもの。コピーと折り畳み時の要約に使う */
function answerText(t: AiTurn): string {
  return t.items
    .filter((i): i is Extract<AiItem, { kind: 'text' }> => i.kind === 'text')
    .map((i) => i.text)
    .join('\n\n');
}

export const AiTurnView = memo(function AiTurnView({
  turn,
  collapsed,
  onToggle,
}: {
  turn: AiTurn;
  collapsed: boolean;
  onToggle: (turnId: number) => void;
}) {
  const answer = answerText(turn);
  const summary = answer.split('\n').find((l) => l.trim()) ?? '';
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await copyText(answer);
      useToast.getState().show('success', '返答をコピーしました');
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <div className={cx('turn')}>
      <div className={cx('user-msg')}>
        <div className={cx('turn-meta')}>
          <span className={cx(`agent-chip ${turn.agent}`)}>{AI_LABELS[turn.agent]}</span>
          <span>
            会話 #{turn.thread} ({turn.mode === 'new' ? '新規' : '継続'})
          </span>
          <span>{turn.model || 'モデル既定'}</span>
          <span>effort: {turn.effort || '既定'}</span>
          {turn.permission && <span title={permissionLabel(turn.agent, turn.permission)}>権限: {turn.permission}</span>}
          <span className={cx('turn-time')}>{formatTime(turn.createdAt)}</span>
        </div>
        <div className={cx('user-text')}>{turn.prompt}</div>
      </div>

      <div className={cx(`ai-msg ${turn.status}`)}>
        <div className={cx('ai-head')} onClick={() => onToggle(turn.id)} title={collapsed ? '展開する' : '折り畳む'}>
          <span className={cx('ai-caret')}>{collapsed ? '▸' : '▾'}</span>
          <span className={cx('ai-name')}>{AI_LABELS[turn.agent]}</span>
          <span className={cx(`ai-status ${turn.status}`)}>{STATUS_LABEL[turn.status]}</span>
          {turn.status !== 'running' && <span className={cx('ai-dim')}>{duration(turn)}</span>}
          {collapsed && summary && <span className={cx('ai-summary')}>{summary}</span>}
          <span className={cx('ai-spacer')} />
          {answer && (
            <button className={cx('ai-icon-btn')} title="返答 (本文) をコピー" onClick={(e) => void copy(e)}>
              ⧉
            </button>
          )}
        </div>
        {!collapsed && (
          <div className={cx('ai-body')}>
            {turn.items.map((item) => (
              <ItemView key={item.key} item={item} />
            ))}
            {turn.status === 'running' && turn.items.length === 0 && (
              <div className={cx('ai-dim')}>応答を待っています…</div>
            )}
            {turn.error && <div className={cx('ai-error')}>{turn.error}</div>}
            {turn.usage && <div className={cx('ai-usage')}>{turn.usage}</div>}
          </div>
        )}
      </div>
    </div>
  );
});
