// WorkspaceUsageTab —— 工作区设置页「用量」tab：每只 agent 本周烧了多少（#946，
// spec §7）。数据每次打开 tab 现拉一次（loadWorkspaceUsage），不进 store——这张表
// 只在看的时候有意义，缓存一份等于多一处会陈旧的额度数。
// 「拿不到」≠「没花」：请求失败画错误行，不画一张全零的表。

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useChat } from "../store.js";
import { usageEmptyText, usageRows, usageTotalText, usageWindowText } from "../lib/workspaceUsageView.js";
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
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-2">
        <span className={SECTION_LABEL}>本周 · {usageWindowText(state.usage)} · 记在所有者的额度上</span>
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>刷新</Button>
      </div>
      {rows.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground">{usageEmptyText(route)}</p>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((r) => (
            <div key={r.agentId} className={cn(ROW, "border border-border")}>
              <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
              <span className="shrink-0 text-muted-foreground">{r.calls} 次 · {r.tokens} token</span>
              <span className="w-[90px] shrink-0 text-right tabular-nums">{r.credit}</span>
            </div>
          ))}
          <div className={cn(ROW, "justify-end text-muted-foreground")}>合计 {usageTotalText(state.usage)}</div>
        </div>
      )}
    </div>
  );
}
