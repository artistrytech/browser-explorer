import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { getSessionId } from '../../lib/session';
import { useAppLog, closeAppLog, DEFAULT_LOG_FILTER } from '../../stores/applog';
import { confirmDialog } from '../../stores/dialog';
import { useToast, toastError } from '../../stores/toast';
import type { LogEntry, LogLevel, LogSessionSummary, LogSource } from '../../types';
import styles from './AppLog.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

const AUTO_REFRESH_MS = 5000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** ISO (UTC) → ローカル時刻 "MM/DD HH:mm:ss.SSS" */
function formatTs(iso: string): string {
  const d = new Date(iso);
  return (
    `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${String(d.getMilliseconds()).padStart(3, '0')}`
  );
}

/** datetime-local 用 "YYYY-MM-DDTHH:mm" (ローカル時刻) */
function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 詳細 JSON の表示: stack はそのまま複数行、その他は整形 JSON */
function DetailView({ entry }: { entry: LogEntry }) {
  const d = entry.detail ?? {};
  const stack = typeof d.stack === 'string' ? d.stack : null;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) if (k !== 'stack') rest[k] = v;
  const restJson = Object.keys(rest).length ? JSON.stringify(rest, null, 2) : null;
  return (
    <div className={cx('applog-detail')}>
      <div className={cx('applog-detail-row')}>
        <span className={cx('applog-detail-key')}>日時</span>
        <span>
          {formatTs(entry.ts)} ({entry.ts})
        </span>
      </div>
      <div className={cx('applog-detail-row')}>
        <span className={cx('applog-detail-key')}>種別</span>
        <span>
          {entry.source} / {entry.event} / {entry.level}
        </span>
      </div>
      {entry.sessionId && (
        <div className={cx('applog-detail-row')}>
          <span className={cx('applog-detail-key')}>セッション</span>
          <span className={cx('mono')}>{entry.sessionId}</span>
        </div>
      )}
      {entry.requestId && (
        <div className={cx('applog-detail-row')}>
          <span className={cx('applog-detail-key')}>リクエスト</span>
          <span className={cx('mono')}>{entry.requestId}</span>
        </div>
      )}
      <div className={cx('applog-detail-row')}>
        <span className={cx('applog-detail-key')}>メッセージ</span>
        <span style={{ wordBreak: 'break-all' }}>{entry.message}</span>
      </div>
      {restJson && <pre>{restJson}</pre>}
      {stack && <pre>{stack}</pre>}
    </div>
  );
}

