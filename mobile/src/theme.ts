// 手机端的设计令牌。**逐个值抄自桌面的 src/renderer/src/app.css**——
// 那张表是维护者定的 Apple 四色底盘(#000 地面 / #1d1d1f 浮起的表面 /
// #f5f5f7 正文 / #0071e3 点缀),两端共用一套才叫同一个产品。
//
// 为什么是抄一份而不是 import 一份:app.css 是 CSS 自定义属性,RN 没有 CSS。
// 代价是两边可能漂,所以**令牌名和 CSS 变量名逐字对齐**(background / card /
// mutedForeground …),漂了 grep 得出来。
//
// 跟随系统深浅色,和桌面一致(src/renderer/src/theme.ts 的默认 pref 就是 system)。

import { Platform, useColorScheme } from "react-native";
import { appleSpring } from "../../src/shared/appleSpring.js";

export interface Palette {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  primary: string;
  primaryForeground: string;
  /** 次级实底面:两个平权按钮(Google / GitHub)用它,把蓝色让给真正的主动作 */
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  /** 小字和细线专用的点缀色。深色下比 primary 亮一档——#0071e3 压在 #1d1d1f 上
      只有 3.58:1,13px 的字在那个对比度上发暗(桌面 issue #123 的结论) */
  brand: string;
  border: string;
  /** 输入框的描边。比 border 亮半档(深色 0.14 vs 0.12)——桌面 app.css 就是分开的两条:
      一块板的边可以若隐若现,一个**能往里打字的框**必须先让人看见它在哪 */
  input: string;
  destructive: string;
  destructiveForeground: string;
  ok: string;
  warn: string;
  /** 弹窗底下那层暗幕（demo 的 --scrim）。深色压得更重——底本来就暗，压轻了分不出层 */
  scrim: string;
  /** 通话那一格的声浪色（demo 的 --voice；两套配色同一个值——它是通话的记号，不跟深浅走） */
  voice: string;
  // ── 微信式布局（#1386，demo 的 .demo/wechat/shared.css）──
  /** 侧面那一层：底栏、输入栏、面板的底（demo 的 --side） */
  side: string;
  /** 第三级的字：列表右边那格时间、段尾的弱提示（demo 的 --fg-3） */
  faint: string;
  /** 行被按下那一帧的底（demo 的 --press） */
  press: string;
  /** 一块浅浅的底：返回键旁的未读数、次按钮（demo 的 --field） */
  field: string;
  /** 输入框的底（demo 的 --input-bg：深色下它得比输入栏亮一档，否则框就看不见了） */
  inputBg: string;
  /** 我说的那个气泡（点缀色 18% 调进纸面，不是整块蓝——蓝色一屏只给一个主动作） */
  bubbleMe: string;
  /** 别人说的那个气泡（人） */
  bubbleThem: string;
  /** 智能体说的那个气泡：ok 绿调进纸面（#1465，维护者从三个方向里挑的 B），一眼分得出机器说的和人说的。浅色 14%；
      深色 22%——14% 调进黑底算出来是 #16301f，在屏幕上和人的灰气泡 #2c2c2e 分不开（维护者 2026-10-04 真机截图），
      22% 是三档里他挑的那一档 */
  bubbleAgent: string;
}

/** 浅色 = app.css 的裸 `:root` */
const light: Palette = {
  background: "#efece3",
  foreground: "#000000",
  card: "#f7f5ef",
  cardForeground: "#000000",
  primary: "#4a70a9",
  primaryForeground: "#ffffff",
  secondary: "#e5e1d3",
  secondaryForeground: "#000000",
  muted: "#e5e1d3",
  mutedForeground: "rgba(0, 0, 0, 0.55)",
  brand: "#4a70a9",
  border: "rgba(0, 0, 0, 0.12)",
  input: "rgba(0, 0, 0, 0.12)",
  destructive: "#c92a2a",
  destructiveForeground: "#ffffff",
  ok: "#2b8a3e",
  warn: "#e67700",
  scrim: "rgba(0, 0, 0, 0.28)",
  voice: "#2F94A6",
  side: "#e9e5d8",
  faint: "rgba(0, 0, 0, 0.4)",
  press: "rgba(0, 0, 0, 0.08)",
  field: "rgba(0, 0, 0, 0.055)",
  inputBg: "#f7f5ef",
  // color-mix(in srgb, #4a70a9 18%, #f7f5ef)
  bubbleMe: "#d8dde2",
  bubbleThem: "#e5e1d3",
  bubbleAgent: "#d9e6dc",
};

