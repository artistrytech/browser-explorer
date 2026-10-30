import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { FloatingWindow } from '../../components/FloatingWindow';
import { PenIcon } from '../../components/PenIcon';
import { useContextMenu } from '../../components/ContextMenu';
import { confirmDialog } from '../../stores/dialog';
import { useExplorer } from '../../stores/explorer';
import { toastError } from '../../stores/toast';
import type { AiAgent, AiBox } from '../../types';
import { AiTurnView } from './AiTurnView';
import { AI_LABELS, closeAiChat, defaultBoxName, timestampName, useAiChat } from './aiChatStore';
import { PERMISSION_NAMES, permissionLabel } from './aiPermissions';
import styles from './AiChat.module.scss';
import { createCssModuleClassNames } from '../../lib/cssModule';

const cx = createCssModuleClassNames(styles);

const AGENTS: AiAgent[] = ['codex', 'claude'];

const LIST_WIDTH_KEY = 'aichat:listWidth';
const DEFAULT_LIST_WIDTH = 180;
const MIN_LIST_WIDTH = 120;
/** 会話側に最低限残す幅 */
const MIN_MAIN_WIDTH = 280;

function loadListWidth(): number {
  try {
    const n = Number(localStorage.getItem(LIST_WIDTH_KEY));
    return Number.isFinite(n) && n >= MIN_LIST_WIDTH ? n : DEFAULT_LIST_WIDTH;
  } catch {
    return DEFAULT_LIST_WIDTH;
  }
}

function saveListWidth(w: number): void {
  try {
    localStorage.setItem(LIST_WIDTH_KEY, String(w));
  } catch {
    /* storage full 等は無視 */
  }
}

/**
 * AI チャット (VSCode の拡張機能のような Codex / Claude との対話)。
 * モードレスのウィンドウで開き、背後の画面を操作しながら使える。
 * 会話は Box 単位にまとめ、Box ごとにベースフォルダ (CLI の作業フォルダ) を持つ。
 */
