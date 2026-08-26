// SSE 的最小解析器。**两端共用一份**:桌面用 fetch 的流式 body 喂它,
// 手机用 XMLHttpRequest 的增量 responseText 喂它(RN 的 fetch 没有可读的 body 流)。
//
// 两种传输拿到的字节完全一样,差别只在怎么拿到 —— 所以"怎么解析"必须只有一份实现,
// 否则控制行(`:peer`)在哪一端被漏掉都会变成"连上了但永远不握手"这种查不动的故障。
//
// 只认两种事件,别的一律跳过:
//   `:xxx`     控制行(注释行)。`:peer` = 对端到场(ADR-0100/0129),`:cid`/`:gone`
//              是多连接寻址那一套,`:ok` 开场白,`:` 心跳
//   `data: x`  端到端载荷(base64url 密文,或明文握手包)
//
// 一条事件可以有**好几行**。多连接之后中继会在载荷前面加一行 `event: <cid>` 说
// "这一帧是谁发的"(ADR-0129) —— 桌面接着几台手机时,不知道发件人就不知道该用
// 哪一套会话密钥去解。老客户端拿不到这一行(中继只发给 attach 时声明 v=2 的连接),
// 所以这里必须**按行解析**而不是整块前缀匹配:后者遇到两行的事件会整条丢掉。
//
// 纯文件:不许 import node builtin / electron。

export interface SseSink {
  /** 控制行的内容(去掉开头的 ':')。心跳是空串 */
  comment(kind: string): void;
  /** from = `event:` 那一行的值,没有就是空串(老中继 / 单连接) */
  data(payload: string, from: string): void;
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
        let from = "";
        let payload: string | null = null;
        for (const line of ev.split("\n")) {
          if (line.startsWith(":")) sink.comment(line.slice(1));
          else if (line.startsWith("event: ")) from = line.slice(7);
          // 一条事件里出现多行 data: 时按 SSE 规范该拼起来,但中继从不这么发
          // (载荷是 base64url,天然没有换行)。取最后一行,不额外造一套拼接规则
          else if (line.startsWith("data: ")) payload = line.slice(6);
        }
        if (payload !== null) sink.data(payload, from);
      }
    },
  };
}
