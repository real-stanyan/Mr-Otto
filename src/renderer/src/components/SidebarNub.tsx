// 侧栏收起时的"打开"钮。
//
// 原来是一颗 absolute 贴在内容区左上角的浮标——浮标不占位，于是直接盖住了
// 紧挨左边缘的会话名。头部那排是身份信息（会话名 · 工程 · 分支），左上角
// 不是空地。改成【排进头部、当第一个元素】：它推开后面的内容而不是压在上面。
//
// 单独成文件而不是留在 App.tsx：三个叠加面板(Protocol/GitGraph/DM)全屏时
// 也要它，而那几个组件是被 App.tsx import 的，反向再 import 就成环了。

import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar.js";

/** 排进头部的版本：侧栏展开时不渲染（那时侧栏里自带收起钮） */
export function SidebarNub() {
  const { state } = useSidebar();
  if (state !== "collapsed") return null;
  // -ml-2 把它拉回头部的 px-5 内缩里：视觉上贴着左缘，与侧栏展开后
  // logo 所在的位置对齐——同一颗钮在两种状态下不该跳位置
  return <SidebarTrigger className="collapsed-nub -ml-2 shrink-0 self-center" />;
}

/** 没有头部可排的视图（欢迎页/连接中）用的浮标版本：那些页面左上角确实是空地 */
export function FloatingSidebarNub() {
  const { state } = useSidebar();
  if (state !== "collapsed") return null;
  return (
    <div className="collapsed-nub absolute top-[9px] left-2 z-40 rounded-md bg-background/75 backdrop-blur-sm border border-border shadow-sm">
      <SidebarTrigger />
    </div>
  );
}
