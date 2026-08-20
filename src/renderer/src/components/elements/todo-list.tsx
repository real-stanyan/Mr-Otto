"use client";

import type { ComponentProps, ReactNode } from "react";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { mono } from "@/lib/surfaces.js";

export type TodoStatus = "pending" | "active" | "done";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

export function TodoList({
  items,
  revision,
  header,
  activeIcon,
  activeClassName,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "items" | "revision"> & {
  items: readonly TodoItem[];
  revision?: number;
  /** 本仓改动:头行可替换,规则同 permission-grant 的 actions ——
      undefined 落回自带的 "Todos n/m",null = 不要(本仓的头行在外面,
      它同时是折叠开关,还要报"还没完的有几项") */
  header?: ReactNode;
  /** 本仓改动:进行中的图标可换。原件写死转圈,而本仓分两种"进行中":
      turn 在跑 = 此刻正在发生(转圈的球),turn 停了 = 模型开了个头就收工了
      —— 静止的会话不该有转圈的动效在说"正在动" */
  activeIcon?: ReactNode;
  /** 本仓改动:进行中那行文字的附加类。同上,只有真在跑的时候才加 shimmer */
  activeClassName?: string;
}) {
  const done = items.filter((item) => item.status === "done").length;

  return (
    <div
      data-slot="todo-list"
      className={cn("flex w-full max-w-sm flex-col gap-3", className)}

      {...props}
    >
      {header === null ? null : header !== undefined ? (
        header
      ) : (
        <div className="flex items-baseline justify-between">
          <span className="text-[13.5px] font-medium">Todos</span>
          <span className={cn(mono, "text-foreground/35 tabular-nums")}>
            {revision === undefined
              ? `${done}/${items.length}`
              : `${done}/${items.length} · rev ${revision}`}
          </span>
        </div>
      )}
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li
            key={item.id}
            className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both flex items-start gap-2.5 py-0.5 text-[13.5px] duration-300"
          >
            <span className="flex size-4 h-5 shrink-0 items-center justify-center">
              {item.status === "done" ? (
                <span className="border-foreground/20 bg-foreground/[0.06] flex size-3.5 items-center justify-center rounded-[5px] border">
                  <CheckIcon className="text-foreground/45 size-2.5" />
                </span>
              ) : item.status === "active" ? (
                activeIcon ?? (
                  <Loader2Icon className="size-3.5 animate-spin text-blue-500 motion-reduce:animate-none dark:text-blue-400" />
                )
              ) : (
                <span
                  aria-hidden
                  className="border-foreground/15 size-3.5 rounded-[5px] border"
                />
              )}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 leading-5 break-words",
                item.status === "done" &&
                  "text-foreground/35 line-through decoration-[1.5px]",
                item.status === "active" && cn("text-foreground/90", activeClassName),
                item.status === "pending" && "text-foreground/50",
              )}
            >
              {item.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
