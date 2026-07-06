import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { loadGitView, saveGitView } from '../../lib/gitViewMemory';
import { useContextMenu, MenuItem } from '../../components/ContextMenu';
import { confirmDialog, promptDialog } from '../../stores/dialog';
import { useGit } from '../../stores/git';
import { toastError } from '../../stores/toast';
import { runGitCommands } from './GitCommandDialog';
import type { GitGraphCommit } from '../../types';

/**
 * Git グラフ表示 (002.md §5): コミット DAG をレーン (レール) 描画する。
 * レーン割り当ては表示順 (トポロジカル、上が新しい) に上から処理する (§5.3)。
 */

const LANE_W = 14;
const ROW_H = 26;
const PALETTE = ['#4e79a7', '#e15759', '#59a14f', '#f28e2b', '#b07aa1', '#76b7b2', '#edc948', '#ff9da7'];

interface Edge {
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  commit: GitGraphCommit;
  lane: number;
  /** 行の上端から中央 (ノード/通過点) へ入るエッジ */
  topEdges: Edge[];
  /** 中央から行の下端へ出るエッジ */
  bottomEdges: Edge[];
  color: number;
}

/**
 * レーン割り当て (§5.3)。lanes[i] = そのレーンが「次に描く予定のコミットハッシュ」。
 * 返り値の rows と、全体の最大レーン数を返す。
 */
export function assignLanes(commits: GitGraphCommit[]): { rows: GraphRow[]; maxLanes: number } {
  const lanes: (string | null)[] = [];
  const laneColor: number[] = [];
  let nextColor = 0;
  let maxLanes = 1;
  const rows: GraphRow[] = [];

  for (const c of commits) {
    const topEdges: Edge[] = [];
    const bottomEdges: Edge[] = [];

    // 1. 列の決定: c.hash を予約している最左レーン。無ければ空きレーン (=ブランチ先端)
    let col = -1;
    const merging: number[] = [];
    lanes.forEach((h, i) => {
      if (h === c.hash) {
        if (col < 0) col = i;
        else merging.push(i);
      }
    });
    if (col < 0) {
      col = lanes.indexOf(null);
      if (col < 0) {
        col = lanes.length;
        lanes.push(null);
        laneColor.push(0);
      }
      laneColor[col] = nextColor++ % PALETTE.length;
    } else {
      topEdges.push({ from: col, to: col, color: laneColor[col] });
    }

    // 2. 合流: c.hash を予約している他レーンは c の列へ (マージ流入)。合流元は解放
    for (const m of merging) {
      topEdges.push({ from: m, to: col, color: laneColor[m] });
      lanes[m] = null;
    }
    const color = laneColor[col];

    // 4. 通過レーン: c と無関係のレーンは縦の直線
    lanes.forEach((h, i) => {
      if (i !== col && h !== null) {
        topEdges.push({ from: i, to: i, color: laneColor[i] });
        bottomEdges.push({ from: i, to: i, color: laneColor[i] });
      }
    });

    // 3. 親の展開
    const parents = c.parents;
    if (parents.length === 0) {
      lanes[col] = null;
    } else {
      // 第 1 親は列を引き継ぐ。ただし既に他レーンが予約済みならそちらへ合流
      const p0 = parents[0];
      const existing = lanes.findIndex((h, i) => h === p0 && i !== col);
      if (existing >= 0) {
        bottomEdges.push({ from: col, to: existing, color: laneColor[existing] });
        lanes[col] = null;
      } else {
        lanes[col] = p0;
        bottomEdges.push({ from: col, to: col, color });
      }
      // 追加の親 (マージ元): 予約済みレーンを再利用、無ければ空き/右側に新規割当
      for (const p of parents.slice(1)) {
        let k = lanes.indexOf(p);
        if (k < 0) {
          k = lanes.indexOf(null);
          if (k < 0) {
            k = lanes.length;
            lanes.push(null);
            laneColor.push(0);
          }
          lanes[k] = p;
          laneColor[k] = nextColor++ % PALETTE.length;
        }
        bottomEdges.push({ from: col, to: k, color: laneColor[k] });
      }
    }

    maxLanes = Math.max(maxLanes, lanes.length, col + 1);
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
      laneColor.pop();
    }
    rows.push({ commit: c, lane: col, topEdges, bottomEdges, color });
  }
  return { rows, maxLanes };
}

