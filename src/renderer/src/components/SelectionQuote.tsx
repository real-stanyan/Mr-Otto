// 划词引用(assistant-ui 的 SelectionToolbar 同款):在消息区选中一段文字,
// 选区上方浮出「引用」,点了以 markdown 引用块进输入框。
//
// 编码 agent 里"这段函数改一下"是高频动作,之前只能手动复制再粘。
//
// 坐标算的是相对宿主容器的偏移,不是视口坐标:浮钮挂在容器里,
// 容器一滚视口坐标就失效,相对偏移跟着内容走

import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { Quote } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { toBlockquote } from "../lib/quote.js";
import { useChat } from "../store.js";

interface Anchor {
  x: number;
  y: number;
  text: string;
}

export function SelectionQuote({ hostRef }: { hostRef: RefObject<HTMLElement | null> }) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  useEffect(() => {
    const read = (): void => {
      const host = hostRef.current;
      const sel = window.getSelection();
      const text = sel?.toString() ?? "";
      // 两端都要落在消息区里才算「引用消息里的话」:用户可能从输入框拖选、
      // 拖进消息区,这时 anchorNode 在外面、focusNode 在里面——只判一端会
      // 把这种跨区域选择也误判成「选中了消息」
      const anchorNode = sel?.anchorNode ?? null;
      const focusNode = sel?.focusNode ?? null;
      if (
        !host ||
        !sel ||
        sel.isCollapsed ||
        text.trim() === "" ||
        !anchorNode ||
        !focusNode ||
        !host.contains(anchorNode) ||
        !host.contains(focusNode)
      ) {
        setAnchor(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const box = host.getBoundingClientRect();
      setAnchor({
        x: rect.left - box.left + rect.width / 2,
        y: rect.top - box.top,
        text,
      });
    };

    // mouseup 定位(选区此刻才定下来),selectionchange 只负责清除:
    // 拖选过程中每动一下就重定位会让浮钮跟着鼠标乱飞
    const onSelectionChange = (): void => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.toString().trim() === "") setAnchor(null);
    };

    document.addEventListener("mouseup", read);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("mouseup", read);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [hostRef]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // 浮钮的坐标是选区在当前滚动位置下算出来的绝对偏移:一滚动,文字走了
    // 浮钮不会跟着走,就变成一颗指着错误位置的按钮——收起它,等用户重新选
    const onScroll = (): void => setAnchor(null);
    host.addEventListener("scroll", onScroll, { passive: true });
    return () => host.removeEventListener("scroll", onScroll);
  }, [hostRef]);

  if (!anchor) return null;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      // onMouseDown 而不是 onClick:click 之前浏览器已经把选区清了
      onMouseDown={(e) => {
        e.preventDefault();
        const quoted = toBlockquote(anchor.text);
        if (quoted !== "") useChat.getState().injectComposer(quoted, true);
        window.getSelection()?.removeAllRanges();
        setAnchor(null);
      }}
      style={{ left: anchor.x, top: anchor.y }}
      // buttonVariants 基类自带 transition-[...,transform,opacity] duration-150,
      // 这里再写一遍会被 cn() 判成同组、整组覆盖掉——按压 scale/hover 变色的过渡就丢了。
      // 只补进场需要的 starting:* 就够
      className="absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+6px)] h-auto gap-1.5 rounded-full bg-card px-[10px] py-1 text-xs shadow-md starting:opacity-0"
    >
      <Quote className="size-3.5" />
      引用
    </Button>
  );
}
