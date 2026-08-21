import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** macOS 判定。隐藏原生标题栏(hiddenInset)只在 darwin 生效,
    给红绿灯让位的 padding / 拖拽区只在 mac 上做,别的平台保持原生标题栏。
    运行时读 navigator(渲染进程),不是模块顶层裸读——测试环境没有 navigator */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Macintosh|MacIntel/i.test(navigator.userAgent) || /Mac/i.test(navigator.platform);
}

