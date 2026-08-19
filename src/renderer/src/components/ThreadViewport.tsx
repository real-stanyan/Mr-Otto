// 消息区的滚动容器 —— assistant-ui 的 Viewport + ScrollToBottom 同款行为。
//
// 之前是无条件 scrollIntoView:模型流式输出时,用户往上翻历史会被一下下拽回底部,
// 根本读不成。改成粘性——只在"已经在底部"时跟随,离底就停住,
// 离底期间来了新东西就在浮钮上点一颗圆点告诉你下面有没看过的内容。

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { isAtBottom } from "../lib/stickToBottom.js";

export function ThreadViewport({ deps, children }: { deps: unknown[]; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [stuck, setStuck] = useState(true);
  // 离底期间有没有来过新东西。回到底部即清
  const [missed, setMissed] = useState(false);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const bottom = isAtBottom(el);
    setStuck(bottom);
    if (bottom) setMissed(false);
  }, []);

  const jump = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight; // 高频动作:瞬时滚动,不加动画
    setStuck(true);
    setMissed(false);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stuck) {
      el.scrollTop = el.scrollHeight;
      setMissed(false);
    } else {
      setMissed(true); // 你没在看,但下面确实多了东西
    }
    // stuck 刻意不进依赖:它一变就滚会把"用户刚滚上去"这个动作又拽回来。
    // 这个 effect 只对"内容变了"负责,不对"换会话了"负责——
    // 跨会话的状态重置(stuck 归 true、missed 归 false)靠调用方给这个组件加 key(如 key={sessionId})
    // 让它随会话切换重挂,不是这个 effect 自己去猜"这次变化是不是因为换会话了"。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      {/* pb 要盖过 footer 那道 40px 渐隐:不留这段余量,滚到底时最后一条消息
          正好压在渐变里,读起来像被蒙了一层 */}
      <section
        ref={ref}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-stable px-5 pt-4 pb-12 flex flex-col gap-2"
      >
        {children}
      </section>
      {!stuck && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={jump}
          // 状态放按钮自己的 aria-label:裸 <span aria-label> 映射到 generic 角色,
          // 多数屏幕阅读器不念它的可访问名,等于"有新内容"这件事对屏幕阅读器用户不存在
          aria-label={missed ? "回到最新(有新内容)" : "回到最新"}
          // buttonVariants 基类自带 transition-[...,transform,opacity] duration-150,
          // 这里再写一遍会被 cn() 判成同组、整组覆盖掉——按压 scale/hover 变色的过渡就丢了。
          // 只补进场需要的 starting:* 就够
          className="absolute bottom-3 right-5 h-auto gap-1.5 rounded-full bg-card/90 backdrop-blur-sm px-3 py-1 text-xs shadow-md starting:opacity-0 starting:translate-y-1 motion-reduce:transition-opacity motion-reduce:starting:translate-y-0"
        >
          <ArrowDown className="size-3.5" />
          回到最新
          {missed && <span aria-hidden className="size-1.5 rounded-full bg-brand" />}
        </Button>
      )}
    </div>
  );
}
