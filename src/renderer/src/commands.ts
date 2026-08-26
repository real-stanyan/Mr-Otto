// 斜杠指令 — 渲染层查表分发。
// "/" 开头 = 对 harness 说话，不是对模型说话：指令永远不落 user_message 事件，
// 未知指令就地报错（连主进程都不打扰）。指令的效果若模型可见（如 /compact 的摘要），
// 由对应动作在后端落成事件——这层只负责路由。

import { useChat } from "./store.js";

export interface SlashCommand {
  /** 给将来 /help 和自动补全用的一句话说明 */
  desc: string;
  /** args = 指令名后面的余下文本（已去首尾空白；无参指令直接无视它） */
  run: (args: string) => Promise<void>;
}

export const SLASH_COMMANDS: Record<string, SlashCommand> = {
  "/compact": {
    desc: "把会话历史压缩成摘要（真实模型调用，消耗 token）",
    run: () => useChat.getState().compact(),
  },
  "/rename": {
    desc: "改会话标题（/rename 新标题）",
    run: (args) => useChat.getState().rename(args),
  },
  "/btw": {
    desc: "打开旁聊小浮窗（/btw 内容 = 顺手把内容发成旁聊首条；不带参只开窗）",
    // args = "/btw " 后面连带的正文（dispatchSlash 已 trim）。带参首开时
    // 直接发进旁聊（issue #516）——不然用户敲了一整段，窗开了内容却丢了
    run: (args) => useChat.getState().openSideChat(args || undefined),
  },
};

/** 命令形判定：首个空白前的 token 形如 "/名字"（字母数字下划线连字符）才算指令名。
    绝对路径（/Users/... /usr/local/...）的首 token 必含第二个 "/"，判不上——
    这样贴一个文件路径开头的消息不会被吞成"未知指令"。命中返回指令名，否则 null。 */
export function slashCommandName(text: string): string | null {
  const space = text.search(/\s/);
  const name = space === -1 ? text : text.slice(0, space);
  return /^\/[\w-]+$/.test(name) ? name : null;
}

/** true = 已按指令处理（含未知指令的报错），false = 普通消息，走 send。
    首个空白前 = 指令名，其余 = 参数（"/rename 修 bug 那次" 整段都是标题） */
export function dispatchSlash(text: string): boolean {
  const name = slashCommandName(text);
  if (name === null) return false;
  const space = text.search(/\s/);
  const args = space === -1 ? "" : text.slice(space + 1).trim();
  const cmd = SLASH_COMMANDS[name];
  if (cmd) {
    void cmd.run(args);
  } else {
    const known = Object.keys(SLASH_COMMANDS).join("、");
    useChat.setState({ error: `未知指令 ${name}（可用：${known}）` });
  }
  return true;
}