/** アプリログビュー: 絞り込み (文字列 / レベル / セッション / リクエスト / 期間) + 一覧 + 行の詳細展開 */
export function AppLogTab() {
  const filter = useAppLog((s) => s.filter);
  const entries = useAppLog((s) => s.entries);
  const hasMore = useAppLog((s) => s.hasMore);
  const loading = useAppLog((s) => s.loading);
  const error = useAppLog((s) => s.error);
  const autoRefresh = useAppLog((s) => s.autoRefresh);
  const { setFilter, resetFilter, reload, loadMore, setAutoRefresh } = useAppLog.getState();
  const [selected, setSelected] = useState<number | null>(null);
  const [sessions, setSessions] = useState<LogSessionSummary[]>([]);
  const [stats, setStats] = useState<{ count: number; retentionDays: number } | null>(null);
  const mySession = getSessionId();
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  // 初回表示: 一覧とセッション候補・件数を読み込む
  useEffect(() => {
    void reload();
    void api.logSessions().then((r) => setSessions(r.sessions)).catch(() => {});
    void api.logStats().then(setStats).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 条件変更は少し待ってから再検索 (文字列入力の打鍵ごとに叩かない)
  const isFirst = useRef(true);
  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false;
      return;
    }
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void reload(), 300);
    return () => clearTimeout(debounce.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // 自動更新 (タブが非表示の間は止める)
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh]);

  const doClear = async () => {
    const ok = await confirmDialog('ログの全削除', 'すべてのアプリログを削除します。よろしいですか?', true);
    if (!ok) return;
    try {
      const r = await api.logClear();
      useToast.getState().show('success', `ログを ${r.deleted} 件削除しました`);
      void reload();
      void api.logStats().then(setStats).catch(() => {});
    } catch (e) {
      toastError(e);
    }
  };

  const setRange = (hours: number | null) => {
    if (hours === null) {
      setFilter({ from: '', to: '' });
      return;
    }
    setFilter({ from: toLocalInput(new Date(Date.now() - hours * 3600 * 1000)), to: '' });
  };

  const filterIsDefault = JSON.stringify(filter) === JSON.stringify(DEFAULT_LOG_FILTER);

  return (
    <div className={cx('applog')}>
      <div className={cx('applog-toolbar')}>
        <div className={cx('applog-toolbar-row')}>
          <input
            className={cx('applog-input q')}
            placeholder="🔍 メッセージ / 詳細を検索"
            value={filter.q}
            onChange={(e) => setFilter({ q: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void reload();
              if (e.key === 'Escape') setFilter({ q: '' });
            }}
          />
          <label className={cx('applog-field')}>
            レベル
            <select
              className={cx('applog-select')}
              value={filter.level}
              onChange={(e) => setFilter({ level: e.target.value as LogLevel })}
            >
              <option value="debug">debug 以上 (すべて)</option>
              <option value="info">info 以上</option>
              <option value="warn">warn 以上</option>
              <option value="error">error のみ</option>
            </select>
          </label>
          <label className={cx('applog-field')}>
            発生元
            <select
              className={cx('applog-select')}
              value={filter.source}
              onChange={(e) => setFilter({ source: e.target.value as LogSource | '' })}
            >
              <option value="">両方</option>
              <option value="server">サーバ</option>
              <option value="client">クライアント</option>
            </select>
          </label>
          <span className={cx('applog-spacer')} />
          <button className={cx('applog-btn')} disabled={loading} onClick={() => void reload()}>
            更新
          </button>
          <button
            className={cx(`applog-btn${autoRefresh ? ' on' : ''}`)}
            title={`${AUTO_REFRESH_MS / 1000} 秒ごとに先頭を再読込`}
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            自動更新
          </button>
          <button className={cx('applog-btn')} disabled={filterIsDefault} onClick={resetFilter}>
            条件クリア
          </button>
          <button className={cx('applog-btn danger')} onClick={() => void doClear()}>
            全削除
          </button>
          <button className={cx('applog-close')} title="アプリログタブを閉じる" onClick={closeAppLog}>
            ✕
          </button>
        </div>
        <div className={cx('applog-toolbar-row')}>
          <label className={cx('applog-field')}>
            セッション
            <input
              className={cx('applog-input id')}
              list="applog-sessions"
              placeholder="タブの ID"
              value={filter.session}
              onChange={(e) => setFilter({ session: e.target.value })}
            />
            <datalist id="applog-sessions">
              {sessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {`${formatTs(s.lastTs)} / ${s.count} 件${s.errors ? ` / エラー ${s.errors}` : ''}${
                    s.sessionId === mySession ? ' / このタブ' : ''
                  }`}
                </option>
              ))}
            </datalist>
          </label>
          <button
            className={cx(`applog-btn${filter.session === mySession ? ' on' : ''}`)}
            title={`このタブのセッション ID: ${mySession}`}
            onClick={() => setFilter({ session: filter.session === mySession ? '' : mySession })}
          >
            このタブのみ
          </button>
          <label className={cx('applog-field')}>
            リクエスト
            <input
              className={cx('applog-input id')}
              placeholder="リクエスト ID"
              value={filter.request}
              onChange={(e) => setFilter({ request: e.target.value })}
            />
          </label>
          <label className={cx('applog-field')}>
            期間
            <input
              type="datetime-local"
              className={cx('applog-input')}
              value={filter.from}
              onChange={(e) => setFilter({ from: e.target.value })}
            />
            〜
            <input
              type="datetime-local"
              className={cx('applog-input')}
              value={filter.to}
              onChange={(e) => setFilter({ to: e.target.value })}
            />
          </label>
          <button className={cx('applog-btn')} onClick={() => setRange(1)}>
            1 時間
          </button>
          <button className={cx('applog-btn')} onClick={() => setRange(24)}>
            24 時間
          </button>
          <button className={cx('applog-btn')} onClick={() => setRange(null)}>
            全期間
          </button>
          <span className={cx('applog-spacer')} />
          <span className={cx('applog-meta')}>
            このタブ: <span className={cx('mono')}>{mySession}</span>
            {stats && ` / 全 ${stats.count.toLocaleString()} 件 / 保存 ${stats.retentionDays} 日`}
          </span>
        </div>
      </div>

      {error && <div className={cx('applog-error')}>{error}</div>}

      <div className={cx('applog-table')}>
        <div className={cx('applog-tr applog-th')}>
          <span className={cx('applog-c-ts')}>日時</span>
          <span className={cx('applog-c-level')}>レベル</span>
          <span className={cx('applog-c-src')}>発生元</span>
          <span className={cx('applog-c-sid')}>セッション</span>
          <span className={cx('applog-c-rid')}>リクエスト</span>
          <span className={cx('applog-c-msg')}>メッセージ</span>
        </div>
        {entries.length === 0 && !loading && <div className={cx('empty-hint')}>該当するログはありません</div>}
        {entries.map((e) => (
          <div key={e.id}>
            <div
              className={cx(`applog-tr level-${e.level}${selected === e.id ? ' selected' : ''}`)}
              onClick={() => setSelected(selected === e.id ? null : e.id)}
              title={e.message}
            >
              <span className={cx('applog-c-ts')}>{formatTs(e.ts)}</span>
              <span className={cx('applog-c-level')}>{e.level}</span>
              <span className={cx('applog-c-src')}>{e.source}</span>
              <span className={cx('applog-c-sid')}>
                {e.sessionId ? (
                  <button
                    className={cx('applog-link')}
                    title={`セッション ${e.sessionId} で絞り込む`}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setFilter({ session: e.sessionId ?? '' });
                    }}
                  >
                    {e.sessionId}
                  </button>
                ) : (
                  '-'
                )}
              </span>
              <span className={cx('applog-c-rid')}>
                {e.requestId ? (
                  <button
                    className={cx('applog-link')}
                    title={`リクエスト ${e.requestId} で絞り込む`}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setFilter({ request: e.requestId ?? '', level: 'debug' });
                    }}
                  >
                    {e.requestId}
                  </button>
                ) : (
                  '-'
                )}
              </span>
              <span className={cx('applog-c-msg')}>{e.message}</span>
            </div>
            {selected === e.id && <DetailView entry={e} />}
          </div>
        ))}
        {hasMore && (
          <div className={cx('applog-more')}>
            <button className={cx('applog-btn')} disabled={loading} onClick={() => void loadMore()}>
              {loading ? '読み込み中…' : 'さらに古いログを読み込む'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
