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

/**
 * AI チャット (VSCode の拡張機能のような Codex / Claude との対話)。
 * 表示はモードレスのフローティングウィンドウか、右パネルへの固定 (AiChatPanel) を選べる。
 * どちらも背後の画面を操作しながら使える。
 * 会話は Box 単位にまとめ、Box ごとにベースフォルダ (CLI の作業フォルダ) を持つ。
 */
export function AiChatDialog() {
  const open = useAiChat((s) => s.open);
  const docked = useAiChat((s) => s.docked);
  if (!open || docked) return null;
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
      headerExtra={<HeaderButtons />}
    >
      <ChatContent />
    </FloatingWindow>
  );
}

/** 右パネルに固定したときの表示 (App のメイン領域の右のパネルに置く) */
export function AiChatPanel() {
  return (
    // パネル内のキー操作が背後の画面 (Alt+← 等のグローバルキー) へ伝わらないようにする
    <div className={cx('dock')} onKeyDown={(e) => e.stopPropagation()}>
      <div className={cx('dock-title')}>
        <span className={cx('dock-title-text')}>🤖 AI チャット</span>
        <HeaderButtons />
        <button className={cx('title-btn close')} title="閉じる" onClick={closeAiChat}>
          ✕
        </button>
      </div>
      <ChatContent />
    </div>
  );
}

/** 右パネルに固定するアイコン (枠の右側を塗る) */
function DockRightIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" />
      <rect x="9" y="3" width="5" height="10" fill="currentColor" />
    </svg>
  );
}

/** フローティングに戻すアイコン (重なった 2 枚の枠) */
function FloatIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
      <rect x="1.5" y="5.5" width="9" height="8" rx="1" />
      <path d="M5.5 5.5V2.5h9v8h-4" />
    </svg>
  );
}

/** タイトルバーのボタン (右パネル固定 ⇄ フローティング) */
function HeaderButtons() {
  const docked = useAiChat((s) => s.docked);
  return (
    <button
      className={cx('title-btn')}
      title={docked ? 'フローティングで表示' : '右パネルに固定'}
      onClick={() => useAiChat.getState().setDocked(!docked)}
    >
      {docked ? <FloatIcon /> : <DockRightIcon />}
    </button>
  );
}

