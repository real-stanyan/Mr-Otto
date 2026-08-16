// 斜杠指令 — 渲染层查表分发。
// "/" 开头 = 对 harness 说话，不是对模型说话：指令永远不落 user_message 事件，
// 未知指令就地报错（连主进程都不打扰）。指令的效果若模型可见（如 /compact 的摘要），
// 由对应动作在后端落成事件——这层只负责路由。

import { useChat } from "./store.js";

interface SlashCommand {
  /** 给将来 /help 和自动补全用的一句话说明 */
  desc: string;
  run: () => Promise<void>;
}

export const SLASH_COMMANDS: Record<string, SlashCommand> = {
  "/compact": {
    desc: "把会话历史压缩成摘要（真实模型调用，消耗 token）",
    run: () => useChat.getState().compact(),
  },
};

/** true = 已按指令处理（含未知指令的报错），false = 普通消息，走 send */
export function dispatchSlash(text: string): boolean {
  if (!text.startsWith("/")) return false;
  const cmd = SLASH_COMMANDS[text];
  if (cmd) {
    void cmd.run();
  } else {
    const known = Object.keys(SLASH_COMMANDS).join("、");
    useChat.setState({ error: `未知指令 ${text}（可用：${known}）` });
  }
  return true;
}
