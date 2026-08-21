// 侧栏收起时的"打开"钮。
//
// 原来是一颗 absolute 贴在内容区左上角的浮标——浮标不占位，于是直接盖住了
// 紧挨左边缘的会话名。头部那排是身份信息（会话名 · 工程 · 分支），左上角
// 不是空地。改成【排进头部、当第一个元素】：它推开后面的内容而不是压在上面。
//
// 交互两层(ADR-0010 之后新增):
//   hover = 瞬态预览浮层(不推内容、不常驻,移开就收)
//   click = 常驻展开;窄窗口下(输入框挤不下)click 不常驻,只保留 hover 预览
//
// 单独成文件而不是留在 App.tsx：三个叠加面板(Protocol/GitGraph/DM)全屏时
// 也要它，而那几个组件是被 App.tsx import 的，反向再 import 就成环了。

import { useSidebar } from "@/components/ui/sidebar.js";
import { PanelLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useChat } from "../store.js";
import { cn, isMac } from "../lib/utils.js";

/** 排进头部的版本：侧栏展开时不渲染（那时侧栏里自带收起钮） */
export function SidebarNub() {
  const { state, narrow, enterPreview, leavePreview, toggleSidebar } = useSidebar();
  const fullscreen = useChat((s) => s.fullscreen);
  if (state !== "collapsed") return null;
  // 窗口模式(mac + 非全屏)下红绿灯叠在左上角,和这颗"打开侧栏"钮同一行——
  // 给红绿灯让出位置。全屏红绿灯被 macOS 隐掉,照旧贴左缘(-ml-2 拉回头部
  // px-5 内缩里,和 logo 对齐)
  const clearTrafficLights = isMac() && !fullscreen;
  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon"
      className={cn(
        "collapsed-nub size-7 shrink-0 self-center",
        clearTrafficLights ? "ml-[52px]" : "-ml-2"
      )}
      aria-label="打开侧栏"
      onMouseEnter={enterPreview}
      onMouseLeave={leavePreview}
      onClick={() => {
        // 窄窗口:不能常驻,click 是空操作(只靠 hover 预览)
        if (!narrow) toggleSidebar();
      }}
    >
      <PanelLeftIcon />
    </Button>
  );
}

/** 没有头部可排的视图（欢迎页/连接中）用的浮标版本：那些页面左上角确实是空地 */
export function FloatingSidebarNub() {
  const { state, narrow, enterPreview, leavePreview, toggleSidebar } = useSidebar();
  const fullscreen = useChat((s) => s.fullscreen);
  if (state !== "collapsed") return null;
  // 窗口模式红绿灯叠在左上角,浮标也要让位(全屏红绿灯被 macOS 隐掉,照旧贴左缘)
  const clearTrafficLights = isMac() && !fullscreen;
  return (
    <div
      className={cn(
        "collapsed-nub absolute top-[9px] z-40 rounded-md bg-background/75 backdrop-blur-sm border border-border shadow-sm",
        clearTrafficLights ? "left-[72px]" : "left-2"
      )}
    >
      <Button
        data-sidebar="trigger"
        data-slot="sidebar-trigger"
        variant="ghost"
        size="icon"
        aria-label="打开侧栏"
        onMouseEnter={enterPreview}
        onMouseLeave={leavePreview}
        onClick={() => {
          if (!narrow) toggleSidebar();
        }}
      >
        <PanelLeftIcon />
      </Button>
    </div>
  );
}
