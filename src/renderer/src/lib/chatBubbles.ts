// chatBubbles —— 一条回复怎么拆成几张气泡（#1132，ADR-0265）。
//
// 云会话是群聊，而真人在群里不会一口气发五百字：说一句、停一下、再发一句。
// agent 的一轮回复落盘仍然是**一条** assistant_message（事件日志一个字不动，
// 这里是投影），只是画的时候按空行切成几张气泡、像连发的几条消息。系统提示词
// （deriveMessages.ts 的 PLAIN_TALK）对模型说的是同一句话——「段与段之间空一行，
// 群里会把每一段当成你连发的一条消息」——两边说的必须是同一件事，所以判据只有
// 这一条：**空行分段**。
//
// 唯一的例外是代码围栏：围栏里的空行不算分段。脚本、命令是交付物，切成两张
// 气泡就没法整段复制；没关上的围栏（流式预览正长到一半）把后面全部留在同一张里，
// 等它关上再说。

const FENCE = /^\s*(```|~~~)/;

/** 按空行拆段；只含空白的行也算空行（模型爱在空行里留一个空格）。
    首尾空白剥掉，空段丢掉——只有空白的文本回空数组，画不画那张空气泡由调用方定 */
export function splitBubbles(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  const flush = () => {
    const part = cur.join("\n").trim();
    if (part !== "") out.push(part);
    cur = [];
  };
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      cur.push(line);
      continue;
    }
    if (!inFence && line.trim() === "") {
      flush();
      continue;
    }
    cur.push(line);
  }
  flush();
  return out;
}
