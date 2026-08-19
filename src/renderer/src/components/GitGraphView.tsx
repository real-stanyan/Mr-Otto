// Git Graph(只读)— 泳道图 + commit 详情。数据全从 store 取,零 IPC 纯投影。
// 泳道几何由 shared/assignLanes 算出,这里只负责把 lane/edges 画成 SVG。

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, GitBranch, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import { SidebarNub } from "./SidebarNub.js";
import { Button } from "@/components/ui/button.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { useChat } from "../store.js";
import { assignLanes, type GitRef, type RawCommit } from "../../../shared/gitGraph.js";
import { nearBottom, visibleRange } from "../../../shared/virtualWindow.js";
import { formatRelativeTime } from "../../../shared/relativeTime.js";

const ROW_H = 28;
const LANE_W = 14;
const DOT_R = 3.5;
/** 泳道轮转色:亮暗主题下都可读的中饱和度色板(SVG stroke 用不了 Tailwind 类) */
const LANE_COLORS = ["#4a9df8", "#e0a458", "#7cb96d", "#d96a6a", "#b07cd8", "#4fb8c4", "#c88ab0", "#8a92e0"];
const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];

/** ref 徽章:HEAD 分支高亮,本地分支次之,remote/tag 弱化 */
function RefBadge({ r }: { r: GitRef }) {
  const cls =
    r.type === "head" ? "bg-brand/20 text-brand font-semibold"
    : r.type === "branch" ? "bg-brand/10 text-brand"
    : "bg-muted text-muted-foreground";
  return <span className={`shrink-0 rounded px-[5px] py-px text-[10px] font-mono ${cls}`}>{r.name}</span>;
}

/** 行间线段:三次贝塞尔,同道退化成直线 */
function edgePath(fromLane: number, toLane: number): string {
  const x1 = fromLane * LANE_W + LANE_W / 2;
  const x2 = toLane * LANE_W + LANE_W / 2;
  const y1 = ROW_H / 2;
  const y2 = ROW_H + ROW_H / 2;
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  return `M ${x1} ${y1} C ${x1} ${y1 + ROW_H / 2}, ${x2} ${y2 - ROW_H / 2}, ${x2} ${y2}`;
}

const ERROR_GUIDE: Record<string, string> = {
  "git-missing": "未找到 git。安装 Xcode Command Line Tools:xcode-select --install",
  "no-repo": "此文件夹不是 git 仓库——git init 之后这里就有图了。",
  "git-error": "git 命令失败,可点刷新重试。",
};