/** 深色 = app.css 的 `.dark` */
const dark: Palette = {
  background: "#000000",
  foreground: "#f5f5f7",
  card: "#1d1d1f",
  cardForeground: "#f5f5f7",
  primary: "#0071e3",
  primaryForeground: "#ffffff",
  secondary: "#2c2c2e",
  secondaryForeground: "#f5f5f7",
  muted: "#2c2c2e",
  mutedForeground: "rgba(245, 245, 247, 0.56)",
  brand: "#0a84ff",
  border: "rgba(245, 245, 247, 0.12)",
  input: "rgba(245, 245, 247, 0.14)",
  destructive: "#ff453a",
  destructiveForeground: "#ffffff",
  ok: "#30d158",
  warn: "#ff9f0a",
  scrim: "rgba(0, 0, 0, 0.5)",
  voice: "#2F94A6",
  side: "#1d1d1f",
  faint: "rgba(245, 245, 247, 0.38)",
  press: "rgba(245, 245, 247, 0.09)",
  field: "rgba(245, 245, 247, 0.08)",
  inputBg: "#2c2c2e",
  // color-mix(in srgb, #0a84ff 18%, #1d1d1f)
  bubbleMe: "#1a3047",
  bubbleThem: "#2c2c2e",
  bubbleAgent: "#21452b",
};

export function usePalette(): { c: Palette; isDark: boolean } {
  const isDark = useColorScheme() !== "light"; // null(未知)按深色走,和桌面 splash 一致
  return { c: isDark ? dark : light, isDark };
}

/** 等宽。桌面是 `ui-monospace, SFMono-Regular, Menlo`;iOS 上真正装了的是 Menlo */
export const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

/**
 * 字距(tracking)按字号给,不是一个值全局套用:字放大之后字母之间会显得太散,
 * 所以大字收紧(负值)、正文归零、小字微微放开。桌面那侧由系统字体的
 * optical sizing 自动处理,RN 上得手写(-0.02em @ 34px ≈ -0.7)。
 * 行距同理,和字号反向走:大标题紧、正文松。
 */
export const type = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: "700", letterSpacing: -0.7 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700", letterSpacing: -0.35 },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: "600", letterSpacing: -0.2 },
  body: { fontSize: 16, lineHeight: 22, fontWeight: "400", letterSpacing: 0 },
  callout: { fontSize: 15, lineHeight: 21, fontWeight: "400", letterSpacing: 0 },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: "400", letterSpacing: 0.05 },
} as const;

/**
 * 弹簧参数：Apple 的 response / damping ratio 换成 RN 吃的物理量。换算本身住在
 * src/shared/appleSpring.ts（有测试跟着根门禁跑），这里只是给手机端一个短名字。
 * 默认一律临界阻尼——回弹只留给"手上带着动量"的手势，而不是一个淡入的菜单。
 */
export const spring = appleSpring;

/** 按下的反馈要快到"手指按下去的同一瞬间"。0.15s 临界阻尼 */
export const PRESS_SPRING = spring(0.15);

// 桌面那侧的圆角比一般 UI 大一档:permission-grant 是 rounded-[20px],
// 输入区那块板同量级。跟上去,否则再对色也读不成同一个产品
export const radius = { card: 20, control: 14, tile: 10, pill: 999 } as const;
export const space = { xs: 6, sm: 10, md: 16, lg: 22, xl: 32 } as const;

/** 实色加透明度 → rgba()。判断住在 src/shared/color.ts（带测试），这里只转手 */
export { withAlpha } from "../../src/shared/color.js";
