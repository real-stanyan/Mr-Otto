// 执行中的输出直播尾巴 —— 迷你终端视角:只看最新进展。
//
// 从 ToolRow 抽出来:assistant-ui 的 ToolFallback 没有「执行中的输出」这个概念,
// 而 bash 跑长命令时这条尾巴是界面上唯一的进度信号。抽出来两边共用,行为一字不变。
//
// tool_result 落地后 store 会清掉这个 key,组件自然消失——
// 直播只活在「事实到来前」的那个窗口里。
//
// 画的活交给 elements/terminal-block:命令写在头上、光标在跳、新行淡入 ——
// 一坨匀速刷新的等宽字看不出"还活着",这三样都是在说"它在动"。

import { useChat } from "../store.js";
import { TerminalBlock } from "./elements/terminal-block.js";

/** 尾巴只留最后这些行。限高本来就会把上面裁掉,多出来的 DOM 节点白建 ——
    npm install 那种刷几千行的命令,不设这个上限就是几千个 div */
const TAIL_LINES = 40;

export function ToolLiveTail({
  toolCallId,
  command,
  done,
}: {
  toolCallId: string;
  /** 头上那行字。bash 就是命令本身,别的工具退回工具名 */
  command: string;
  done: boolean;
}) {
  const live = useChat((s) => s.toolOutputByCall[toolCallId]);

  if (done || live === undefined || live === "") return null;
  const lines = live.split("\n").slice(-TAIL_LINES);
  return (
    <TerminalBlock
      command={command}
      lines={lines}
      visibleCount={lines.length}
      // 永远是 false:结果一落盘这个组件就没了(见上),"exit 0"那一档在这儿到不了
      done={false}
      className="mt-[2px] mb-1 max-w-none rounded-lg text-xs transition-opacity duration-150 ease-strong starting:opacity-0"
      // 顶部裁掉旧行而不是滚动:终端尾巴要的是"最新那几行永远在最下面",
      // 滚动条得追、还会被用户手滚打断
      bodyClassName="min-h-0 max-h-40 justify-end overflow-hidden"
    />
  );
}