export function GitGraphView() {
  // 逐字段 selector(而非整店解构):直播流每 token 触发 store set,
  // 整店订阅会让本视图跟着任意会话的流式更新重渲——泳道图与流式内容毫无关系
  const gitGraphRepo = useChat((s) => s.gitGraphRepo);
  const gitGraph = useChat((s) => s.gitGraph);
  const gitCommitView = useChat((s) => s.gitCommitView);
  const closeGitGraph = useChat((s) => s.closeGitGraph);
  const refreshGitGraph = useChat((s) => s.refreshGitGraph);
  const openGitCommit = useChat((s) => s.openGitCommit);
  const closeGitCommit = useChat((s) => s.closeGitCommit);
  const panelWide = useChat((s) => s.panelWide);
  const togglePanelWide = useChat((s) => s.togglePanelWide);
  const loadMoreGitGraph = useChat((s) => s.loadMoreGitGraph);
  const gitGraphAtEnd = useChat((s) => s.gitGraphAtEnd);
  const gitGraphLoadingMore = useChat((s) => s.gitGraphLoadingMore);

  // 虚拟滚动:量出滚动容器的位置/高度,只画看得见的那几行(几千行时 DOM 才不炸)
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  // 半屏/全屏切换、窗口缩放都会改视口高:量一次不够,得跟着变
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    // 滚近底部就去要下一页;到底/在拉时 store 侧是空操作,这里不重复判断
    if (nearBottom(el.scrollTop, el.clientHeight, el.scrollHeight)) void loadMoreGitGraph();
  };

  // 当前分支名 = HEAD ref(detached 时 parseRefs 给 "HEAD")。对话中 agent 切/并分支,
  // tool_result 触发 store 静默重拉,这里跟着新数据自动换
  const headBranch = gitGraph?.ok
    ? gitGraph.commits.flatMap((c) => c.refs).find((r) => r.type === "head")?.name ?? null
    : null;

  return (
    <main className="flex-1 min-w-0 flex flex-col">
      {/* 窄面板(半屏 + 窄窗口)下头部的取舍:控件永远在,文字先让位。
          flex 里 truncate 必须配 min-w-0——否则 min-width:auto 让它按内容宽度
          顶住不缩,把右边的按钮整排挤出可视区(面板本身裁掉溢出,于是关闭钮
          直接消失,只剩 Esc 能退出)。按钮组 shrink-0 是同一条约束的另一端 */}
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        {/* 全屏时本面板独占内容区,侧栏的重开钮没有别的落点——排进这排最左 */}
        {panelWide && <SidebarNub />}
        <span className="shrink-0 whitespace-nowrap font-[650] text-sm">Git Graph</span>
        {headBranch && (
          <span className="inline-flex min-w-0 max-w-[40%] items-center gap-1 rounded bg-brand/15 px-[6px] py-px font-mono text-[11px] text-brand" title={headBranch}>
            <GitBranch className="w-3 h-3 shrink-0" />
            <span className="truncate">{headBranch}</span>
          </span>
        )}
        <span className="min-w-0 flex-1 font-mono text-xs text-muted-foreground truncate" title={gitGraphRepo ?? undefined}>
          {gitGraphRepo ?? "(无会话工作区)"}
        </span>
        <div className="flex shrink-0 items-center">
          <Button variant="ghost" size="sm" onClick={() => void refreshGitGraph()} title="重新拉取">
            <RefreshCw />
          </Button>
          {/* 半屏/全屏切换:面板默认半屏叠在会话旁,要沉浸再撑满 */}
          <Button variant="ghost" size="sm" onClick={togglePanelWide} title={panelWide ? "收回半屏" : "展开全屏"}>
            {panelWide ? <Minimize2 /> : <Maximize2 />}
          </Button>
          <Button variant="ghost" size="sm" onClick={closeGitGraph} title="关闭">
            <X />
          </Button>
        </div>
      </header>

      {/* 同 ProtocolView:版式按面板自身宽度决定(容器查询)。窄于 560px 时
          "泳道图 + 320px 详情"并排会把图挤成一条线,改成详情整栏覆盖 + 返回钮 */}
      <div className="@container flex-1 min-h-0 flex">
        {/* 只竖滚:泳道 SVG 定宽 + 主题行 truncate,横向内容截断不出滚动条 */}
        <div
          ref={scrollRef}
          className={
            "flex-1 min-w-0 overflow-y-auto overflow-x-hidden" +
            (gitCommitView ? " hidden @[560px]:block" : "")
          }
          onScroll={onScroll}
        >
          {gitGraphRepo === null ? (
            // 没有工作区就没有仓库可读,store 压根不会去拉——不给空态就永远转骨架屏
            <p className="px-4 py-6 text-sm text-muted-foreground">
              这个会话没有工作区，没有仓库可看。在新会话里选一个目录，或打开一个带工作区的会话。
            </p>
          ) : gitGraph === null ? (
            <div className="grid gap-2 p-4">
              <Skeleton className="h-6" /><Skeleton className="h-6" /><Skeleton className="h-6" />
            </div>
          ) : !gitGraph.ok ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              <p>{ERROR_GUIDE[gitGraph.kind]}</p>
              <p className="mt-2 font-mono text-xs opacity-70 break-all">{gitGraph.detail}</p>
            </div>
          ) : gitGraph.commits.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">还没有 commit。</p>
          ) : (
            <>
              <GraphRows
                commits={gitGraph.commits}
                head={gitGraph.head}
                spineBranch={gitGraph.spineBranch}
                selected={gitCommitView?.hash ?? null}
                scrollTop={scrollTop}
                viewportH={viewportH}
                onPick={(h) => (gitCommitView?.hash === h ? closeGitCommit() : void openGitCommit(h))}
              />
              {/* 列表脚:加载中/到底了都说一声,别让人对着停住的滚动条猜 */}
              <p className="px-4 py-3 text-center text-xs text-muted-foreground">
                {gitGraphLoadingMore ? "加载更多…" : gitGraphAtEnd ? `到头了 · 共 ${gitGraph.commits.length} 条` : "继续下滑加载更多"}
              </p>
            </>
          )}
        </div>

        {gitCommitView && (
          <aside className="flex min-w-0 flex-1 flex-col border-l border-border @[560px]:w-[320px] @[560px]:flex-none @[560px]:shrink-0">
            {/* 返回钮只在窄面板出现:宽面板下泳道图就在左边,退回去这个动作不存在 */}
            <div className="@[560px]:hidden shrink-0 border-b border-border px-1 py-1">
              <Button variant="ghost" size="sm" onClick={closeGitCommit}>
                <ChevronLeft /> 返回图谱
              </Button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
              <CommitDetailPane />
            </div>
          </aside>
        )}
      </div>
    </main>
  );
}