export function AiChatDialog() {
  const open = useAiChat((s) => s.open);
  const [showList, setShowList] = useState(true);
  const [listWidth, setListWidth] = useState(loadListWidth);
  const chatRef = useRef<HTMLDivElement>(null);

  /** 一覧と会話の境界のドラッグで一覧の幅を変える */
  const startResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = listWidth;
    const clamp = (w: number) => {
      const max = (chatRef.current?.clientWidth ?? innerWidth) - MIN_MAIN_WIDTH;
      return Math.round(Math.max(MIN_LIST_WIDTH, Math.min(w, max)));
    };
    let last = startW;
    document.body.classList.add('col-resizing');
    const onMove = (ev: PointerEvent) => {
      last = clamp(startW + ev.clientX - startX);
      setListWidth(last);
    };
    const onUp = (ev: PointerEvent) => {
      onMove(ev);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('col-resizing');
      saveListWidth(last);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  if (!open) return null;
  return (
    <FloatingWindow
      title="🤖 AI チャット"
      storageKey="aichat:rect"
      defaultRect={() => {
        const w = Math.min(760, innerWidth - 40);
        const h = Math.min(720, innerHeight - 80);
        return { x: innerWidth - w - 24, y: 56, w, h };
      }}
      onClose={closeAiChat}
      headerExtra={
        <button
          className={cx('title-btn')}
          title={showList ? 'Box の一覧を隠す' : 'Box の一覧を表示'}
          onClick={() => setShowList((v) => !v)}
        >
          ☰
        </button>
      }
    >
      <div ref={chatRef} className={cx('chat')}>
        {showList && (
          <>
            {/* ウィンドウを縮めても会話側が潰れないよう、一覧は残り幅の範囲に収める */}
            <div
              className={cx('box-list-wrap')}
              style={{ width: listWidth, maxWidth: `calc(100% - ${MIN_MAIN_WIDTH}px)` }}
            >
              <BoxList />
            </div>
            <div className={cx('split-handle')} title="ドラッグで幅を変更" onPointerDown={startResize} />
          </>
        )}
        <div className={cx('chat-main')}>
          <MainArea />
        </div>
      </div>
    </FloatingWindow>
  );
}

function MainArea() {
  const creating = useAiChat((s) => s.creating);
  const box = useAiChat((s) => s.boxes.find((b) => b.id === s.selectedId) ?? null);
  const loaded = useAiChat((s) => s.boxesLoaded);
  if (creating) return <NewBoxForm />;
  if (!box) {
    return (
      <div className={cx('empty')}>
        {loaded ? 'Box を選ぶか、新規 Box を作成してください' : '読み込み中…'}
      </div>
    );
  }
  return <BoxView key={box.id} box={box} />;
}

// --- Box の一覧 ---

function BoxList() {
  const boxes = useAiChat((s) => s.boxes);
  const selectedId = useAiChat((s) => s.selectedId);
  const creating = useAiChat((s) => s.creating);
  const [renaming, setRenaming] = useState<number | null>(null);

  const onMenu = (e: React.MouseEvent, box: AiBox) => {
    e.preventDefault();
    useContextMenu.getState().open(e.clientX, e.clientY, [
      { label: '名前の変更', action: () => setRenaming(box.id) },
      {
        label: '削除',
        danger: true,
        disabled: box.running,
        action: () => void removeBox(box),
      },
    ]);
  };

  return (
    <div className={cx('box-list')}>
      <button
        className={cx(`box-new${creating ? ' active' : ''}`)}
        onClick={() => useAiChat.getState().setCreating(true)}
      >
        ＋ 新規 Box
      </button>
      <div className={cx('box-items')}>
        {boxes.map((b) =>
          renaming === b.id ? (
            <RenameInput key={b.id} box={b} onDone={() => setRenaming(null)} />
          ) : (
            <div
              key={b.id}
              className={cx(`box-item${b.id === selectedId && !creating ? ' active' : ''}`)}
              title={`${b.name}\n${b.cwd}\n(ダブルクリックで名前の変更)`}
              onClick={() => useAiChat.getState().select(b.id)}
              onDoubleClick={() => setRenaming(b.id)}
              onContextMenu={(e) => onMenu(e, b)}
            >
              <span className={cx('box-name')}>
                {b.running && <span className={cx('box-running')} title="実行中" />}
                {b.name}
              </span>
              <span className={cx('box-cwd')}>{b.cwd}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

async function removeBox(box: AiBox): Promise<void> {
  const ok = await confirmDialog('Box の削除', `「${box.name}」と、その会話をすべて削除します。`, true);
  if (!ok) return;
  try {
    await api.aiDeleteBox(box.id);
    await useAiChat.getState().loadBoxes();
  } catch (e) {
    toastError(e);
  }
}

async function renameBox(box: AiBox, name: string): Promise<void> {
  const v = name.trim();
  if (!v || v === box.name) return;
  try {
    useAiChat.getState().applyBox(await api.aiUpdateBox(box.id, { name: v }));
  } catch (e) {
    toastError(e);
  }
}

function RenameInput({ box, onDone }: { box: AiBox; onDone: () => void }) {
  const [value, setValue] = useState(box.name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  const commit = () => {
    onDone();
    void renameBox(box, value);
  };
  return (
    <input
      ref={ref}
      className={cx('input box-rename')}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') onDone();
      }}
    />
  );
}

// --- 新しい Box ---

function NewBoxForm() {
  const hasBoxes = useAiChat((s) => s.boxes.length > 0);
  const [stamp] = useState(() => timestampName());
  const [name, setName] = useState(stamp);
  /** 名前を手で書き換えたら、ベースフォルダを変えても既定名で上書きしない */
  const [nameEdited, setNameEdited] = useState(false);
  const [cwd, setCwd] = useState(() => useExplorer.getState().path);
  const [busy, setBusy] = useState(false);

  // 既定名はベースフォルダに合わせて付け直す (入力中に何度も問い合わせないよう少し待つ)
  useEffect(() => {
    if (nameEdited) return;
    let canceled = false;
    const timer = setTimeout(() => {
      void defaultBoxName(cwd, stamp).then((n) => {
        if (!canceled) setName(n);
      });
    }, 300);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [cwd, stamp, nameEdited]);

  const create = async () => {
    setBusy(true);
    try {
      const box = await api.aiCreateBox(name.trim() || (await defaultBoxName(cwd, stamp)), cwd);
      await useAiChat.getState().loadBoxes();
      useAiChat.getState().select(box.id);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cx('new-box')}>
      <div className={cx('new-box-title')}>新規 Box</div>
      <label className={cx('field')}>
        <span className={cx('field-label')}>名前</span>
        <input
          className={cx('input')}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameEdited(true);
          }}
        />
      </label>
      <label className={cx('field')}>
        <span className={cx('field-label')}>ベースフォルダ</span>
        <span className={cx('field-row')}>
          <input
            className={cx('input mono')}
            value={cwd}
            spellCheck={false}
            onChange={(e) => setCwd(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void create()}
          />
          <button
            className={cx('btn')}
            title="ファイル一覧で表示中のフォルダを入れる"
            onClick={() => setCwd(useExplorer.getState().path)}
          >
            表示中のフォルダ
          </button>
        </span>
      </label>
      <p className={cx('hint')}>
        Codex / Claude はベースフォルダを作業フォルダとして動きます。Box の中ではどちらの AI も使えます。
      </p>
      <div className={cx('buttons')}>
        <button className={cx('btn primary')} disabled={busy || !cwd.trim()} onClick={() => void create()}>
          作成
        </button>
        {hasBoxes && (
          <button className={cx('btn')} onClick={() => useAiChat.getState().setCreating(false)}>
            キャンセル
          </button>
        )}
      </div>
    </div>
  );
}

// --- Box の表示 (見出し・会話・送信欄) ---

function BoxView({ box }: { box: AiBox }) {
  const turns = useAiChat((s) => s.turns[box.id]);
  const collapsed = useAiChat((s) => s.collapsed);
  const toggle = useAiChat((s) => s.toggleCollapsed);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 末尾付近を見ているか (見ている間だけ新しい出力に追従してスクロールする) */
  const atBottom = useRef(true);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  return (
    <>
      <BoxHeader box={box} />
      <div
        ref={scrollRef}
        className={cx('timeline')}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!turns && <div className={cx('empty')}>読み込み中…</div>}
        {turns?.length === 0 && (
          <div className={cx('empty')}>
            下の入力欄から依頼を送ってください。
            <br />
            Ctrl+Enter で送信します。
          </div>
        )}
        {turns?.map((t, i) => (
          <div key={t.id}>
            {i > 0 && turns[i - 1].cwd !== t.cwd && (
              <div className={cx('cwd-divider')}>
                <span>📁 ベースフォルダを変更: {t.cwd}</span>
              </div>
            )}
            <AiTurnView turn={t} collapsed={collapsed[t.id] === true} onToggle={toggle} />
          </div>
        ))}
        {turns && turns.length > 0 && turns[turns.length - 1].cwd !== box.cwd && (
          <div className={cx('cwd-divider')}>
            <span>📁 ベースフォルダを変更: {box.cwd} (以降は新しい会話)</span>
          </div>
        )}
      </div>
      <Composer box={box} />
    </>
  );
}

function BoxHeader({ box }: { box: AiBox }) {
  const [editingName, setEditingName] = useState(false);
  const [editingCwd, setEditingCwd] = useState(false);
  const [cwd, setCwd] = useState(box.cwd);
  const hasTurns = useAiChat((s) => (s.turns[box.id]?.length ?? 0) > 0);

  const saveCwd = async () => {
    const v = cwd.trim();
    if (!v || v === box.cwd) {
      setEditingCwd(false);
      return;
    }
    const hasSession = Object.keys(box.sessions).length > 0;
    if (
      hasSession &&
      !(await confirmDialog(
        'ベースフォルダの変更',
        'ベースフォルダを変更すると、以降の依頼はすべて新しい会話になります (これまでの会話は続けられません)。',
      ))
    ) {
      return;
    }
    try {
      useAiChat.getState().applyBox(await api.aiUpdateBox(box.id, { cwd: v }));
      setEditingCwd(false);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className={cx('box-header')}>
      <div className={cx('box-header-row')}>
        {editingName ? (
          <RenameInput box={box} onDone={() => setEditingName(false)} />
        ) : (
          <button className={cx('box-title')} title="クリックで名前を変更" onClick={() => setEditingName(true)}>
            <span className={cx('box-title-text')}>{box.name}</span>
            <span className={cx('edit-mark')}>
              <PenIcon />
            </span>
          </button>
        )}
        <span className={cx('ai-spacer')} />
        {hasTurns && (
          <>
            <button
              className={cx('btn small')}
              title="AI の出力をすべて折り畳む"
              onClick={() => useAiChat.getState().setAllCollapsed(box.id, true)}
            >
              すべて折り畳む
            </button>
            <button
              className={cx('btn small')}
              title="AI の出力をすべて展開する"
              onClick={() => useAiChat.getState().setAllCollapsed(box.id, false)}
            >
              すべて展開
            </button>
          </>
        )}
        <button
          className={cx('btn small')}
          title={box.running ? '実行中は削除できません' : 'この Box を削除'}
          disabled={box.running}
          onClick={() => void removeBox(box)}
        >
          削除
        </button>
      </div>
      <div className={cx('box-header-row')}>
        <span className={cx('cwd-label')}>📁</span>
        {editingCwd ? (
          <>
            <input
              className={cx('input mono cwd-input')}
              value={cwd}
              spellCheck={false}
              autoFocus
              onChange={(e) => setCwd(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') void saveCwd();
                if (e.key === 'Escape') setEditingCwd(false);
              }}
            />
            <button
              className={cx('btn small')}
              title="ファイル一覧で表示中のフォルダを入れる"
              onClick={() => setCwd(useExplorer.getState().path)}
            >
              表示中のフォルダ
            </button>
            <button className={cx('btn small primary')} onClick={() => void saveCwd()}>
              変更
            </button>
            <button className={cx('btn small')} onClick={() => setEditingCwd(false)}>
              キャンセル
            </button>
          </>
        ) : (
          <>
            <span className={cx('cwd-path')} title={box.cwd}>
              {box.cwd}
            </span>
            <button
              className={cx('pen-btn')}
              disabled={box.running}
              title={box.running ? '実行中は変更できません' : 'ベースフォルダを変更 (以降は新しい会話になります)'}
              onClick={() => {
                setCwd(box.cwd);
                setEditingCwd(true);
              }}
            >
              <PenIcon />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// --- 送信欄 ---

function Composer({ box }: { box: AiBox }) {
  const agents = useAiChat((s) => s.agents);
  const prefs = useAiChat((s) => s.prefs);
  const draft = useAiChat((s) => s.drafts[box.id] ?? '');
  const runningTurn = useAiChat((s) => s.turns[box.id]?.find((t) => t.status === 'running') ?? null);
  const running = box.running || runningTurn !== null;
  const agent = prefs.agent;
  const session = box.sessions[agent];
  const canContinue = !!session?.sessionId;
  const [mode, setMode] = useState<'continue' | 'new'>(canContinue ? 'continue' : 'new');
  const [sending, setSending] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // 続けられる会話が無くなったら (AI の切替・ベースフォルダの変更) 新しい会話に、
  // 新しい会話を始めた直後は次から続けるのを既定にする
  useEffect(() => {
    setMode(canContinue ? 'continue' : 'new');
  }, [canContinue, agent, session?.thread]);

  const info = agents?.agents[agent];
  const models = agents?.models[agent] ?? [];
  const efforts = agents?.efforts[agent] ?? [];
  const model = models.includes(prefs.model[agent]) ? prefs.model[agent] : '';
  const effort = efforts.includes(prefs.effort[agent]) ? prefs.effort[agent] : '';
  const permissions = agents?.permissions[agent] ?? [];
  const permission = permissions.includes(prefs.permission[agent]) ? prefs.permission[agent] : '';
  const defaultPermission = agents?.defaultPermissions[agent] ?? '';
  const noneAvailable = agents !== null && !AGENTS.some((a) => agents.agents[a].available);
  const otherSession = AGENTS.find((a) => a !== agent && box.sessions[a]?.sessionId);

  const canSend = !!info?.available && !running && !sending && draft.trim().length > 0;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      const turn = await api.aiSend(box.id, { agent, mode, model, effort, permission, prompt: draft });
      useAiChat.getState().applyTurn(turn);
      useAiChat.getState().setDraft(box.id, '');
    } catch (e) {
      toastError(e);
    } finally {
      setSending(false);
      textRef.current?.focus();
    }
  };

  const stop = async () => {
    if (!runningTurn) return;
    try {
      await api.aiCancel(runningTurn.id);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className={cx('composer')}>
      {noneAvailable && (
        <div className={cx('composer-warn')}>
          codex / claude のどちらも PATH に見つかりません。インストールして PATH を通してから
          <button className={cx('link-btn')} onClick={() => void useAiChat.getState().refreshAgents(true)}>
            再確認
          </button>
          してください。
        </div>
      )}
      <div className={cx('composer-row')}>
        <label
          className={cx('opt')}
          title={info?.available ? `${info.path ?? ''}${info.version ? `\n${info.version}` : ''}` : undefined}
        >
          AI
          <select
            value={agent}
            onChange={(e) => useAiChat.getState().setPrefs({ agent: e.target.value as AiAgent })}
          >
            {AGENTS.map((a) => {
              const available = agents?.agents[a].available ?? false;
              return (
                <option key={a} value={a} disabled={!available}>
                  {AI_LABELS[a]}
                  {agents && !available ? ' (PATH にありません)' : ''}
                </option>
              );
            })}
          </select>
        </label>
        <label
          className={cx('opt')}
          title={
            canContinue
              ? `継続: ${AI_LABELS[agent]} の会話 #${session!.thread} の続き / 新規: 新しい会話を始める`
              : otherSession
                ? `${AI_LABELS[agent]} の会話がありません (${AI_LABELS[otherSession]} の会話は引き継げません)`
                : `${AI_LABELS[agent]} の会話がありません`
          }
        >
          会話
          <select value={mode} onChange={(e) => setMode(e.target.value as 'continue' | 'new')}>
            <option value="continue" disabled={!canContinue}>
              継続{canContinue ? ` (#${session!.thread})` : ''}
            </option>
            <option value="new">新規</option>
          </select>
        </label>
        <label className={cx('opt')}>
          モデル
          <select
            value={model}
            title={models.length === 0 ? '設定画面の「AI」タブでモデル名を登録できます' : undefined}
            onChange={(e) =>
              useAiChat.getState().setPrefs({ model: { ...prefs.model, [agent]: e.target.value } })
            }
          >
            <option value="">(既定)</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className={cx('opt')}>
          effort
          <select
            value={effort}
            onChange={(e) =>
              useAiChat.getState().setPrefs({ effort: { ...prefs.effort, [agent]: e.target.value } })
            }
          >
            <option value="">(既定)</option>
            {efforts.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label
          className={cx('opt')}
          title={`${PERMISSION_NAMES[agent]}: ${permissionLabel(agent, permission || defaultPermission)}`}
        >
          権限
          <select
            value={permission}
            onChange={(e) =>
              useAiChat.getState().setPrefs({ permission: { ...prefs.permission, [agent]: e.target.value } })
            }
          >
            <option value="">(既定: {defaultPermission})</option>
            {permissions.map((v) => (
              <option key={v} value={v}>
                {permissionLabel(agent, v)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <textarea
        ref={textRef}
        className={cx('input composer-text')}
        value={draft}
        placeholder={`${AI_LABELS[agent]} への依頼 (Ctrl+Enter で送信)`}
        onChange={(e) => useAiChat.getState().setDraft(box.id, e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className={cx('composer-row')}>
        <span className={cx('hint')}>
          {mode === 'continue' && canContinue
            ? `${AI_LABELS[agent]} の会話 #${session!.thread} の続きとして送ります`
            : `${AI_LABELS[agent]} と新しい会話を始めます`}
        </span>
        <span className={cx('ai-spacer')} />
        {running ? (
          <button className={cx('btn danger')} disabled={!runningTurn} onClick={() => void stop()}>
            ■ 停止
          </button>
        ) : (
          <button className={cx('btn primary')} disabled={!canSend} onClick={() => void send()}>
            {sending ? '送信中…' : '送信 (Ctrl+Enter)'}
          </button>
        )}
      </div>
    </div>
  );
}
