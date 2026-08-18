// thinking-orbs 的本地类型补丁 —— 不是抄一份，是把丢失的那份补回来。
//
// 包自带的 dist/index.d.ts 用无扩展名的相对导出（`export type {...} from './types'`）。
// 本仓库是 module: "nodenext"，ESM 下这种写法解析不到（tsc --traceResolution 原话：
// `Directory '.../dist/types' does not exist, skipping all lookups in it`），
// 而 skipLibCheck: true 把这个失败吞掉了——结果 ThinkingOrb / OrbSize 全成 any，
// `size={16}` 这种错值一路放行到运行时，撞上只有 20/64 两档的预设表，
// 抛 TypeError 炸穿整棵 React 树（黑屏，issue #51）。
//
// 这份声明覆盖包的 any，把 OrbSize 恢复成真实的字面量联合。
// 内容照抄 node_modules/thinking-orbs/dist/types.d.ts（v0.3.1）。
// 升级这个包时：先确认它的 d.ts 是否改成带扩展名的导出，是则删掉本文件。

declare module "thinking-orbs" {
  import type { CanvasHTMLAttributes, CSSProperties, JSX } from "react";

  export type OrbState =
    | "working"
    | "searching"
    | "solving"
    | "listening"
    | "connecting"
    | "weaving"
    | "composing"
    | "breathing"
    | "shaping";

  /** 只有两档调好的预设：64（头像尺寸）和 20（行内尺寸）。
      不是缩放系数——每档各有自己的点数/点径/速度，表里没有的档位会直接崩 */
  export type OrbSize = 64 | 20;

  export type OrbTheme = "auto" | "dark" | "light";

  export interface ThinkingOrbProps
    extends Omit<CanvasHTMLAttributes<HTMLCanvasElement>, "style"> {
    state?: OrbState;
    size?: OrbSize;
    theme?: OrbTheme;
    speed?: number;
    paused?: boolean;
    style?: CSSProperties;
  }

  export function ThinkingOrb(props: ThinkingOrbProps): JSX.Element;
}
