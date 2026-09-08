// deltaStream —— 云会话流式碎片的合帧器（issue #1107）。
// 与本机 `src/main/deltaCoalescer.ts` 同一个形状、各是各的实现：那一份的 key
// 字面量里有真的 NUL 字节（#841 在册），且 src/main 不该被 services/runtime
// import。两者共享的是**契约**不是代码：
//   ① 碎片是临时预览不是事实，永远不落事件日志（persistencePolicy 的
//      TransientPushKind）；
//   ② **线上走的是累计快照不是增量**：sink 收到的 text 是这只 agent 这一轮
//      到此刻为止的完整正文。中继掉帧、客户端中途 join、gone 之后重连，都不
//      会在预览上咬出一个洞——丢一帧只是少一次刷新，不是少一段字；
//   ③ 同一（agentId, kind）的碎片在窗口内原地拼接，按首次出现顺序成批放出；
//   ④ **任何事件要出门之前先 flush**——否则一条迟到的尾巴会在终态
//      `assistant_message` 之后到达，渲染层清完缓冲又冒出一段鬼影文字
//      （本地那条纪律写在 src/main/index.ts 的 send 包装里，这里由
//      sessionService 的 notify() 开头调 flush() 承担）；终态事件落盘后由
//      notify 调 clearAgent 把这只的累计清零，下一轮从空开始。
//
// 为什么合帧放在 runtime 而不是中继或桌面：中继不懂 payload（base64url 的
// JSON），桌面再合一次只会让「最新文字」晚到；源头合帧之后每条 delta 帧的
// 网络成本就是真实成本，桌面拿到就直发渲染层，不再需要第二道缓冲。

export type CloudDeltaKind = "content" | "reasoning";

export interface DeltaStreamSink {
  /** text = 这只 agent 这一轮**到此刻为止**的完整正文（累计快照，见头注 ②） */
  (agentId: string, kind: CloudDeltaKind, text: string): void;
}

export interface DeltaStream {
  /** 模型侧来的一小片增量 */
  push(agentId: string, kind: CloudDeltaKind, text: string): void;
  /** 立刻放出所有积存的槽位（幂等；只放这一轮窗口里真有新增量的）。
      notify() 在任何事件广播之前调它 */
  flush(): void;
  /** 终态事件（assistant_message / turn_ended）落盘后清掉这只 agent 的
      累计——不清的话它下一轮的预览会从上一次的残句开头 */
  clearAgent(agentId: string): void;
}

/** 默认合帧窗口。本机是 16ms（一帧 60Hz，IPC 就在本机）；云会话隔着一跳
    中继，放宽到 50ms——人眼读不出差别，而帧数是三分之一的差距 */
export const CLOUD_DELTA_INTERVAL_MS = 50;

export function createDeltaStream(
  sink: DeltaStreamSink,
  opts?: {
    intervalMs?: number;
    /** 只给测试拧的时钟（同本机 deltaCoalescer 的纪律） */
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (h: unknown) => void;
  }
): DeltaStream {
  const intervalMs = opts?.intervalMs ?? CLOUD_DELTA_INTERVAL_MS;
  const setTimer = opts?.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts?.clearTimer ?? ((h: unknown) => clearTimeout(h as Parameters<typeof clearTimeout>[0]));
  // Map 的迭代序就是插入序——成批放出时按「首次出现」排，同本机
  const buckets = new Map<string, { agentId: string; kind: CloudDeltaKind; pending: string; total: string }>();
  let timer: unknown = null;

  function flush(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const batch = [...buckets.values()].filter((b) => b.pending !== "");
    if (batch.length === 0) return;
    for (const b of batch) {
      b.total += b.pending;
      b.pending = "";
    }
    for (const b of batch) sink(b.agentId, b.kind, b.total);
  }

  return {
    push(agentId, kind, text) {
      // key 用 JSON 不用分隔符拼接：agentId 来自 workspace_agents 表，
      // 内容不受这里控制，分隔符撞名会让两只 agent 的碎片拼进同一桶
      const key = JSON.stringify([agentId, kind]);
      const hit = buckets.get(key);
      if (hit) hit.pending += text;
      else buckets.set(key, { agentId, kind, pending: text, total: "" });
      if (timer === null) timer = setTimer(flush, intervalMs);
    },
    flush,
    clearAgent(agentId) {
      for (const [key, b] of buckets) {
        if (b.agentId === agentId) buckets.delete(key);
      }
    },
  };
}
