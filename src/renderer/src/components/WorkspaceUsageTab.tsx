// WorkspaceUsageTab —— 工作区设置里的「用量」那一页：每只 agent 本周占了所有者额度的
// 百分之几（#946 起，#1120 换掉了单位与行的样子）。数据每次打开现拉一次
// （loadWorkspaceUsage），不进 store——这张表只在看的时候有意义，缓存一份等于多一处会
// 陈旧的额度数。「拿不到」≠「没花」：请求失败画错误行，不画一张全零的表。
//
// **整页一个 credit 都不出现**，为什么见 `lib/workspaceUsageView.ts` 头注。

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { InsetEmpty, InsetGroup, InsetLabel, InsetNote, InsetRow } from "@/components/ui/inset-list.js";
import { useChat } from "../store.js";
import {
  usageEmptyText, usageHeadline, usageRows, usageScale, usageScaleNote, usageWindowText,
} from "../lib/workspaceUsageView.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { WorkspaceUsage } from "../../../shared/billing.js";

export function WorkspaceUsageTab({ ws }: { ws: WorkspaceSnapshot }) {
  const load = useChat((s) => s.loadWorkspaceUsage);
  // 只有此刻正 join 着**这个**工作区的云会话才知道 route 走的是哪条——不是这个工作区
  // 的云会话（或压根没开着云会话）时退回 null，空态文案照旧文案说
  const route = useChat((s) => (s.cloudSession?.workspaceId === ws.id ? s.cloudSession.modelRoute : null));
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "error"; message: string } | { kind: "ok"; usage: WorkspaceUsage }
  >({ kind: "loading" });

  const refresh = async (): Promise<void> => {
    setState({ kind: "loading" });
    const r = await load(ws.id);
    setState(r.ok ? { kind: "ok", usage: r.value } : { kind: "error", message: r.message });
  };

  // ws.id 变化才重拉；load 是 store 里的稳定引用，跟着它一起标依赖只会造成无意义的重跑
  useEffect(() => { void refresh(); }, [ws.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.kind === "loading") {
    return <InsetGroup><InsetEmpty title="正在算本周的账…" /></InsetGroup>;
  }
  if (state.kind === "error") {
    return (
      <InsetGroup>
        {/* 「拿不到」不许画成一张全零的表——那两件事该做的动作相反 */}
        <InsetEmpty title="拿不到用量" hint={state.message} />
        <InsetRow title="再试一次" tone="action" onClick={() => void refresh()} />
      </InsetGroup>
    );
  }

  const rows = usageRows(ws, state.usage);
  const head = usageHeadline(state.usage);

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 pt-0">
        <InsetLabel className="pt-0">本周 · {usageWindowText(state.usage)}</InsetLabel>
        <Button size="xs" variant="ghost" className="shrink-0" onClick={() => void refresh()}>刷新</Button>
      </div>

      <InsetGroup>
        <div className="flex flex-col gap-[10px] px-[13px] py-[13px]">
          <div className="flex items-baseline gap-2">
            <span className="text-[30px] leading-none font-[640] tracking-[-0.028em] tabular-nums">
              {head.percent ?? head.calls}
            </span>
            <span className="text-[12.5px] text-muted-foreground">
              {head.percent !== null ? `· 占所有者本周额度 · ${head.calls} 次调用` : "次调用"}
            </span>
          </div>
          {/* 条一律中性灰：这一页上的颜色留给「出事了」（同 ADR-0239 对主条的处置）。
              `head.fill` 为 null = 分母缺席，那时连条都不画——没有分母就没有「占了多少」*/}
          {head.fill !== null && (
            <div className="h-[5px] overflow-hidden rounded-full bg-foreground/10">
              <div
                className="h-full rounded-full bg-muted-foreground/70"
                style={{ width: `${Math.max(head.fill * 100, 0.8).toFixed(1)}%` }}
              />
            </div>
          )}
          <p className="text-[11.5px] text-muted-foreground">记在所有者的额度上</p>
        </div>
      </InsetGroup>

      <InsetLabel>按智能体</InsetLabel>
      {rows.length === 0 ? (
        <InsetGroup><InsetEmpty title="这一周还没有花费" hint={usageEmptyText(route)} /></InsetGroup>
      ) : (
        <>
          <InsetGroup sepInset={51}>
            {rows.map((r) => (
              <InsetRow
                key={r.agentId}
                leading={
                  r.avatarSrc !== null ? (
                    <img src={r.avatarSrc} alt="" aria-hidden className="size-[27px] shrink-0 rounded-full" />
                  ) : (
                    // 名单里查不到的那两档（已删除 / 未归因）：对齐同一列，但**不给脸**
                    <span
                      aria-hidden
                      className="grid size-[27px] shrink-0 place-items-center rounded-full bg-foreground/[0.09] text-[12px] text-muted-foreground"
                    >
                      —
                    </span>
                  )
                }
                title={r.name}
                subtitle={<span className="tabular-nums">{r.calls} 次 · {r.tokens} token</span>}
                below={
                  <span className="mt-[5px] block h-[3px] overflow-hidden rounded-full bg-foreground/10">
                    <span
                      className="block h-full rounded-full bg-muted-foreground/55"
                      style={{ width: `${(r.share * 100).toFixed(1)}%` }}
                    />
                  </span>
                }
                trailing={<span className="tabular-nums text-[13px] text-foreground">{r.percent}</span>}
              />
            ))}
          </InsetGroup>
          <InsetNote>{usageScaleNote(usageScale(state.usage))}</InsetNote>
        </>
      )}
    </div>
  );
}