/** Box の選択と会話 (フローティング・右パネル共通) */
function ChatContent() {
  return (
    <div className={cx('chat')}>
      <BoxBar />
      <div className={cx('chat-main')}>
        <MainArea />
      </div>
    </div>
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

// --- Box の選択 (上部のバー) ---

/** Box の選択 (ドロップダウン)・名前の変更・出力の一括折り畳み・削除 */
function BoxBar() {
  const creating = useAiChat((s) => s.creating);
  const box = useAiChat((s) => (s.creating ? null : (s.boxes.find((b) => b.id === s.selectedId) ?? null)));
  const hasTurns = useAiChat((s) => (box ? (s.turns[box.id]?.length ?? 0) > 0 : false));
  /** 名前を編集中の Box (別の Box に切り替えたら編集は終わる) */
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const renaming = box !== null && renamingId === box.id;

  return (
    <div className={cx('box-bar')}>
      {renaming ? (
        <RenameInput box={box} onDone={() => setRenamingId(null)} />
      ) : (
        <BoxPicker
          current={box}
          label={creating ? '新規 Box' : (box?.name ?? 'Box を選択')}
          onRename={(b) => {
            useAiChat.getState().select(b.id);
            setRenamingId(b.id);
          }}
        />
      )}
      {box && !renaming && (
        <button className={cx('pen-btn')} title="名前を変更" onClick={() => setRenamingId(box.id)}>
          <PenIcon />
        </button>
      )}
      <span className={cx('ai-spacer')} />
      {box && hasTurns && (
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
      {box && (
        <button
          className={cx('btn small')}
          title={box.running ? '実行中は削除できません' : 'この Box を削除'}
          disabled={box.running}
          onClick={() => void removeBox(box)}
        >
          削除
        </button>
      )}
    </div>
  );
}

/**
 * Box を選ぶドロップダウン (select ではなく独自の部品)。
 * 開くと絞り込みの入力欄と一覧を出し、↑↓ で選んで Enter で切り替える。
 * 一覧の右クリックで名前の変更・削除、末尾のボタンで新規 Box の作成。
 */
function BoxPicker({
  current,
  label,
  onRename,
}: {
  current: AiBox | null;
  label: string;
  onRename: (box: AiBox) => void;
}) {
  const boxes = useAiChat((s) => s.boxes);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  const rows = q ? boxes.filter((b) => `${b.name}\n${b.cwd}`.toLowerCase().includes(q)) : boxes;

  // 開いたら絞り込みを空にし、選択中の Box に合わせる
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(Math.max(0, boxes.findIndex((b) => b.id === current?.id)));
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 外側のクリックで閉じる
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    const el = listRef.current?.children[active];
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = (b: AiBox | undefined) => {
    if (!b) return;
    setOpen(false);
    useAiChat.getState().select(b.id);
  };

  const onMenu = (e: React.MouseEvent, b: AiBox) => {
    e.preventDefault();
    useContextMenu.getState().open(e.clientX, e.clientY, [
      {
        label: '名前の変更',
        action: () => {
          setOpen(false);
          onRename(b);
        },
      },
      { label: '削除', danger: true, disabled: b.running, action: () => void removeBox(b) },
    ]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const move = (delta: number) => {
      e.preventDefault();
      if (rows.length > 0) setActive((i) => (i + delta + rows.length) % rows.length);
    };
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Enter') {
      e.preventDefault();
      choose(rows[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={cx('picker')}>
      <button
        className={cx(`picker-btn${open ? ' open' : ''}`)}
        title={current ? `${current.name}\n${current.cwd}` : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {current?.running && <span className={cx('box-running')} title="実行中" />}
        <span className={cx('picker-label')}>{label}</span>
        <span className={cx('picker-caret')}>▾</span>
      </button>
      {open && (
        <div className={cx('picker-pop')}>
          <input
            ref={inputRef}
            className={cx('input picker-filter')}
            value={query}
            placeholder="名前・フォルダで絞り込み"
            spellCheck={false}
            role="combobox"
            aria-expanded="true"
            aria-controls="aichat-box-list"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <div ref={listRef} id="aichat-box-list" className={cx('picker-list')} role="listbox">
            {rows.map((b, i) => (
              <div
                key={b.id}
                role="option"
                aria-selected={b.id === current?.id}
                className={cx(`picker-item${i === active ? ' active' : ''}${b.id === current?.id ? ' current' : ''}`)}
                title={`${b.name}\n${b.cwd}\n(右クリックで名前の変更・削除)`}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => choose(b)}
                onContextMenu={(e) => onMenu(e, b)}
              >
                <span className={cx('picker-check')}>{b.id === current?.id ? '✓' : ''}</span>
                <span className={cx('picker-item-main')}>
                  <span className={cx('picker-item-name')}>
                    {b.running && <span className={cx('box-running')} title="実行中" />}
                    {b.name}
                  </span>
                  <span className={cx('picker-item-cwd')}>{b.cwd}</span>
                </span>
              </div>
            ))}
            {rows.length === 0 && (
              <div className={cx('picker-empty')}>{boxes.length === 0 ? 'Box はまだありません' : '一致する Box はありません'}</div>
            )}
          </div>
          <button
            className={cx('picker-new')}
            onClick={() => {
              setOpen(false);
              useAiChat.getState().setCreating(true);
            }}
          >
            ＋ 新規 Box
          </button>
        </div>
      )}
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

/** ベースフォルダの表示と変更 */
function BoxHeader({ box }: { box: AiBox }) {
  const [editingCwd, setEditingCwd] = useState(false);
  const [cwd, setCwd] = useState(box.cwd);

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
