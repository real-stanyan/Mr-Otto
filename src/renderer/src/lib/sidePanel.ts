// 右侧槽位那一族面板的单一开关（issue #578）。
//
// 在此之前「同一块右侧槽位，互斥」是一条口头规矩：七个 boolean 各存各的，
// 每个 open* action 手抄一遍「把另外六个关掉」。加第七个面板（后台任务）时
// 这份手抄要再改十处——漏一处的表现是两块面板同时为 true，而渲染端那串
// 三元只会画排在前面的那块，另一块静默不见。
//
// 所以把「哪块开着」收成一个键，boolean 一族退化成它的投影：
//   panelKeyOf(state) —— 现在开着的是哪块（渲染端那串三元的判据同一份）
//   panelFlags(key)   —— 要开这块，七个 boolean 该是什么
//
// 只做这一件事，不管面板内容：内容各归各的组件/主进程 hub。

/** 右侧槽位能装的那几块。null = 槽位空着（会话正文占满） */
export type PanelKey = "protocol" | "git" | "terminal" | "browser" | "sim" | "files" | "bg";

/** 每块面板对应的 store 开关名。键的顺序 = 渲染端画哪块的优先级 */
const FLAG_OF = {
  browser: "browserPanelOpen",
  sim: "simPanelOpen",
  terminal: "terminalPanelOpen",
  files: "filesPanelOpen",
  bg: "bgPanelOpen",
  git: "gitGraphOpen",
  protocol: "protocolOpen",
} as const satisfies Record<PanelKey, string>;

export const PANEL_KEYS = Object.keys(FLAG_OF) as readonly PanelKey[];

/** panelFlags 的返回形状：七个开关 + 两个「同槽位的邻居」。
    settingsSection / friendChat 不是这一族的成员（一个是模式，一个是 DM），
    但它们和面板抢的是同一块屏幕，每个 open* 都要把它们让开——所以一起归零 */
export type PanelFlags = Record<(typeof FLAG_OF)[PanelKey], boolean> & {
  settingsSection: null;
  friendChat: null;
};

/** 只读那七个开关的形状。store 的 State 满足它（结构类型） */
export type PanelFlagsView = Readonly<Record<(typeof FLAG_OF)[PanelKey], boolean>>;

/** 现在开着的是哪块。多于一块为 true 时按 FLAG_OF 的顺序取第一块——
    与渲染端那串三元同序，所以「判据」和「画出来的东西」不会各说各话 */
export function panelKeyOf(state: PanelFlagsView): PanelKey | null {
  for (const key of PANEL_KEYS) if (state[FLAG_OF[key]]) return key;
  return null;
}

/** 要开 key 这块（null = 全关），七个开关该是什么。互斥由「全 false 再点亮一个」保证 */
export function panelFlags(key: PanelKey | null): PanelFlags {
  const flags = {} as Record<(typeof FLAG_OF)[PanelKey], boolean>;
  for (const k of PANEL_KEYS) flags[FLAG_OF[k]] = k === key;
  return { ...flags, settingsSection: null, friendChat: null };
}
