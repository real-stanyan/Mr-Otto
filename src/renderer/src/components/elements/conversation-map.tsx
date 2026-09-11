"use client";

// 来自 assistant-ui registry: elements-conversation-map
// (https://r.assistant-ui.com/elements-conversation-map.json)
// 取回于 2026-09-11（registry 不发版本号，只能记日期：升级时拿这个日期之后的
// upstream diff 对着下面这份改动一览人工合）。它的 runtime 接线那半（上游
// `conversation-map.aui.tsx`）拆去了 `lib/conversationMap.ts`（纯逻辑）与
// `components/ConversationMapRail.tsx`（量位置 + 浮层外壳），见那两个文件的头注。
//
// 本仓改动一览（升级时要人工合）：
//  ① 预览卡从 `@base-ui/react` 的 PreviewCard 换成 Radix HoverCard。本仓不直接依赖
//     base-ui（node_modules 里那份是 @lobehub/ui 的传递依赖，直接 import 等于偷用），
//     加依赖又是 Tech stack 那一级的事（ADR-0264 为弹簧不引库是同一个先例）。
//     上游那张卡靠 PreviewCard 的 detached trigger + handle 做到**一张卡跟着指针在
//     刻度间走**，而不是每格各开各关——Radix 没有 handle，这里让整摞刻度当同一个
//     Trigger，卡片按「此刻指着哪一格」算 alignOffset：在刻度间扫过去，卡片原地换
//     内容、瞬时换位置，进退场只在第一次出现与最后一次收起时演。
//  ② 尺寸缩进本仓时间线的左内边距（px-4 = 16px）。上游的时间线 44rem 居中，刻度住在
//     宽阔的留白里；本仓的正文撑满宽度（thread.tsx 的 `--thread-max-width: 100%`），
//     留白只有 16px。命中带与它等宽（一格都不越到正文上），静止的刻度 10px、从 6px
//     起画；悬停时照上游分三档伸长（在屏幕上的 16px、指着的与当前那格 24px），允许
//     探进正文——它是瞬时的，不常驻（原来那条分区轨的同一个取舍）。
//     刻度那一摞自己有个盒子：Trigger 只能包住刻度，不能是整条 nav——nav 是满高的，
//     指针进了刻度上下的空白也弹卡就不对了。盒子高 `min(n × 14px, 100%)`：短会话挤成
//     一小撮，长会话才按比例压扁（上游靠每格 `max-h-3.5 flex-1` 在满高的 nav 里做到
//     同一件事）。
//  ③ 轨伸长的触发从 `focus-within` 收成 `:has(:focus-visible)`：鼠标点完一格，焦点
//     留在按钮上，focus-within 会让整条轨一直伸着，直到人去点别处。键盘那条路不变。
//  ④ 条目多一格可选的 `eyebrow`（标题上面那行小字）：云会话是群聊，卡片上得说是谁说的。
//  ⑤ 进退场走 keyframes 不走 transition：Radix 的 Presence 只等 animation，用
//     transition 的话卡片一关就被当场卸掉，退场根本来不及演（样式在 app.css，与
//     shadcn Popover 共用同一对 keyframes）。
//  ⑥ 文案中文化（aria-label「会话地图」），import 后缀补 `.js`，`clamp` 从
//     `@/lib/range.js`、`floating` 从 `@/lib/surfaces.js` 引（同 typing-indicator 那批）。

import {
  useCallback,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
} from "react";
import { HoverCard } from "radix-ui";
import { cn } from "@/lib/utils.js";
import { floating } from "@/lib/surfaces.js";
import { clamp } from "@/lib/range.js";
import type { ConversationMapEntry } from "@/lib/conversationMap.js";

export type { ConversationMapEntry };

const TICK = '[data-slot="conversation-map-tick"]';

/** 一格刻度的行距上限（上游 `max-h-3.5`） */
const PITCH = 14;
/** 卡片离刻度那一摞的横向距离：指着的那格伸到 30px（6 + 24），比 16px 的命中带多出
    14px，再留上游那 10px 的空 */
const SIDE_OFFSET = 24;
/** 卡片上沿到它所指那格的距离：卡片从这格「长出来」，transform-origin 也钉在这 */
const CARD_ANCHOR = 16;

