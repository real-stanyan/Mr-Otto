// iOS 模拟器 —— 主进程与渲染层共用的形状(issue #401)。
//
// 坐标系只有一个:**截图像素**。原因是这块屏三方共用——人在面板上点的是
// <img> 里的像素,agent 从无障碍树读到的元素框也要能和它对得上,而 Swift
// helper 发 CGEvent 用的是 macOS 屏幕坐标。三套坐标里挑一套当事实,
// 剩下两套在边界上换算:helper 只认屏幕坐标(它在 AppKit 里活着),
// simulatorHub 负责把屏幕坐标 ↔ 截图像素来回换(纯算术,能单测)。
// 选截图像素当共用语言,是因为它是唯一一个"人和 agent 都看得见"的空间。

/** simctl list 出来的一台设备 */
export interface SimDevice {
  udid: string;
  name: string;
  /** 运行时人话名,如 "iOS 26.4" */
  runtime: string;
  /** simctl 原样的状态字符串:Booted / Shutdown / Booting / Shutting Down */
  state: string;
  /** 已开机(state === "Booted")的糖 */
  booted: boolean;
}

/** 无障碍树里的一个元素。frame 在**截图像素**空间(见文件头) */
export interface SimUiElement {
  /** AXRole,如 AXButton / AXStaticText。拿不到 = 空串 */
  role: string;
  /** 无障碍标签(iOS 侧的 accessibilityLabel) */
  label: string;
  /** 值:输入框里的文字、开关的开关态等。没有 = 省略 */
  value?: string;
  frame: { x: number; y: number; width: number; height: number };
}

/** 一帧画面。base64 而不是二进制:要过 IPC 结构化克隆再进 <img src>,
    转来转去不如一开始就是字符串 */
export interface SimFrame {
  udid: string;
  /** 图像的 base64(不带 data: 前缀) */
  image: string;
  /** 配 base64 用的 MIME。截出来的是 PNG,推给面板前会转成 JPEG——
      一帧全屏 PNG 近 3MB,按 2fps 推过 IPC 是每秒 6MB,而同一帧 JPEG 只有几十 KB。
      画面是给人看的实时预览,不是取证素材,这个损失换得值 */
  mime: "image/png" | "image/jpeg";
  width: number;
  height: number;
  /** 抓这帧的时刻(ms) */
  ts: number;
}

/** 推给渲染层的状态投影。与 BrowserTabInfo 同款:一次一整份,渲染层不做增量合并 */
export interface SimState {
  devices: SimDevice[];
  /** 当前这块屏对应的设备。null = 还没选/选中的那台没了 */
  selectedUdid: string | null;
  /** 选中那台开着没 */
  booted: boolean;
  /** 画面轮询开着没 */
  streaming: boolean;
  /** 输入通道(Swift helper)可不可用。false 时面板上的点击/输入要给人话,
      不能默默不响应 —— 最常见的原因是没给「辅助功能」授权 */
  inputReady: boolean;
  /** 最近一次失败的人话。成功一次就清掉 */
  lastError?: string;
}

/** 硬件按钮。这一层没有"按钮"这种东西——Simulator.app 把它们做成了菜单快捷键,
    helper 发的是组合键(home=⇧⌘H / lock=⌘L / siri=⌥⇧⌘H / shake=⌃⌘Z)。
    名单就到这里为止:再往下(音量键)Simulator 默认没绑快捷键,发了也没反应,
    与其挂一个假的按钮不如不给 */
export type SimButton = "home" | "lock" | "siri" | "shake";

/** 截图像素 ↔ 屏幕点 的换算。screenRect 是 Simulator 窗口里那块设备屏在
    macOS 屏幕坐标里的矩形,shot 是这次截图的像素尺寸。
    两边宽高比理论上一致,仍分轴算:窗口被拖成非等比时(实测 Simulator 会
    保持比例,但不敢赌)按各自的轴缩放,至少不会整体歪掉 */
export function pixelToScreen(
  p: { x: number; y: number },
  shot: { width: number; height: number },
  screenRect: { x: number; y: number; width: number; height: number }
): { x: number; y: number } {
  return {
    x: screenRect.x + (p.x / shot.width) * screenRect.width,
    y: screenRect.y + (p.y / shot.height) * screenRect.height,
  };
}

/** pixelToScreen 的反向。helper 报回来的无障碍框走这条路进截图像素空间 */
export function screenToPixel(
  r: { x: number; y: number; width: number; height: number },
  shot: { width: number; height: number },
  screenRect: { x: number; y: number; width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const sx = shot.width / screenRect.width;
  const sy = shot.height / screenRect.height;
  return {
    x: (r.x - screenRect.x) * sx,
    y: (r.y - screenRect.y) * sy,
    width: r.width * sx,
    height: r.height * sy,
  };
}

/** 元素一行的人话(喂模型用)。坐标取中心点——模型下一步要拿它去点 */
export function formatElement(e: SimUiElement): string {
  const cx = Math.round(e.frame.x + e.frame.width / 2);
  const cy = Math.round(e.frame.y + e.frame.height / 2);
  const role = e.role.replace(/^AX/, "");
  const val = e.value ? ` = ${JSON.stringify(e.value)}` : "";
  return `[${cx},${cy}] ${role}: ${e.label || "(无标签)"}${val}`;
}
