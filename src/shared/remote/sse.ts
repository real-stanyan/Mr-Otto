// SSE 的最小解析器。**两端共用一份**:桌面用 fetch 的流式 body 喂它,
// 手机用 XMLHttpRequest 的增量 responseText 喂它(RN 的 fetch 没有可读的 body 流)。
//
// 两种传输拿到的字节完全一样,差别只在怎么拿到 —— 所以"怎么解析"必须只有一份实现,
// 否则控制行(`:peer`)在哪一端被漏掉都会变成"连上了但永远不握手"这种查不动的故障。
//
// 只认两种事件,别的一律跳过:
//   `:xxx`     控制行(注释行)。`:peer` = 对端到场(ADR-0100),`:ok` 开场白,`:` 心跳
//   `data: x`  端到端载荷(base64url 密文,或明文握手包)
//
// 纯文件:不许 import node builtin / electron。

export interface SseSink {
  /** 控制行的内容(去掉开头的 ':')。心跳是空串 */
  comment(kind: string): void;
  data(payload: string): void;
}

export function createSseParser(sink: SseSink): { push(chunk: string): void } {
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      for (;;) {
        const i = buf.indexOf("\n\n");
        // 半条帧:留着等下一块。TCP 想在哪断就在哪断,而一条 :peer 被切成两半
        // 之后当成两条垃圾丢掉,就是"连上了但永远不握手"
        if (i < 0) return;
        const ev = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (ev.startsWith(":")) sink.comment(ev.slice(1));
        else if (ev.startsWith("data: ")) sink.data(ev.slice(6));
      }
    },
  };
}