export function ConversationMap({
  entries,
  activeId,
  visibleIds,
  onSelect,
  side = "right",
  className,
  onKeyDown,
  ...props
}: Omit<ComponentProps<"nav">, "children" | "onSelect"> & {
  entries: readonly ConversationMapEntry[];
  activeId?: string | undefined;
  visibleIds?: readonly string[] | undefined;
  onSelect?: ((id: string) => void) | undefined;
  side?: "left" | "right";
}) {
  const railRef = useRef<HTMLElement>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  /** 卡片此刻讲哪一格，以及那格的中线离刻度那一摞顶端多少像素（改动 ①） */
  const [pointed, setPointed] = useState<{ id: string; y: number } | null>(null);

  const inView = new Set(visibleIds);
  const activeIndex = entries.findIndex((entry) => entry.id === activeId);
  const tabbableIndex = clamp(
    focusedIndex ?? Math.max(0, activeIndex),
    0,
    Math.max(0, entries.length - 1),
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented) return;

      const ticks = railRef.current?.querySelectorAll<HTMLElement>(TICK);
      if (!ticks?.length) return;

      const current = Array.prototype.indexOf.call(ticks, event.target);
      if (current === -1) return;

      const next = {
        ArrowUp: current - 1,
        ArrowDown: current + 1,
        Home: 0,
        End: ticks.length - 1,
      }[event.key];
      if (next === undefined) return;

      event.preventDefault();
      ticks[clamp(next, 0, ticks.length - 1)]?.focus();
    },
    [onKeyDown],
  );

  const point = (id: string, tick: HTMLElement) =>
    setPointed({ id, y: tick.offsetTop + tick.offsetHeight / 2 });
  const payload =
    pointed === null ? undefined : entries.find((entry) => entry.id === pointed.id);

  return (
    <nav
      data-slot="conversation-map"
      ref={railRef}
      aria-label="会话地图"
      onKeyDown={handleKeyDown}
      className={cn(
        "group/rail pointer-events-none flex h-full w-4 flex-col justify-center",
        className,
      )}
      {...props}
    >
      <HoverCard.Root openDelay={120} closeDelay={80}>
        <HoverCard.Trigger asChild>
          <div
            data-slot="conversation-map-ticks"
            className="pointer-events-auto relative flex flex-col"
            style={{ height: `min(${entries.length * PITCH}px, 100%)` }}
          >
            {entries.map((entry, index) => {
              const current = index === activeIndex;
              const onScreen = current || inView.has(entry.id);
              return (
                <button
                  key={entry.id}
                  type="button"
                  data-slot="conversation-map-tick"
                  data-active={current ? "" : undefined}
                  data-in-view={onScreen ? "" : undefined}
                  aria-label={entry.title}
                  aria-current={current ? "true" : undefined}
                  tabIndex={index === tabbableIndex ? 0 : -1}
                  onPointerEnter={(event) => point(entry.id, event.currentTarget)}
                  onFocus={(event) => {
                    setFocusedIndex(index);
                    point(entry.id, event.currentTarget);
                  }}
                  onClick={() => onSelect?.(entry.id)}
                  className="group flex min-h-0 flex-1 items-center outline-none"
                >
                  {/* 上游原话：静止时每一格一样短，只靠粗细与深浅分三档；指针进了轨，
                      三档按档伸长，正压着的那一格伸到全长——轨借此告诉你卡片说的是
                      哪一轮 */}
                  <span
                    className={cn(
                      "ml-1.5 w-2.5 rounded-full transition-[width,height,background-color] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
                      current
                        ? "bg-foreground/90 h-[3px] group-has-[:focus-visible]/rail:w-6 group-hover/rail:w-6"
                        : cn(
                            "group-hover:bg-foreground/70 group-focus-visible:bg-foreground/70 h-0.5",
                            "group-hover:w-6! group-focus-visible:w-6!",
                            onScreen
                              ? "bg-foreground/50 group-has-[:focus-visible]/rail:w-4 group-hover/rail:w-4"
                              : "bg-foreground/15",
                          ),
                    )}
                  />
                </button>
              );
            })}
          </div>
        </HoverCard.Trigger>

        {payload && pointed && (
          <HoverCard.Portal>
            <HoverCard.Content
              data-slot="conversation-map-card"
              side={side}
              align="start"
              sideOffset={SIDE_OFFSET}
              alignOffset={pointed.y - CARD_ANCHOR}
              collisionPadding={8}
              style={{ transformOrigin: `${side === "right" ? "left" : "right"} ${CARD_ANCHOR}px` }}
              className={cn(
                floating,
                // pointer-events-none：卡片压在正文上，它不该挡住正文的点击与划词；
                // 指针离开刻度那一摞就收，卡片自己没有可点的东西
                "pointer-events-none z-50 w-60 rounded-2xl p-3.5 outline-none",
              )}
            >
              {payload.eyebrow && (
                <p className="text-foreground/50 mb-0.5 truncate text-[11px] leading-snug">
                  {payload.eyebrow}
                </p>
              )}
              <p className="line-clamp-2 text-[13px] leading-snug font-medium">
                {payload.title}
              </p>
              {payload.preview && (
                <p className="text-foreground/50 mt-1 line-clamp-3 text-[13px] leading-relaxed">
                  {payload.preview}
                </p>
              )}
            </HoverCard.Content>
          </HoverCard.Portal>
        )}
      </HoverCard.Root>
    </nav>
  );
}
