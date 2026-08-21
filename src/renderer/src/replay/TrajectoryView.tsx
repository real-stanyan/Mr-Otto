// 轨迹视图（deepseek-harness 风格）：泳道时间轴 + 一步一行的列表 + 右侧详情面板。
// 全部只读：主进程和 agent 对它毫不知情——纯渲染层投影（buildTrajectory）。
// 选中哪一行是视图自己的瞬态状态，不进 store：换会话 / 离开视图即作废，没人需要恢复它。

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useChat } from "../store.js";
import { Hl } from "./HlText.js";
import { toolSchema } from "./toolSchemas.js";
import {
  buildTrajectory,
  formatMs,
  formatTs,
  rowMatches,
  rowPosition,
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

/* ─── 泳道时间轴 ─── */

function Swimlanes({
  traj, scale, query, selected, onSelect,
}: {
  traj: Traj; scale: Scale; query: string; selected: string | null; onSelect: (key: string) => void;
}) {
  return (
    <div className="shrink-0 border-b border-border px-3 py-2 grid grid-cols-[44px_1fr] gap-x-2">
      <div className="flex flex-col justify-around text-[10px] text-muted-foreground text-right leading-none">
        {LANES.map((l) => <span key={l.lane}>{l.label}</span>)}
      </div>
      {/* 每个泳道一行；方块绝对定位，横坐标由刻度决定。右侧留 10px 让最后一格不被切 */}
      <div className="relative h-[54px]">
        {LANES.map((l, li) => (
          <div key={l.lane} className="absolute inset-x-0 h-[14px] border-b border-border/40 last:border-b-0" style={{ top: li * 18 + 2 }}>
            {traj.rows.map((r, i) => {
              if (r.lane !== l.lane) return null;
              const x = rowPosition(r, traj, scale, i);
              const hit = rowMatches(r, query);
              const cur = r.key === selected;
              return (
                <button
                  key={r.key}
                  title={`Turn ${r.turn} · Step ${r.step} · ${r.summary}`}
                  onClick={() => onSelect(r.key)}
                  className={
                    "absolute top-[2px] h-[9px] w-[10px] rounded-[2px] border-none p-0 cursor-pointer transition-opacity " +
                    (r.deny ? "bg-deny" : r.kind === "system" ? "bg-muted-foreground/50" : LANE_BG[l.lane]) +
                    (hit ? "" : " opacity-20") +
                    (cur ? " ring-2 ring-foreground ring-offset-1 ring-offset-background" : "")
                  }
                  style={{ left: `calc(${x * 100}% - ${x * 10}px)` }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── 详情面板 ─── */

function Detail({ row, onClose }: { row: TrajRow; onClose: () => void }) {
  const ev = row.ev;
  const tag = KIND_TAG[row.kind];
  const usage = ev.type === "assistant_message" || ev.type === "context_compacted" ? ev.usage : undefined;
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
    : null;
  const schema = row.kind === "tool" ? toolSchema(row.call!.name) : undefined;

  const status =
    row.kind === "tool" ? toolStatus(row)
    : ev.type === "turn_ended" ? ev.outcome
    : "Completed";

  return (
    <aside className="w-[400px] shrink-0 border-l border-border flex flex-col min-h-0 max-[980px]:w-full max-[980px]:border-l-0 max-[980px]:border-t">
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

      <div className="flex-1 min-h-0 flex max-[980px]:flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto">
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
        {row && <Detail row={row} onClose={() => setSelected(null)} />}
      </div>
    </section>
  );
}
