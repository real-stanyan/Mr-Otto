// ConversationMapRail —— 把会话地图挂到一个滚动区上：浮层外壳 + 读位置的那一半。
//
// 上游（registry `conversation-map` 的 `conversation-map.aui.tsx`）把地图挂在
// assistant-ui 的 Viewport **里面**（sticky 零高层 + 与视口等高的绝对定位块），靠
// `useThreadViewport` 拿视口元素与高度。本仓两个消费方里只有本地会话有那个 store，
// 云会话的时间线是自绘的滚动区——所以改成挂在滚动区**外面**：宿主（relative）上的
// `absolute inset-y-0` 浮层，高度天然等于宿主，视口元素由调用方递进来。
// 两边剩下的差别只有三样，都由调用方给：条目怎么算、哪些元素带记号（记号 → 哪一轮）、
// 点了怎么滚（本地要穿过时间线窗口，ADR-0285）。
//
// 量位置的节奏照抄上游：scroll（passive）+ 视口 ResizeObserver，合进下一帧量一次；
// 轮次变了（多一轮 / 少一轮）再补量一次。流式期间内容在长，但跟底滚动本身就会发
// scroll 事件，不另挂 MutationObserver。

import { useEffect, useMemo, useRef, useState } from "react";
import { ConversationMap } from "@/components/elements/conversation-map.js";
import { measureTurns, MIN_TURNS, type ConversationMapEntry } from "@/lib/conversationMap.js";

const sameIds = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

export function ConversationMapRail({
  viewport,
  entries,
  owners,
  markSelector,
  markId,
  onSelect,
}: {
  /** 真正滚动的那个元素；null = 还没挂上（第一帧），不量 */
  viewport: HTMLElement | null;
  entries: readonly ConversationMapEntry[];
  /** 记号 id → 它那一轮的头 id（本地：每条消息都有；云会话：只有头行，自己映射到自己） */
  owners: ReadonlyMap<string, string>;
  /** 带记号的元素，按 DOM 顺序扫 */
  markSelector: string;
  /** 从元素上读记号 id。**要稳定引用**（模块级函数）：它在量位置那个 effect 的依赖里 */
  markId: (el: HTMLElement) => string | undefined;
  onSelect: (id: string) => void;
}) {
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [visibleIds, setVisibleIds] = useState<readonly string[]>([]);
  const ownersRef = useRef(owners);
  const scheduleRef = useRef<(() => void) | undefined>(undefined);
  const turnKey = useMemo(() => entries.map((entry) => entry.id).join(" "), [entries]);

  useEffect(() => {
    ownersRef.current = owners;
  });

  useEffect(() => {
    if (!viewport) return undefined;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const { current, onScreen } = measureTurns(
        viewport,
        viewport.querySelectorAll<HTMLElement>(markSelector),
        (el) => {
          const id = markId(el);
          return id === undefined ? undefined : ownersRef.current.get(id);
        }
      );
      setActiveId(current);
      setVisibleIds((previous) => (sameIds(previous, onScreen) ? previous : onScreen));
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };

    scheduleRef.current = schedule;
    schedule();
    viewport.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);

    return () => {
      scheduleRef.current = undefined;
      if (frame) cancelAnimationFrame(frame);
      viewport.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [viewport, markSelector, markId]);

  useEffect(() => {
    scheduleRef.current?.();
  }, [turnKey]);

  if (entries.length < MIN_TURNS) return null;
  return (
    // 整块 pointer-events-none，只有刻度那一摞自己打开（见 elements/conversation-map 的
    // 改动 ②）：浮层压在正文左缘上，空白处不能挡住正文的点击与划词。py-10 同上游
    <div
      data-slot="conversation-map-rail"
      className="pointer-events-none absolute inset-y-0 left-0 z-20 py-10"
    >
      <ConversationMap
        entries={entries}
        activeId={activeId}
        visibleIds={visibleIds}
        onSelect={onSelect}
        side="right"
      />
    </div>
  );
}
