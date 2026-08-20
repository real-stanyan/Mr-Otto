"use client";

import type { ComponentProps, ReactNode } from "react";
import { CheckIcon, PlugIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { field, inkButton, mono, paper } from "@/lib/surfaces.js";

export type ElicitationState = "request" | "accepted" | "declined";

export interface ElicitationField {
  name: string;
  label: string;
  value: string;
  kind: "text" | "choice" | "toggle";
  options?: readonly string[];
  required?: boolean;
}

export function ElicitationForm({
  server,
  message,
  fields,
  state,
  onAccept,
  onDecline,
  icon,
  headerEnd,
  actions,
  children,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  | "children"
  | "server"
  | "message"
  | "fields"
  | "state"
  | "onAccept"
  | "onDecline"
> & {
  server: string;
  /** 本仓改动:改成可省。本仓的问卷没有"一句话说明"这一层 ——
      每道题自带 header + question,再在卡顶写一句就是同一件事说两遍 */
  message?: string;
  /** 本仓改动:改成可省。原件是"MCP server 要几个字段",一屏填完;
      本仓是多步问卷(每题选项/多选/自填/可跳过),整个身子由 children 接管 */
  fields?: readonly ElicitationField[];
  onAccept?: () => void;
  onDecline?: () => void;
  state: ElicitationState;
  /** 本仓改动:图标可换。原件写死插头(=MCP),本仓没有 MCP(见 AGENTS.md 明确不做),
      插头在这里是个错信号 */
  icon?: ReactNode;
  /** 本仓改动:头部尾槽。原件那句 "needs input" 是纯状态字;
      本仓这里要放"不回答"的叉 —— 关卡片是个动作,得在手够得着的地方 */
  headerEnd?: ReactNode;
  /** 本仓改动:动作条替换,规则同 permission-grant ——
      undefined 落回自带那排,null = 这排不要(本仓的推进钮在问卷身子里),给了就整排替换 */
  actions?: ReactNode;
  /** 本仓改动:身子替换。给了 children 就不画 fields */
  children?: ReactNode;
}) {
  return (
    <div
      data-slot="elicitation-form"
      className={cn(
        paper,
        "flex w-full max-w-sm flex-col gap-3.5 rounded-[20px] p-4",
        className,
      )}

      {...props}
    >
      <div className="flex items-center gap-2.5">
        <span className="bg-foreground/[0.05] text-foreground/45 flex size-7 shrink-0 items-center justify-center rounded-lg">
          {icon ?? <PlugIcon className="size-3.5" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">
          {server}
        </span>
        {headerEnd ?? (
          <span className={cn(mono, "text-foreground/30 shrink-0")}>
            needs input
          </span>
        )}
      </div>

      {message !== undefined && (
        <p className="text-foreground/55 text-xs leading-relaxed">{message}</p>
      )}

      {children ?? (
      <div className="flex flex-col gap-2.5">
        {fields?.map((item) => (
          <div key={item.name} className="flex flex-col gap-1">
            <span className={cn(mono, "text-foreground/35")}>
              {item.label}
              {item.required && <span className="text-foreground/25"> *</span>}
            </span>
            {item.kind === "choice" ? (
              <div className="flex flex-wrap gap-1.5">
                {item.options?.map((option) => (
                  <span
                    key={option}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-xs transition-colors",
                      option === item.value
                        ? "bg-foreground text-background"
                        : cn(field, "text-foreground/55"),
                    )}
                  >
                    {option}
                  </span>
                ))}
              </div>
            ) : item.kind === "toggle" ? (
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={cn(
                    "flex h-4 w-7 items-center rounded-full p-0.5 transition-colors duration-200",
                    item.value === "true"
                      ? "bg-foreground/80"
                      : "bg-foreground/15",
                  )}
                >
                  <span
                    className={cn(
                      "bg-background size-3 rounded-full transition-transform duration-200 motion-reduce:transition-none",
                      item.value === "true" && "translate-x-3",
                    )}
                  />
                </span>
                <span className="text-foreground/55 text-xs">
                  {item.value === "true" ? "On" : "Off"}
                </span>
              </span>
            ) : (
              <span
                className={cn(
                  field,
                  "text-foreground/80 rounded-lg px-2.5 py-1.5 text-xs",
                )}
              >
                {item.value}
              </span>
            )}
          </div>
        ))}
      </div>
      )}

      {actions === null ? null : (
      <div className="flex h-8 items-center justify-end gap-2">
        {actions !== undefined ? (
          actions
        ) : state === "request" ? (
          <>
            <button
              type="button"
              onClick={onDecline}
              className="text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/90 h-8 rounded-full px-3.5 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96]"
            >
              Decline
            </button>
            <button
              type="button"
              onClick={onAccept}
              className={cn(
                inkButton,
                "flex h-8 items-center rounded-full px-3.5 text-xs font-medium",
              )}
            >
              Send
            </button>
          </>
        ) : (
          <span
            key={state}
            className="fade-in animate-in text-foreground/55 flex items-center gap-2 text-xs duration-300"
          >
            {state === "accepted" ? (
              <>
                <CheckIcon className="size-3.5 text-emerald-500" />
                Sent to {server}
              </>
            ) : (
              <>
                <XIcon className="text-foreground/45 size-3.5" />
                Declined
              </>
            )}
          </span>
        )}
      </div>
      )}
    </div>
  );
}