const laneX = (lane: number) => lane * LANE_W + LANE_W / 2 + 2;

function edgePath(e: Edge, half: 'top' | 'bottom'): string {
  const x1 = laneX(e.from);
  const x2 = laneX(e.to);
  const [y1, y2] = half === 'top' ? [0, ROW_H / 2] : [ROW_H / 2, ROW_H];
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const my = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
}

function RowGraph({ row, width }: { row: GraphRow; width: number }) {
  return (
    <svg className="graph-svg" width={width} height={ROW_H}>
      {row.topEdges.map((e, i) => (
        <path key={`t${i}`} d={edgePath(e, 'top')} stroke={PALETTE[e.color]} strokeWidth={2} fill="none" />
      ))}
      {row.bottomEdges.map((e, i) => (
        <path key={`b${i}`} d={edgePath(e, 'bottom')} stroke={PALETTE[e.color]} strokeWidth={2} fill="none" />
      ))}
      <circle
        cx={laneX(row.lane)}
        cy={ROW_H / 2}
        r={4.5}
        fill={PALETTE[row.color]}
        stroke="var(--bg, #fff)"
        strokeWidth={1.5}
      />
    </svg>
  );
}

/** ref 名 (HEAD / ブランチ / タグ) をチップとして表示 (§5.5) */
function RefChips({ refs }: { refs: string[] }) {
  if (refs.length === 0) return null;
  return (
    <>
      {refs.map((r) => {
        let cls = 'ref-branch';
        let label = r;
        if (r.startsWith('HEAD -> ')) {
          label = r.slice('HEAD -> '.length);
          cls = 'ref-head';
        } else if (r === 'HEAD') {
          cls = 'ref-head';
        } else if (r.startsWith('tag: ')) {
          label = r.slice(5);
          cls = 'ref-tag';
        } else if (r.includes('/')) {
          cls = 'ref-remote';
        }
        return (
          <span key={r} className={`ref-chip ${cls}`}>
            {label}
          </span>
        );
      })}
    </>
  );
}

const PAGE = 200;

