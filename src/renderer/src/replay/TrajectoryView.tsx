// 轨迹视图（deepseek-harness 风格）：泳道时间轴 + 一步一行的列表 + 右侧详情面板。
// 全部只读：主进程和 agent 对它毫不知情——纯渲染层投影（buildTrajectory）。
// 选中哪一行是视图自己的瞬态状态，不进 store：换会话 / 离开视图即作废，没人需要恢复它。

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Search, X } from "lucide-react";
import { useChat } from "../store.js";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable.js";
import { Hl } from "./HlText.js";
import { toolSchema } from "./toolSchemas.js";
import {
  buildTrajectory,
  formatMs,
  formatTs,
  rowExtent,
  rowMatches,
  rowSpans,
  toolDurationMs,
  type Lane,
  type RowKind,
  type Scale,
  type TrajRow,
  type Trajectory as Traj,
} from "./trajectory.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { Input } from "@/components/ui/input.js";

/* 三类角色三种色：input 绿 / model 紫 / tools 橙（对齐 deepseek-harness 的泳道配色）。
   system 行归 input 道但灰显——它们不是人说的话 */
const LANE_BG: Record<Lane, string> = {
  input: "bg-emerald-500",
  model: "bg-violet-500",
  tools: "bg-amber-500",
};
const KIND_TAG: Record<RowKind, { label: string; cls: string }> = {
  user: { label: "USER", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  assistant: { label: "ASSISTANT", cls: "bg-violet-500/15 text-violet-600 dark:text-violet-400" },
  tool: { label: "TOOL", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  system: { label: "SYSTEM", cls: "bg-foreground/[0.06] text-muted-foreground" },
};
const LANES: { lane: Lane; label: string }[] = [
  { lane: "input", label: "Input" },
  { lane: "model", label: "Model" },
  { lane: "tools", label: "Tools" },
];
const SCALES: { scale: Scale; label: string }[] = [
  { scale: "duration", label: "Duration" },
  { scale: "turns", label: "Turns" },
  { scale: "calls", label: "Calls" },
];

const PRE =
  "hl font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap break-all text-[var(--hl-string)] bg-[var(--pre-bg)] rounded-lg px-3 py-[10px] overflow-x-auto";
const SEC_H = "text-[11px] text-muted-foreground font-semibold tracking-[0.05em] mt-4 mb-[6px] first:mt-0";
const KV = "grid grid-cols-[96px_1fr] gap-y-[6px] text-[12.5px] items-baseline";
const KV_K = "text-muted-foreground";

const json = (v: unknown): string => JSON.stringify(v, null, 2) ?? "undefined";

/** 工具行的状态：结果落了看 status；没结果看走到了哪一步 */
function toolStatus(row: TrajRow): string {
  if (row.result) return row.result.status === "ok" ? "Completed" : row.result.status === "denied" ? "Denied" : "Error";
  if (row.started) return "Running";
  if (row.approval) return row.approval.decision === "approved" ? "Approved" : "Denied";
  return "Pending";
}

/* ─── 列表 / 详情的分栏 ─── */

/**
 * 980px 是这块从左右布局翻成上下布局的分界。原来只有 CSS 变体（max-[980px]:）
 * 知道它，现在拖拽方向、默认占比、存哪个 autoSaveId 都要跟着翻，JS 也得知道。
 */
const STACK_MQ = "(max-width: 980px)";
const subscribeStack = (cb: () => void) => {
  const mq = window.matchMedia(STACK_MQ);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const getStack = () => window.matchMedia(STACK_MQ).matches;
function useStacked(): boolean {
  return useSyncExternalStore(subscribeStack, getStack);
}

/* ─── 泳道时间轴 ─── */

/** 可见窗口 ∈ [0,1]。滚轮围绕鼠标位置缩放（最小 2%），Shift+滚轮 / 横向滚轮平移，双击复位 */
type Window = { v0: number; v1: number };
const FULL: Window = { v0: 0, v1: 1 };
const MIN_W = 0.02;

function zoomAt(w: Window, anchor: number, factor: number): Window {
  const width = Math.max(MIN_W, Math.min(1, (w.v1 - w.v0) * factor));
  const a = w.v0 + anchor * (w.v1 - w.v0); // 鼠标下的那个点缩放前后不动
  let v0 = a - anchor * width;
  v0 = Math.max(0, Math.min(1 - width, v0));
  return { v0, v1: v0 + width };
}
function panBy(w: Window, dx: number): Window {
  const width = w.v1 - w.v0;
  const v0 = Math.max(0, Math.min(1 - width, w.v0 + dx));
  return { v0, v1: v0 + width };
}

function Swimlanes({
  traj, scale, query, selected, onSelect,
}: {
  traj: Traj; scale: Scale; query: string; selected: string | null; onSelect: (key: string) => void;
}) {
  const [win, setWin] = useState<Window>(FULL);
  const trackRef = useRef<HTMLDivElement>(null);
  // 画布 = 轨道去掉左右天沟的那块。所有 ∈[0,1] 的坐标换算都认画布，不认轨道
  const canvasRef = useRef<HTMLDivElement>(null);
  const spans = useMemo(() => rowSpans(traj), [traj]);
  const extents = useMemo(
    () => traj.rows.map((r, i) => rowExtent(r, traj, scale, i, spans)),
    [traj, scale, spans]
  );
  // 换刻度 / 换会话 → 窗口复位：旧窗口在新坐标系里没有意义
  useEffect(() => setWin(FULL), [scale, traj]);

  // React 的 onWheel 是 passive 的，preventDefault 无效 → 原生监听，拦住页面滚动
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = (canvasRef.current ?? el).getBoundingClientRect();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = (e.shiftKey ? e.deltaY : e.deltaX) / rect.width;
        setWin((w) => panBy(w, d * (w.v1 - w.v0)));
      } else {
        const anchor = (e.clientX - rect.left) / rect.width;
        setWin((w) => zoomAt(w, anchor, Math.exp(e.deltaY * 0.002)));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const scaleX = 1 / (win.v1 - win.v0);
  const zoomed = win.v1 - win.v0 < 0.999;

  // 边缘悬停自动平移：放大后鼠标停在轨道左/右 48px 内，窗口朝那边滑，
  // 越贴边越快（二次方缓入，边缘中段几乎不动，不会一碰就飞）。rAF 驱动，离开即停
  const hoverX = useRef<number | null>(null);
  const zoomedRef = useRef(zoomed);
  zoomedRef.current = zoomed;
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const EDGE = 48;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const el = canvasRef.current ?? trackRef.current;
      const x = hoverX.current;
      if (!el || x === null || !zoomedRef.current) { last = now; return; }
      const dt = last ? Math.min(50, now - last) : 0;
      last = now;
      const w = el.clientWidth;
      let dir = 0;
      if (x < EDGE) dir = -(((EDGE - x) / EDGE) ** 2);
      else if (x > w - EDGE) dir = ((x - (w - EDGE)) / EDGE) ** 2;
      if (dir === 0) return;
      // 速度：贴死边缘时每秒滑过 1.2 个可见窗口
      setWin((cur) => panBy(cur, dir * 1.2 * (cur.v1 - cur.v0) * (dt / 1000)));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="shrink-0 border-b border-border px-3 py-2 grid grid-cols-[44px_1fr] gap-x-2">
      <div className="flex flex-col justify-around text-[10px] text-muted-foreground text-right leading-none">
        {LANES.map((l) => <span key={l.lane}>{l.label}</span>)}
      </div>
      {/* 外层裁切，内层按窗口放大 + 平移；块是区间（起点→终点），三道互斥接续 */}
      <div
        ref={trackRef}
        className="relative h-[54px] overflow-hidden cursor-ew-resize select-none"
        onDoubleClick={() => setWin(FULL)}
        onMouseMove={(e) => { hoverX.current = e.clientX - (canvasRef.current ?? e.currentTarget).getBoundingClientRect().left; }}
        onMouseLeave={() => { hoverX.current = null; }}
        title={zoomed ? "滚轮缩放 · Shift+滚轮平移 · 双击复位" : "滚轮缩放"}
      >
        {/* 左右各留 4px 天沟：首尾两块贴死边时，选中环（ring 2px + ring-offset 1px）
            会被上面那层 overflow-hidden 切掉，最后一条轨迹看着像残的 */}
        <div ref={canvasRef} className="absolute inset-y-0 left-1 right-1">
          <div
            className="absolute inset-y-0"
            style={{ left: `${-win.v0 * scaleX * 100}%`, width: `${scaleX * 100}%` }}
          >
            {LANES.map((l, li) => (
              <div key={l.lane} className="absolute inset-x-0 h-[14px]" style={{ top: li * 18 + 2 }}>
                {traj.rows.map((r, i) => {
                  if (r.lane !== l.lane) return null;
                  const [x0, x1] = extents[i]!;
                  const hit = rowMatches(r, query);
                  const cur = r.key === selected;
                  return (
                    <button
                      key={r.key}
                      title={`Turn ${r.turn} · Step ${r.step} · ${r.summary}`}
                      onClick={() => onSelect(r.key)}
                      className={
                        "absolute top-[2px] h-[10px] min-w-[3px] rounded-[2px] border-none p-0 cursor-pointer transition-opacity " +
                        (r.deny ? "bg-deny" : r.kind === "system" ? "bg-muted-foreground/50" : LANE_BG[l.lane]) +
                        (hit ? "" : " opacity-20") +
                        (cur ? " ring-2 ring-foreground ring-offset-1 ring-offset-background z-10" : "")
                      }
                      style={{ left: `${x0 * 100}%`, width: `calc(${(x1 - x0) * 100}% - 1px)` }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        {zoomed && (
          <span className="absolute right-1 bottom-0 text-[9px] font-mono text-muted-foreground tabular-nums pointer-events-none">
            {Math.round(scaleX * 10) / 10}×
          </span>
        )}
      </div>
    </div>
  );
}

/* ─── 详情面板 ─── */

/** 「回到这一步」（issue #395 / ADR-0089）：fork 会话（零拷贝）+ 文件 reset
    回检查点，成功后直接切进新分支会话。破坏性动作走 confirm（同删除会话的模式） */
function RewindButton({ checkpointId, seq }: { checkpointId: string; seq: number }) {
  const sessionId = useChat((s) => s.sessionId);
  const resume = useChat((s) => s.resume);
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      className="mt-4 w-full text-[12.5px] px-3 py-[7px] rounded-lg border border-border bg-foreground/[0.04] hover:bg-foreground/[0.08] transition-colors disabled:opacity-50 disabled:cursor-wait"
      onClick={async () => {
        if (
          !confirm(
            `回到这一步？\n将从这里分叉出一个新会话（原会话原样保留），并把工作区文件恢复到检查点 ${checkpointId.slice(0, 8)} 时刻。\n此后对存过档文件的改动会被覆盖；从未进过检查点的新文件保留。`
          )
        )
          return;
        setBusy(true);
        try {
          const newId = await window.otter.rewindToCheckpoint(sessionId, seq);
          await resume(newId);
        } catch (err) {
          alert(`回退失败：${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "回退中…" : "⤺ 回到这一步（分叉会话 + 恢复文件）"}
    </button>
  );
}

function Detail({ row, onClose }: { row: TrajRow; onClose: () => void }) {
  const ev = row.ev;
  const tag = KIND_TAG[row.kind];
  const usage =
    ev.type === "assistant_message" || ev.type === "context_compacted" || ev.type === "micro_compacted"
      ? ev.usage
      : undefined;
  const dur = row.kind === "tool" ? toolDurationMs(row) : null;

  const payload: string =
    row.kind === "tool" ? json(row.call!.args)
    : ev.type === "assistant_message" ? (ev.content || "(no content)") + (ev.reasoning ? `\n\n--- reasoning ---\n${ev.reasoning}` : "")
    : ev.type === "user_message" ? ev.content
    : ev.type === "skill_invoked" ? ev.content
    : json(ev);
  const result: string | null =
    row.kind === "tool" ? (row.result ? row.result.output || "(empty)" : null)
    : ev.type === "context_compacted" ? ev.summary
    // 微压缩（ADR-0064）同 context_compacted：这条事件的载荷就是那段摘要，
    // 详情面板不给出来的话，用户在轨迹里只看得到"发生过一次微压缩"、看不到摘了什么
    : ev.type === "micro_compacted" ? ev.summary
    : null;
  const schema = row.kind === "tool" ? toolSchema(row.call!.name) : undefined;

  const status =
    row.kind === "tool" ? toolStatus(row)
    : ev.type === "turn_ended" ? ev.outcome
    : "Completed";

  // 尺寸交给外面的 ResizablePanel（可拖、按 autoSaveId 记住），分隔线就是那根手柄，
  // 所以这里不自带宽度也不自带边框——自带的话会和手柄叠成两条线
  return (
    <aside className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-4 py-[10px] border-b border-border">
        <span className={`text-[10px] font-semibold tracking-[0.06em] px-[6px] py-[2px] rounded ${tag.cls}`}>{tag.label}</span>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          Turn {row.turn} · Step {row.step}
        </span>
        <button className="ml-auto p-1 rounded hover:bg-foreground/5 text-muted-foreground" onClick={onClose} title="关闭">
          <X className="w-[14px] h-[14px]" />
        </button>
      </div>
      {/* key=row.key：换行时 tab 回到 Summary——看新的一步默认从概览起 */}
      <Tabs key={row.key} defaultValue="summary" className="flex-1 min-h-0 gap-0">
        <TabsList variant="line" className="px-4 pt-1 border-b border-border w-full justify-start rounded-none h-9">
          {["summary", "payload", "result", "schema", "timing"].map((t) => (
            <TabsTrigger key={t} value={t} className="flex-none text-xs capitalize px-2">{t}</TabsTrigger>
          ))}
        </TabsList>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
          <TabsContent value="summary">
            <div className={KV}>
              <span className={KV_K}>Hierarchy</span>
              <span>{row.kind === "tool" ? `Assistant Message › ${row.call!.name}` : tag.label}</span>
              <span className={KV_K}>Status</span>
              <span className={row.deny ? "text-deny" : ""}>{status}</span>
              <span className={KV_K}>Seq</span>
              <span className="font-mono tabular-nums">{row.seq}</span>
              {ev.type === "assistant_message" && (<><span className={KV_K}>Model</span><span className="font-mono">{ev.model}</span></>)}
              {usage && (
                <>
                  <span className={KV_K}>Tokens</span>
                  <span className="font-mono tabular-nums">{usage.promptTokens} in · {usage.completionTokens} out</span>
                </>
              )}
              {row.approval && (
                <>
                  <span className={KV_K}>Approval</span>
                  <span>{row.approval.decision}{row.approval.reason ? ` — ${row.approval.reason}` : ""}</span>
                </>
              )}
            </div>
            <h4 className={SEC_H}>Payload</h4>
            <pre className={PRE}><Hl src={payload.length > 600 ? payload.slice(0, 600) + `…（共 ${payload.length} 字符）` : payload} /></pre>
            {result !== null && (
              <>
                <h4 className={SEC_H}>Result</h4>
                <pre className={PRE}>{result.length > 600 ? result.slice(0, 600) + `…（共 ${result.length} 字符）` : result}</pre>
              </>
            )}
            <h4 className={SEC_H}>Timing</h4>
            <div className={KV}>
              <span className={KV_K}>Started</span>
              <span className="font-mono tabular-nums">{formatTs(row.started?.ts ?? row.ts)}</span>
              {dur !== null && (<><span className={KV_K}>Duration</span><span className="font-mono tabular-nums">{formatMs(dur)}</span></>)}
            </div>
            {ev.type === "checkpoint_created" && (
              <RewindButton checkpointId={ev.checkpointId} seq={ev.seq} />
            )}
          </TabsContent>

          <TabsContent value="payload">
            <pre className={PRE}><Hl src={payload} /></pre>
          </TabsContent>

          <TabsContent value="result">
            {result !== null
              ? <pre className={PRE}>{result}</pre>
              : <div className="text-[12.5px] text-muted-foreground">No result for this step.</div>}
          </TabsContent>

          <TabsContent value="schema">
            {schema
              ? (
                <>
                  <div className="text-[12.5px] mb-2">{schema.description}</div>
                  <pre className={PRE}><Hl src={json(schema.parameters)} /></pre>
                </>
              )
              : <div className="text-[12.5px] text-muted-foreground">Schema unavailable</div>}
          </TabsContent>

          <TabsContent value="timing">
            <div className={KV}>
              <span className={KV_K}>Requested</span>
              <span className="font-mono tabular-nums">{formatTs(row.ts)}</span>
              {row.approval && (<><span className={KV_K}>Approved</span><span className="font-mono tabular-nums">{formatTs(row.approval.ts)}</span></>)}
              {row.started && (<><span className={KV_K}>Started</span><span className="font-mono tabular-nums">{formatTs(row.started.ts)}</span></>)}
              {row.result && (<><span className={KV_K}>Finished</span><span className="font-mono tabular-nums">{formatTs(row.result.ts)}</span></>)}
              <span className={KV_K}>Duration</span>
              <span className="font-mono tabular-nums">
                {dur !== null ? formatMs(dur)
                  : ev.type === "assistant_message" && ev.reasoningMs !== undefined ? `${formatMs(ev.reasoningMs)} (reasoning)`
                  : "—"}
              </span>
              <span className={KV_K}>Timing source</span>
              <span>Session timestamps</span>
            </div>
            {row.kind === "tool" && dur === null && (
              <div className="text-[11.5px] text-muted-foreground mt-3 leading-relaxed">
                耗时 = tool_result.ts − tool_execution_started.ts（审批等待不计）。本步缺其一，不编数。
              </div>
            )}
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}

/* ─── 视图 ─── */

export function TrajectoryView() {
  const events = useChat((s) => s.events);
  const traj = useMemo(() => buildTrajectory(events), [events]);
  const [scale, setScale] = useState<Scale>("duration");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const stacked = useStacked();
  const selRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => traj.rows.filter((r) => rowMatches(r, query)), [traj, query]);
  const row = selected === null ? null : traj.rows.find((r) => r.key === selected) ?? null;

  // 选中行随点击滚进视野（键盘上下移动也经这里）
  useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const move = (d: 1 | -1) => {
    if (!visible.length) return;
    const i = visible.findIndex((r) => r.key === selected);
    const next = visible[Math.min(visible.length - 1, Math.max(0, (i < 0 ? (d > 0 ? -1 : visible.length) : i) + d))];
    if (next) setSelected(next.key);
  };

  return (
    <section
      className="flex-1 min-h-0 flex flex-col outline-none"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); move(1); }
        else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); move(-1); }
        else if (e.key === "Escape") setSelected(null);
      }}
    >
      {/* 工具条：刻度切换 + 搜索 */}
      <div className="shrink-0 flex items-center gap-1 px-3 py-[6px] border-b border-border">
        {SCALES.map((s) => (
          <button
            key={s.scale}
            onClick={() => setScale(s.scale)}
            className={
              "text-xs px-2 py-1 rounded-md transition-colors " +
              (scale === s.scale ? "bg-foreground/[0.08] text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-foreground/5")
            }
          >
            {s.label}
          </button>
        ))}
        <span className="ml-2 font-mono text-[11px] text-muted-foreground tabular-nums">
          {traj.turns} turns · {traj.rows.length} steps
        </span>
        <div className="ml-auto relative w-[220px]">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-[13px] h-[13px] text-muted-foreground pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索"
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>

      <Swimlanes traj={traj} scale={scale} query={query} selected={selected} onSelect={setSelected} />

      {/* 左右 / 上下都可拖：direction 跟着 980px 断点翻，两个方向各存各的
          autoSaveId（同一个 id 存百分比，横竖混用会互相污染）。
          key 强制换向时重挂——PanelGroup 的 direction 不是可热切的 */}
      <ResizablePanelGroup
        key={stacked ? "stacked" : "side"}
        direction={stacked ? "vertical" : "horizontal"}
        autoSaveId={stacked ? "otter-trajectory-stacked" : "otter-trajectory-side"}
        className="flex-1 min-h-0"
      >
        <ResizablePanel id="list" order={1} defaultSize={stacked ? 50 : 66} minSize={20} className="min-h-0 min-w-0">
          <div className="h-full overflow-y-auto">
            {visible.length === 0 && (
              <div className="text-[13px] text-muted-foreground p-4">
                {traj.rows.length === 0 ? "这个会话还没有任何一步。" : "没有匹配的步骤。"}
              </div>
            )}
            {visible.map((r) => {
              const cur = r.key === selected;
              const tag = KIND_TAG[r.kind];
              return (
                <div
                  key={r.key}
                  ref={cur ? selRef : null}
                  onClick={() => setSelected(r.key)}
                  className={
                    "grid grid-cols-[88px_1fr] items-center gap-3 px-3 py-[7px] border-b border-border/50 cursor-pointer font-mono text-[12.5px] " +
                    (cur
                      ? r.deny ? "bg-deny/10 shadow-[inset_2px_0_0_var(--color-deny)]" : "bg-foreground/[0.06] shadow-[inset_2px_0_0_var(--color-brand)]"
                      : "hover:bg-foreground/[0.03]")
                  }
                >
                  <span className={`justify-self-end text-[10px] font-semibold tracking-[0.06em] px-[6px] py-[2px] rounded ${tag.cls}`}>
                    {tag.label}
                  </span>
                  <span className={"truncate " + (r.deny ? "text-deny" : r.kind === "system" ? "text-muted-foreground" : "")} title={r.summary}>
                    {r.summary}
                  </span>
                </div>
              );
            })}
          </div>
        </ResizablePanel>
        {row && (
          <>
            {/* 不要 withHandle 那颗六点抓手：分隔线本身整条可拖（沿用侧栏面板的做法） */}
            <ResizableHandle />
            <ResizablePanel id="detail" order={2} defaultSize={stacked ? 50 : 34} minSize={20} className="min-h-0 min-w-0">
              <Detail row={row} onClose={() => setSelected(null)} />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </section>
  );
}
