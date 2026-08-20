"use client";

import type { ComponentProps, ReactNode } from "react";
import { KeyRoundIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { field, inkButton, mono, paper } from "@/lib/surfaces.js";

export type GrantScope = "session" | "always" | "denied";

export function PermissionGrant({
  capability,
  requester,
  reach,
  scope,
  onGrant,
  actions,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "capability" | "requester" | "reach" | "scope" | "onGrant" | "actions"
> & {
  capability: string;
  requester: string;
  reach: readonly string[];
  scope: GrantScope | "pending";
  onGrant?: (scope: GrantScope) => void;
  /** 本仓改动:自带那排钮换成调用方给的动作条。本仓的审批比"三档授权"多两件事 ——
      拒绝要能带原因(模型会看到),批准还有"只批这一次"这一档 ——
      而这些都塞不进 onGrant(scope) 这个形状。给了 actions 就整排替换 */
  actions?: ReactNode;
}) {
  return (
    <div
      data-slot="permission-grant"
      className={cn(
        paper,
        "flex w-full max-w-sm flex-col gap-3.5 rounded-[20px] p-4",
        className,
      )}

      {...props}
    >
      <div className="flex items-center gap-2.5">
        <span className="bg-foreground/[0.05] text-foreground/45 flex size-7 shrink-0 items-center justify-center rounded-lg">
          <KeyRoundIcon className="size-3.5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13.5px] font-medium">
            {capability}
          </span>
          <span className="text-foreground/45 truncate text-xs">
            {requester} 请求
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className={cn(mono, "text-foreground/30")}>这一步会</span>
        {reach.map((item) => (
          <span
            key={item}
            className="text-foreground/60 flex items-baseline gap-2 text-xs"
          >
            <span
              aria-hidden
              className="bg-foreground/20 size-1 rounded-full"
            />
            {item}
          </span>
        ))}
      </div>

      {/* actions === null 的意思是"这排我不要" —— 连这个 h-8 的位子都别占,
          否则卡底下留一条空带。actions === undefined 才落回自带那排:
          不能写 `actions ?? …`,?? 会把 null 也当成"没传" */}
      {actions === null ? null : (
      <div className="flex h-8 items-center justify-end gap-2">
        {actions !== undefined ? (
          actions
        ) : scope === "pending" ? (
          <>
            <button
              type="button"
              onClick={() => onGrant?.("denied")}
              className="text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/90 h-8 rounded-full px-3 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96]"
            >
              Deny
            </button>
            <button
              type="button"
              onClick={() => onGrant?.("session")}
              className="text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/90 h-8 rounded-full px-3 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96]"
            >
              This session
            </button>
            <button
              type="button"
              onClick={() => onGrant?.("always")}
              className={cn(
                inkButton,
                "flex h-8 items-center rounded-full px-3 text-xs font-medium",
              )}
            >
              Always
            </button>
          </>
        ) : (
          <span
            key={scope}
            className={cn(
              field,
              mono,
              "fade-in animate-in text-foreground/55 rounded-full px-2.5 py-1.5 duration-300",
            )}
          >
            {scope === "denied" ? "denied" : `granted · ${scope}`}
          </span>
        )}
      </div>
      )}
    </div>
  );
}