export function GitGraph({
  repo,
  onSelect,
  selectedHash,
}: {
  repo: string;
  onSelect: (hash: string) => void;
  selectedHash: string | null;
}) {
  const [commits, setCommits] = useState<GitGraphCommit[]>([]);
  const [all, setAll] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const openMenu = useContextMenu((s) => s.open);
  const status = useGit((s) => s.status);
  const rowsRef = useRef<HTMLDivElement>(null);
  const scrollRestoredRef = useRef(false);

  // スクロール位置を sessionStorage に保持 (タブ復帰時に復元)。
  // アンマウント時はデバウンス待ちの値をフラッシュして取りこぼしを防ぐ
  useEffect(() => {
    const el = rowsRef.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout>;
    let last = -1;
    const onScroll = () => {
      last = el.scrollTop;
      clearTimeout(t);
      t = setTimeout(() => saveGitView(repo, { graphScrollTop: last }), 250);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      clearTimeout(t);
      el.removeEventListener('scroll', onScroll);
      if (last >= 0) saveGitView(repo, { graphScrollTop: last });
    };
  }, [repo]);

  // 初回描画後に一度だけスクロール位置を復元
  useEffect(() => {
    if (scrollRestoredRef.current || commits.length === 0 || !rowsRef.current) return;
    scrollRestoredRef.current = true;
    const saved = loadGitView(repo);
    if (saved) rowsRef.current.scrollTop = saved.graphScrollTop;
  }, [commits, repo]);

  const load = (reset: boolean) => {
    setLoading(true);
    const skip = reset ? 0 : commits.length;
    api
      .gitGraph(repo, { all, limit: PAGE, skip })
      .then((r) => {
        // ページングはレーン連続性のため読み込み済み全体を再計算する (§5.4)
        setCommits((prev) => (reset ? r.commits : [...prev, ...r.commits]));
        setHasMore(r.commits.length === PAGE);
      })
      .catch(toastError)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, all, status]);

  const { rows, maxLanes } = useMemo(() => assignLanes(commits), [commits]);
  const graphWidth = Math.min(maxLanes, 12) * LANE_W + 8;

  const commitMenu = (e: React.MouseEvent, c: GitGraphCommit) => {
    e.preventDefault();
    const short = c.hash.slice(0, 7);
    const items: MenuItem[] = [
      { label: '差分を表示', action: () => onSelect(c.hash) },
      { separator: true },
      {
        label: `このコミットを checkout (${short})`,
        action: () =>
          void confirmDialog('checkout', `${short} を checkout しますか? (detached HEAD)`).then((ok) => {
            if (ok) void runGitCommands(repo, [['checkout', c.hash]], 'Checkout');
          }),
      },
      {
        label: `ここへ reset --mixed`,
        action: () =>
          void confirmDialog('reset --mixed', `現在のブランチを ${short} へ reset しますか?`).then((ok) => {
            if (ok) void runGitCommands(repo, [['reset', '--mixed', c.hash]], 'Reset');
          }),
      },
      {
        label: `ここへ reset --hard`,
        danger: true,
        action: () =>
          void confirmDialog(
            'reset --hard',
            `${short} へ reset --hard します。作業ツリーの変更は失われます。よろしいですか?`,
            true,
          ).then((ok) => {
            if (ok) void runGitCommands(repo, [['reset', '--hard', c.hash]], 'Reset --hard');
          }),
      },
      {
        label: 'cherry-pick',
        action: () => void runGitCommands(repo, [['cherry-pick', c.hash]], 'Cherry-pick'),
      },
      {
        label: 'タグを付ける…',
        action: () =>
          void promptDialog('タグ付け', '', { message: `${short} に付けるタグ名` }).then((name) => {
            if (name) void runGitCommands(repo, [['tag', name, c.hash]], 'タグ付け');
          }),
      },
    ];
    openMenu(e.clientX, e.clientY, items);
  };

  return (
    <div className="git-graph">
      <div className="graph-toolbar">
        <label>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          全ブランチ (--all)
        </label>
      </div>
      <div className="graph-rows" ref={rowsRef}>
        {rows.map((row) => {
          const c = row.commit;
          return (
            <button
              key={c.hash}
              className={`graph-row${selectedHash === c.hash ? ' active' : ''}`}
              style={{ height: ROW_H }}
              onClick={() => onSelect(c.hash)}
              onContextMenu={(e) => commitMenu(e, c)}
              title={`${c.hash}\n${c.subject}`}
            >
              <span className="graph-cell" style={{ width: graphWidth }}>
                <RowGraph row={row} width={graphWidth} />
              </span>
              <span className="graph-hash">{c.hash.slice(0, 7)}</span>
              <span className="graph-subject">
                <RefChips refs={c.refs} />
                {c.subject}
              </span>
              <span className="graph-meta">
                {c.author} · {c.date.slice(0, 16).replace('T', ' ')}
              </span>
            </button>
          );
        })}
        {rows.length === 0 && !loading && <div className="empty-hint">コミットがありません</div>}
        {hasMore && (
          <button className="btn graph-more" disabled={loading} onClick={() => load(false)}>
            {loading ? '読み込み中…' : 'さらに読み込む'}
          </button>
        )}
      </div>
    </div>
  );
}