function GraphRows({ commits, head, spineBranch, selected, scrollTop, viewportH, onPick }: {
  commits: RawCommit[];
  head: string | null;
  /** 钉在 0 道的主干分支名（null = 不预留,泳道全靠回收） */
  spineBranch: string | null;
  selected: string | null;
  /** 滚动容器量出来的位置/高度:决定这一帧画哪几行 */
  scrollTop: number;
  viewportH: number;
  onPick: (hash: string) => void;
}) {
  // 直播流每 token 触发 store set,不 memo 会按流频率重算泳道。
  // 泳道对「已加载的全量」算(每行的道依赖它前面所有行),窗口只裁渲染,不裁计算
  const rows = useMemo(() => assignLanes(commits, spineBranch), [commits, spineBranch]);
  const maxLane = Math.max(...rows.map((r) => Math.max(r.lane, ...r.edges.map((e) => Math.max(e.fromLane, e.toLane)))));
  const svgW = (maxLane + 1) * LANE_W;
  const { first, last } = visibleRange(scrollTop, viewportH, ROW_H, commits.length);
  // 每次渲染取一次"现在"：滚动、刷新、开关详情都会重渲染，相对时间跟着走。
  // 不挂定时器——为了让「3 分钟前」变成「4 分钟前」每分钟重画整个列表不划算
  const now = Math.floor(Date.now() / 1000);

  return (
    // 外层撑满全高(滚动条长度诚实反映总量),行绝对定位到自己的 y——
    // 只有窗口内的行进 DOM
    <div className="relative" style={{ height: commits.length * ROW_H }}>
      {commits.slice(first, last).map((c, k) => {
        const i = first + k;
        const row = rows[i]!; // assignLanes 逐 commit 生成一行,长度与 commits 严格一致
        return (
          <button
            key={c.hash}
            // HEAD 行常亮:品牌底 + 左缘 3px 指示条(inset shadow,不占布局不歪泳道);点选态(bg-accent)优先级更高
            className={`absolute inset-x-0 flex items-center gap-2 text-left hover:bg-accent ${selected === c.hash ? "bg-accent" : c.hash === head ? "bg-brand/[0.16] shadow-[inset_3px_0_0_0_var(--brand)]" : ""}`}
            style={{ height: ROW_H, top: i * ROW_H }}
            onClick={() => onPick(c.hash)}
          >
            {/* overflow visible:行间连线要越过本行边界画到下一行中心 */}
            <svg width={svgW} height={ROW_H} className="shrink-0 overflow-visible">
              {row.edges.map((e, k) => (
                <path key={k} d={edgePath(e.fromLane, e.toLane)} fill="none" strokeWidth={2}
                  stroke={laneColor(e.toLane)} />
              ))}
              <circle cx={row.lane * LANE_W + LANE_W / 2} cy={ROW_H / 2}
                r={c.hash === head ? DOT_R + 1.5 : DOT_R}
                fill={laneColor(row.lane)} />
            </svg>
            {c.refs.map((r) => <RefBadge key={`${r.type}:${r.name}`} r={r} />)}
            <span className="flex-1 min-w-0 truncate text-sm">{c.subject}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{c.author}</span>
            <span
              className="shrink-0 pr-3 text-xs text-muted-foreground font-mono"
              title={new Date(c.timestamp * 1000).toLocaleString()}
            >
              {formatRelativeTime(c.timestamp, now)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function CommitDetailPane() {
  const view = useChat((s) => s.gitCommitView);
  const openGitCommit = useChat((s) => s.openGitCommit);
  const closeGitCommit = useChat((s) => s.closeGitCommit);
  if (!view) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{view.hash.slice(0, 8)}</span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={closeGitCommit} title="关闭详情">
          <X />
        </Button>
      </div>
      {view.result === null ? (
        <div className="grid gap-2"><Skeleton className="h-5" /><Skeleton className="h-14" /></div>
      ) : !view.result.ok ? (
        <div className="text-sm text-muted-foreground">
          <p>拉取详情失败。</p>
          <p className="mt-1 font-mono text-xs opacity-70 break-all">{view.result.detail}</p>
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => void openGitCommit(view.hash)}>
            重试
          </Button>
        </div>
      ) : (
        <>
          <pre className="whitespace-pre-wrap break-words text-sm font-sans">{view.result.detail.body}</pre>
          <div className="text-xs text-muted-foreground">
            {view.result.detail.author} &lt;{view.result.detail.email}&gt;
            <br />
            {new Date(view.result.detail.timestamp * 1000).toLocaleString()}
          </div>
          <div className="grid gap-1">
            {view.result.detail.files.map((f) => (
              <div key={f.file} className="flex items-center gap-2 text-xs">
                <span className="flex-1 min-w-0 truncate font-mono" title={f.renamedFrom ? `${f.renamedFrom} → ${f.file}` : f.file}>
                  {f.renamedFrom && <span className="text-muted-foreground">{f.renamedFrom} → </span>}
                  {f.file}
                </span>
                {f.insertions === null ? (
                  <span className="shrink-0 text-muted-foreground">binary</span>
                ) : (
                  <span className="shrink-0">
                    <em className="not-italic text-ok">+{f.insertions}</em>{" "}
                    <em className="not-italic text-err">−{f.deletions}</em>
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
