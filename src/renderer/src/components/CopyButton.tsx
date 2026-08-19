// 复制键 —— 三处共用(代码块、模型回复、工具输出)。
// 反馈走图标切换而不是 toast:复制是微动作,值不上一次全局打断。
// 失败也一样(Electron 里罕见但可能):闪一下叉,1.5s 后自己复原

import { useEffect, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";

export function CopyButton({
  text,
  label = "复制",
  className = "",
}: {
  /** 传函数 = 点的时候才求值(代码块要从 DOM 读 textContent,渲染时还没有) */
  text: string | (() => string);
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(t);
  }, [state]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
      setState("done");
    } catch {
      setState("fail");
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      className={
        "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.08] " +
        className
      }
      onClick={() => void copy()}
    >
      {state === "done" ? (
        <Check className="size-3.5 text-ok" />
      ) : state === "fail" ? (
        <X className="size-3.5 text-err" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </Button>
  );
}
