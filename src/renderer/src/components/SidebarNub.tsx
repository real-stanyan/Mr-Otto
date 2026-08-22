// 侧栏开关:一颗 fixed 在左上角的钮,展开态 = 收起,收起态 = 打开(hover 瞬态预览)。
//
// 为什么是一个 fixed 元素而不是两颗各自排版的钮:收起钮在侧栏头部、打开钮在
// 内容区头部,两边 padding/行高稍有出入就对不齐,用户得来回挪鼠标。同一个
// DOM 节点、同一组坐标,两种状态的位置**结构上**相等,不靠算 class 凑。
// 两边头部各留一个等大占位(SidebarNub / SidebarTriggerSlot),布局流不变。
//
// 交互两层(ADR-0010 之后新增):
//   hover(收起态) = 瞬态预览浮层(不推内容、不常驻,移开就收)
//   click = 展开/收起常驻;窄窗口下(输入框挤不下)click 不常驻,只保留 hover 预览

import { useRef } from "react";
import { useSidebar } from "@/components/ui/sidebar.js";
import { PanelLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useChat } from "../store.js";
import { cn, isMac } from "../lib/utils.js";

/** 窗口模式(mac + 非全屏)红绿灯叠在左上角,给它让出位置;全屏红绿灯被 macOS 隐掉,贴左缘 */
function useClearTrafficLights(): boolean {
  const fullscreen = useChat((s) => s.fullscreen);
  return isMac() && !fullscreen;
}

/** 窗口模式下开关钮和搜索钮共用的 top:(44 - 28) / 2 = 8,中心 22 = HEADER_H 的中心 */
export const TOGGLE_TOP = "top-[8px]";
/** 搜索钮紧贴开关钮右侧:72 + 28 + 4 */
export const SEARCH_LEFT = "left-[104px]";

/** 真正的开关钮。挂一次在应用根部(SidebarInset 之外,不跟任何头部走) */
export function SidebarToggle() {
  const { state, narrow, enterPreview, leavePreview, toggleSidebar } = useSidebar();
  const clear = useClearTrafficLights();
  const collapsed = state === "collapsed";
  // 两态同位带来的新问题:点「收起」后鼠标还停在钮上,一挪就触发 hover 预览,
  // 浮层又盖回来,看着像没收起。点击后解除武装,鼠标离开钮一次才重新允许预览
  const armed = useRef(true);
  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon"
      className={cn(
        "sidebar-toggle fixed z-50 size-7",
        // 窗口模式:红绿灯 (16,16) 占到 x=68,钮从 72 起;top 8 + 钮高 28 → 中心 22,
        // 和 h-11 顶栏、红绿灯中心同一条线(搜索钮在 App.tsx 里以同一 top 贴在它右侧,
        // 数字见 TOGGLE_TOP / SEARCH_LEFT);全屏没有红绿灯:贴左上
        clear ? `${TOGGLE_TOP} left-[72px]` : "top-3 left-3",
        // 收起态:从侧栏消失的左缘滑入(空间一致性);展开态它就是侧栏里的收起钮
        collapsed && "collapsed-nub",
        // 展开态坐在侧栏头部(drag-region)之上:.sidebar-toggle 显式 no-drag(app.css)
        !collapsed && "text-sidebar-foreground"
      )}
      aria-label={collapsed ? "打开侧栏" : "收起侧栏"}
      title={collapsed ? "打开侧栏" : "收起侧栏"}
      onMouseEnter={() => {
        if (collapsed && armed.current) enterPreview();
      }}
      onMouseLeave={() => {
        armed.current = true;
        if (collapsed) leavePreview();
      }}
      onClick={() => {
        armed.current = false;
        // 窄窗口:不能常驻,click 是空操作(只靠 hover 预览)
        if (!narrow) toggleSidebar();
      }}
    >
      <PanelLeftIcon />
    </Button>
  );
}

/** 内容区头部的占位:收起态下给 fixed 钮留出它覆盖的那块,不让标题滑到钮底下。
    名字沿用 SidebarNub——九个头部的调用点一个不用改 */
export function SidebarNub() {
  const { state } = useSidebar();
  const clear = useClearTrafficLights();
  if (state !== "collapsed") return null;
  return <span aria-hidden className={cn("size-7 shrink-0 self-center", clear ? "ml-[52px]" : "-ml-2")} />;
}

/** 侧栏头部行首的占位:展开态下 fixed 钮就压在这里 */
export function SidebarTriggerSlot() {
  return <span aria-hidden className="size-7 shrink-0" />;
}
