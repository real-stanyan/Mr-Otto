"use client";

// 来自 assistant-ui registry: elements-message-attachment
// (https://r.assistant-ui.com/elements-message-attachment.json)
//
// 本仓改动一览(升级时要人工合):
//  ① item.icon —— 允许调用方自带图标。本仓有 material-icon-theme 那套类型图标
//     (FileTypeIcon),一排附件里哪个是配置、哪个是文档扫一眼就分得出;
//     上游那两枚 lucide 灰图标(文档/回形针)在这只会把类型信息抹平。
//  ② item.detail —— 附件可以就地摊开核对(文本文件看全文、图片看大图)。
//     上游只有 onOpen 回调,把"打开"甩给宿主;本仓的附件本来就都在手边,
//     另开一层浮窗去看一个自己刚发出去的东西,是白绕一圈。
//     有 detail 的行才会变成可折叠行(aria-expanded + 转角 chevron),没有的照旧。
//  ③ 中文 aria-label / 空列表返回 null。

import { useState, type ComponentProps, type ReactNode } from "react";
import {
  ChevronRight,
  FileTextIcon,
  ImageIcon,
  PaperclipIcon,
} from "lucide-react";
import { cn } from "@/lib/utils.js";
import { field, mono, paper } from "@/lib/surfaces.js";

export interface MessageAttachmentItem {
  id: string;
  name: string;
  size: string;
  kind: "image" | "document" | "file";
  pages?: number;
  /** CSS background-image 值(本仓传 url("data:image/png;base64,…")) */
  swatch?: string;
  /** 本仓改动:自带图标,给了就替掉上游那枚 lucide 灰图标 */
  icon?: ReactNode;
  /** 本仓改动:给了就能就地摊开(点整行切换),没给就还是一颗普通按钮 */
  detail?: ReactNode;
}

export function MessageAttachments({
  attachments,
  onOpen,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "attachments" | "onOpen"> & {
  attachments: readonly MessageAttachmentItem[];
  onOpen?: (id: string) => void;
}) {
  // 本仓改动:哪几条摊开着。允许同时开多条 —— 一次带三个文件时,
  // "看第二个就自动合上第一个"会让人以为自己点错了
  const [open, setOpen] = useState<readonly string[]>([]);
  if (attachments.length === 0) return null;

  const toggle = (item: MessageAttachmentItem) => {
    onOpen?.(item.id);
    if (item.detail === undefined) return;
    setOpen((cur) =>
      cur.includes(item.id)
        ? cur.filter((x) => x !== item.id)
        : [...cur, item.id],
    );
  };

  return (
    <div
      data-slot="message-attachments"
      className={cn("flex w-full max-w-sm flex-col gap-1.5", className)}
      {...props}
    >
      {attachments.map((item) => {
        const expanded = open.includes(item.id);
        const foldable = item.detail !== undefined;
        return (
          <div
            key={item.id}
            className={cn(
              item.kind === "image" ? paper : field,
              "fade-in animate-in fill-mode-both overflow-hidden rounded-2xl duration-300",
            )}
          >
            <button
              type="button"
              onClick={() => toggle(item)}
              {...(foldable ? { "aria-expanded": expanded } : {})}
              className={cn(
                "flex w-full items-center gap-3 p-2 text-start transition-colors duration-300",
                "group hover:bg-foreground/[0.05] dark:hover:bg-foreground/[0.07]",
              )}
            >
              {item.kind === "image" ? (
                <span
                  aria-hidden
                  className="size-12 shrink-0 rounded-xl bg-cover bg-center transition-transform duration-300 group-hover:scale-[1.04] motion-reduce:transition-none"
                  style={{
                    ...(item.swatch !== undefined
                      ? { backgroundImage: item.swatch }
                      : {}),
                    // 图还没读回来时给一层浅底:占位和到位是同一块面积,图片落位不顶版
                    backgroundColor:
                      item.swatch === undefined
                        ? "var(--color-foreground)"
                        : undefined,
                    opacity: item.swatch === undefined ? 0.06 : 1,
                  }}
                />
              ) : (
                <span className="bg-background/70 text-foreground/45 flex size-8 shrink-0 items-center justify-center rounded-lg">
                  {item.icon ?? // 本仓改动:自带图标优先
                    (item.kind === "document" ? (
                      <FileTextIcon className="size-3.5" />
                    ) : (
                      <PaperclipIcon className="size-3.5" />
                    ))}
                </span>
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-foreground/90 truncate text-[13.5px]">
                  {item.name}
                </span>
                <span className={cn(mono, "text-foreground/35")}>
                  {item.size}
                  {item.pages !== undefined && ` · ${item.pages} 页`}
                </span>
              </span>
              {foldable ? (
                <ChevronRight
                  aria-hidden
                  className={cn(
                    "text-foreground/25 me-1 size-3.5 shrink-0 transition-transform duration-150 ease-strong motion-reduce:transition-none",
                    expanded && "rotate-90",
                  )}
                />
              ) : (
                item.kind === "image" && (
                  <ImageIcon
                    aria-hidden
                    className="text-foreground/25 me-2 size-3.5 shrink-0"
                  />
                )
              )}
            </button>
            {expanded && (
              <div className="border-border/60 border-t">{item.detail}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
