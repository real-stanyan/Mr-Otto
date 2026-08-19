/* 消息区共享的 className 组合。
   从 App.tsx 抽出来:Timeline 和 App 两边都用,谁也不该 import 谁 */

export const ROW = "max-w-[76%] whitespace-pre-wrap break-words";
export const CHIP = `${ROW} self-start text-[12.5px] font-mono border border-border rounded-lg px-[9px] py-[5px] text-muted-foreground`;
export const AUDIT = `${ROW} self-center text-xs text-muted-foreground`;
/* 思考/skill 注入行:档案气质——降调、小字、细左边线,折叠头是唯一交互点 */
export const THINKING_DETAILS = "self-stretch max-w-full border-l-2 border-border py-[2px] pl-[10px] group";
export const THINKING_SUMMARY =
  "cursor-pointer text-muted-foreground text-xs select-none list-none [&::-webkit-details-marker]:hidden before:content-['▸_'] group-open:before:content-['▾_']";
export const THINKING_BODY = "mt-1 text-muted-foreground text-[12.5px] leading-[1.55] whitespace-pre-wrap";
/* 工具详情面板的小节标题与代码块(.hl = 自研高亮器配色作用域,见 app.css) */
export const TOOL_SEC = "text-[11px] text-muted-foreground uppercase tracking-[0.05em] mt-2 mb-1";
export const TOOL_PRE =
  "hl m-0 px-[10px] py-2 rounded-lg bg-[var(--pre-bg)] font-mono text-xs leading-normal whitespace-pre-wrap break-all max-h-60 overflow-auto";
