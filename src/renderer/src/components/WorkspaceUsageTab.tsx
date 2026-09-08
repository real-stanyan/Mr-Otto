// WorkspaceUsageTab —— 工作区设置页「用量」那一页：每只 agent 本周占了所有者额度的
// 百分之几（#946 起，#1120 换掉了单位）。数据每次打开现拉一次（loadWorkspaceUsage），
// 不进 store——这张表只在看的时候有意义，缓存一份等于多一处会陈旧的额度数。
// 「拿不到」≠「没花」：请求失败画错误行，不画一张全零的表。
//
// **整页一个 credit 都不出现**，为什么见 `lib/workspaceUsageView.ts` 头注。

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useChat } from "../store.js";
import {
  usageEmptyText, usageHeadline, usageRows, usageScale, usageScaleNote, usageWindowText,
} from "../lib/workspaceUsageView.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { WorkspaceUsage } from "../../../shared/billing.js";

const SECTION_LABEL = "text-[11px] tracking-[0.06em] text-muted-foreground uppercase";
const ROW = "flex items-center gap-2 px-2 py-[6px] rounded-md text-xs";

export function WorkspaceUsageTab({ ws }: { ws: WorkspaceSnapshot }) {
  const load = useChat((s) => s.loadWorkspaceUsage);
  // 只有此刻正 join 着**这个**工作区的云会话才知道 route 走的是哪条——不是
  // 这个工作区的云会话（或压根没开着云会话）时退回 null，空态文案照旧文案说
  const route = useChat((s) => (s.cloudSession?.workspaceId === ws.id ? s.cloudSession.modelRoute : null));
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; message: string } | { kind: "ok"; usage: WorkspaceUsage }>({ kind: "loading" });

  const refresh = async (): Promise<void> => {
    setState({ kind: "loading" });
    const r = await load(ws.id);
    setState(r.ok ? { kind: "ok", usage: r.value } : { kind: "error", message: r.message });
  };

  // ws.id 变化才重拉；load 是 store 里的稳定引用，跟着它一起标依赖只会造成无意义的重跑
  useEffect(() => { void refresh(); }, [ws.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.kind === "loading") return <p className="px-2 text-xs text-muted-foreground">正在算本周的账…</p>;
  if (state.kind === "error") {
    return (
      <div className="flex flex-col gap-2">
        <p className="px-2 text-xs text-err">拿不到用量：{state.message}</p>
        <div><Button size="sm" variant="ghost" onClick={() => void refresh()}>再试一次</Button></div>
      </div>
    );
  }
  const rows = usageRows(ws, state.usage);
  const head = usageHeadline(state.usage);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-2">
        <span className={SECTION_LABEL}>本周 · {usageWindowText(state.usage)}</span>
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>刷新</Button>
      </div>

      {/* 页顶那一格。`percent` 为 null = 分母缺席，那时只报次数——拿工作区合计
          当分母硬报一个 100% 什么都没说 */}
      <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[26px] leading-none font-semibold tracking-[-0.02em] tabular-nums">
            {head.percent ?? head.calls}
          </span>
          <span className="text-[12px] text-muted-foreground">
            {head.percent !== null ? `· 占所有者本周额度 · ${head.calls} 次调用` : "次调用"}
          </span>
        </div>
        {head.fill !== null && (
          <div className="h-[5px] overflow-hidden rounded-full bg-foreground/10">
            {/* 一律中性灰：这一页上的颜色留给「出事了」（同 ADR-0239 主条的处置） */}
            <div className="h-full rounded-full bg-muted-foreground/70" style={{ width: `${Math.max(head.fill * 100, 0.8)}%` }} />
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">记在所有者的额度上</p>
      </div>

      {rows.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground">{usageEmptyText(route)}</p>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((r) => (
            <div key={r.agentId} className={cn(ROW, "items-start border border-border")}>
              {r.avatarSrc !== null ? (
                <img src={r.avatarSrc} alt="" aria-hidden className="mt-[1px] size-7 shrink-0 rounded-full" />
              ) : (
                /* 名单里查不到的那两档（已删除 / 未归因）：对齐同一列，但不给脸 */
                <span
                  aria-hidden
                  className="mt-[1px] grid size-7 shrink-0 place-items-center rounded-full bg-foreground/10 text-[11px] text-muted-foreground"
                >
                  —
                </span>
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="min-w-0 truncate font-medium">{r.name}</span>
                <span className="text-[10.5px] text-muted-foreground tabular-nums">{r.calls} 次 · {r.tokens} token</span>
                <span className="h-[3px] overflow-hidden rounded-full bg-foreground/10">
                  <span className="block h-full rounded-full bg-muted-foreground/55" style={{ width: `${(r.share * 100).toFixed(1)}%` }} />
                </span>
              </span>
              <span className="w-[56px] shrink-0 text-right tabular-nums">{r.percent}</span>
            </div>
          ))}
          <p className="px-2 pt-1 text-[10.5px] text-muted-foreground">{usageScaleNote(usageScale(state.usage))}</p>
        </div>
      )}
    </div>
  );
}
