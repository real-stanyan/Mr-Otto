// AttachDropZone — 把一块区域(会话框)变成文件投放区。
//
// 拖进来的东西走和 ＋ 按钮、粘贴同一道闸门(主进程 intakeFile):这里只负责
// "接住 File 列表"和"让人看见能松手了",收不收由闸门判。
//
// 浮层用 CSS 过渡而不是 GSAP:单属性进出场,没有编排(ADR-0029 的判据)。

import { useRef, useState, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { useChat } from "../store.js";
import { dragHasFiles, filesToPayload } from "../lib/attachIntake.js";
import { cn } from "@/lib/utils.js";

export function AttachDropZone({
  children,
  className,
  disabled = false,
}: {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const attachPasted = useChat((s) => s.attachPasted);
  const [over, setOver] = useState(false);
  // dragleave 在每个子元素上都会冒一次:靠计数判断"真的离开了整块区域",
  // 否则鼠标扫过一个按钮浮层就闪一下
  const depth = useRef(0);

  const leave = () => {
    depth.current = 0;
    setOver(false);
  };

  if (disabled) return <div className={className}>{children}</div>;

  return (
    <div
      className={cn("relative", className)}
      onDragEnter={(e) => {
        if (!dragHasFiles(e.dataTransfer.types)) return;
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        // 不拦 dragover 就不会触发 drop(HTML5 拖放的老规矩)
        if (!dragHasFiles(e.dataTransfer.types)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        depth.current -= 1;
        if (depth.current <= 0) leave();
      }}
      onDrop={(e) => {
        if (!dragHasFiles(e.dataTransfer.types)) return;
        e.preventDefault();
        leave();
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) void filesToPayload(files).then(attachPasted);
      }}
    >
      {children}
      {over && (
        // pointer-events-none:浮层只是给眼睛看的,drop 事件要落到下面那层容器上
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-brand/60 bg-[color-mix(in_srgb,var(--brand)_12%,var(--card))]/85 backdrop-blur-[2px] text-[13px] font-[550] text-foreground transition-[opacity,transform] duration-150 ease-[var(--ease-strong)] starting:opacity-0 starting:scale-[0.98] motion-reduce:transition-opacity motion-reduce:starting:scale-100">
          <Upload className="size-4 text-brand" aria-hidden />
          松手添加为附件
        </div>
      )}
    </div>
  );
}
