import { describe, expect, it } from "vitest";
import { createDeltaCoalescer, type DeltaSink } from "../../src/main/deltaCoalescer.js";

// 假钟：定时器挂起不走表，测试手动 fire。同 islandBridge 测试注入假子进程的思路
function harness() {
  const calls: string[] = [];
  const sink: DeltaSink = {
    assistantDelta: (s, text, kind) => calls.push(`a:${s}:${kind}:${text}`),
    toolOutput: (s, id, chunk, stream) => calls.push(`t:${s}:${id}:${stream}:${chunk}`),
    bgOutput: (s, id, chunk, stream) => calls.push(`b:${s}:${id}:${stream}:${chunk}`),
  };
  let pending: (() => void) | null = null;
  let armed = 0;
  let cleared = 0;
  const co = createDeltaCoalescer(sink, {
    setTimer: (fn) => { pending = fn; armed++; return armed; },
    clearTimer: () => { cleared++; pending = null; },
  });
  return { calls, co, fire: () => { const f = pending; pending = null; f?.(); }, armedCount: () => armed, clearedCount: () => cleared };
}

describe("createDeltaCoalescer", () => {
  it("同键的碎片拼成一条，到点一次放行；一窗口只挂一个定时器", () => {
    const h = harness();
    h.co.assistantDelta("s1", "你", "content");
    h.co.assistantDelta("s1", "好", "content");
    h.co.assistantDelta("s1", "！", "content");
    expect(h.calls).toEqual([]); // 没到点，一条都不发
    expect(h.armedCount()).toBe(1);
    h.fire();
    expect(h.calls).toEqual(["a:s1:content:你好！"]);
  });

  it("不同键各自成条，批内按首次出现的顺序放行", () => {
    const h = harness();
    h.co.assistantDelta("s1", "推", "reasoning");
    h.co.toolOutput("s1", "call_1", "ls\n", "stdout");
    h.co.assistantDelta("s1", "答", "content");
    h.co.toolOutput("s1", "call_1", "src\n", "stdout");
    h.co.toolOutput("s1", "call_1", "警告", "stderr");
    h.fire();
    expect(h.calls).toEqual([
      "a:s1:reasoning:推",
      "t:s1:call_1:stdout:ls\nsrc\n",
      "a:s1:content:答",
      "t:s1:call_1:stderr:警告",
    ]);
  });

  it("不同会话不串流", () => {
    const h = harness();
    h.co.assistantDelta("s1", "甲", "content");
    h.co.assistantDelta("s2", "乙", "content");
    h.fire();
    expect(h.calls).toEqual(["a:s1:content:甲", "a:s2:content:乙"]);
  });

  it("flush 立刻放行 + 撤定时器；空缓冲的 flush 是 no-op", () => {
    const h = harness();
    h.co.flush(); // 空缓冲：不发、不撤（本来就没挂）
    expect(h.calls).toEqual([]);
    expect(h.clearedCount()).toBe(0);
    h.co.assistantDelta("s1", "尾段", "content");
    h.co.flush();
    expect(h.calls).toEqual(["a:s1:content:尾段"]);
    expect(h.clearedCount()).toBe(1);
    h.co.flush(); // 放行过了再 flush：什么都不发生
    expect(h.calls).toHaveLength(1);
  });

  it("放行之后新碎片重新开窗（定时器重新挂）", () => {
    const h = harness();
    h.co.assistantDelta("s1", "一", "content");
    h.fire();
    h.co.assistantDelta("s1", "二", "content");
    expect(h.armedCount()).toBe(2);
    h.fire();
    expect(h.calls).toEqual(["a:s1:content:一", "a:s1:content:二"]);
  });

  it("定时器到点放行后 flush 不重复放行（幽灵字的另一半：不能发两遍）", () => {
    const h = harness();
    h.co.toolOutput("s1", "c1", "输出", "stdout");
    h.fire();
    h.co.flush();
    expect(h.calls).toEqual(["t:s1:c1:stdout:输出"]);
  });
});

// 后台任务的输出（issue #772）走同一个合帧器：它的典型来源是构建/全量测试,
// 刷屏速度和前台 bash 一模一样,直发就是每秒上百次 IPC。
describe("bgOutput", () => {
  it("同一个 taskId 的碎片在一帧里拼成一条，与 toolOutput 各走各的键", () => {
    const h = harness();
    h.co.bgOutput("s1", "bg-1", "web", "stdout");
    h.co.toolOutput("s1", "bg-1", "别的", "stdout"); // 同名不同族:不许并到一起
    h.co.bgOutput("s1", "bg-1", "pack", "stdout");
    h.co.bgOutput("s1", "bg-1", "警告", "stderr"); // 分流也分开
    h.fire();
    expect(h.calls).toEqual([
      "b:s1:bg-1:stdout:webpack",
      "t:s1:bg-1:stdout:别的",
      "b:s1:bg-1:stderr:警告",
    ]);
  });

  it("会话之间不合并 —— bg-N 的计数器每个会话各数各的", () => {
    const h = harness();
    h.co.bgOutput("s1", "bg-1", "A", "stdout");
    h.co.bgOutput("s2", "bg-1", "B", "stdout");
    h.fire();
    expect(h.calls).toEqual(["b:s1:bg-1:stdout:A", "b:s2:bg-1:stdout:B"]);
  });
});
