import { describe, it, expect } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import { readFileTool } from "../../src/tools/readFile.js";
import { bashTool } from "../../src/tools/bash.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { UserAttachmentRef } from "../../src/session/events.js";
import type { Tool } from "../../src/tools/tool.js";

/** 脚本化 adapter：按预设顺序吐回复，并录下每次收到的消息数 */
function fakeAdapter(script: ModelReply[]) {
  const seenMessageCounts: number[] = [];
  let i = 0;
  const adapter: ModelAdapter = {
    model: "fake-model",
    async chat(messages) {
      seenMessageCounts.push(messages.length);
      const reply = script[i++];
      if (!reply) throw new Error("脚本用完了还在调");
      return reply;
    },
  };
  return { adapter, seenMessageCounts };
}

const fakeWorld: ExecutionWorld = {
  fs: {
    read: async (path) => `<content of ${path}>`,
    write: async () => {},
  },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

describe("LoopEngine", () => {
  it("完整 turn：调工具 → 喂结果 → 模型收口，日志序列正确", async () => {
    const store = new EventStore(":memory:");
    const { adapter, seenMessageCounts } = fakeAdapter([
      {
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", args: { path: "/a.txt" } }],
      },
      { content: "文件内容是 <content of /a.txt>" },
    ]);

    const engine = new LoopEngine({
      store,
      adapter,
      tools: [readFileTool],
      world: fakeWorld,
      sessionId: "s1",
    });
    await engine.runTurn("读一下 /a.txt");

    const types = store.load("s1").map((e) => e.type);
    expect(types).toEqual([
      "user_message",
      "assistant_message",      // 带 toolCall
      "tool_execution_started", // 碰世界前留痕（ADR-0004）
      "tool_result",            // ok
      "assistant_message",      // 收口
      "turn_ended",
    ]);

    // 第二次调模型时，上下文应比第一次多 2 条（assistant + tool）
    expect(seenMessageCounts).toEqual([1, 3]);
    store.close();
  });

  it("工具抛错 → tool_result.status=error，模型下一轮能看到错误", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = fakeAdapter([
      { content: "", toolCalls: [{ id: "c1", name: "read_file", args: { path: "" } }] },
      { content: "路径不对，请给我完整路径" },
    ]);

    const engine = new LoopEngine({
      store,
      adapter,
      tools: [readFileTool],
      world: fakeWorld,
      sessionId: "s1",
    });
    await engine.runTurn("读个文件");

    const result = store.load("s1").find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ status: "error", output: expect.stringContaining("path") });
    store.close();
  });

  it("模型请求未知工具 → error 结果而不是崩溃", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = fakeAdapter([
      { content: "", toolCalls: [{ id: "c1", name: "rm_rf", args: {} }] },
      { content: "好吧" },
    ]);

    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });
    await engine.runTurn("删库");

    const result = store.load("s1").find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ status: "error", output: expect.stringContaining("未知工具") });
    store.close();
  });

  it("无步数上限：模型连续 12 轮调工具仍不熔断，直到它自己收口", async () => {
    const store = new EventStore(":memory:");
    const loop: ModelReply = {
      content: "",
      toolCalls: [{ id: "c", name: "read_file", args: { path: "/x" } }],
    };
    // 12 轮工具调用（远超旧上限 8）+ 最后一句纯文字收口
    const { adapter } = fakeAdapter([...Array(12).fill(loop), { content: "读完了" }]);

    const engine = new LoopEngine({
      store,
      adapter,
      tools: [readFileTool],
      world: fakeWorld,
      sessionId: "s1",
    });
    await engine.runTurn("一直读");

    const log = store.load("s1");
    expect(log.filter((e) => e.type === "assistant_message").length).toBe(13); // 12 带工具 + 1 收口
    expect(log.at(-1)).toMatchObject({ type: "turn_ended", outcome: "completed" });
    store.close();
  });

  it("工具声明 concludesTurn：当步提前收口，模型不再补答", async () => {
    const store = new EventStore(":memory:");
    const concludeTool: Tool = {
      def: {
        name: "finish",
        description: "结束 turn",
        parameters: { type: "object", properties: {} },
      },
      requiresApproval: false,
      run: async () => ({ output: "任务完成", concludesTurn: true }),
    };
    // 只给一句带工具调用的回复：若 engine 没在 concludesTurn 处收口、又去调模型，
    // fakeAdapter 会因脚本耗尽而抛错——测试靠这个兜住"不再补答"
    const { adapter } = fakeAdapter([
      { content: "", toolCalls: [{ id: "c1", name: "finish", args: {} }] },
    ]);

    const engine = new LoopEngine({
      store,
      adapter,
      tools: [concludeTool],
      world: fakeWorld,
      sessionId: "s1",
    });
    await engine.runTurn("收尾");

    const log = store.load("s1");
    expect(log.map((e) => e.type)).toEqual([
      "user_message",
      "assistant_message",
      "tool_execution_started",
      "tool_result",
      "turn_ended",
    ]);
    expect(log.at(-1)).toMatchObject({ type: "turn_ended", outcome: "completed" });
    store.close();
  });

  it("reasoning 随 assistant_message 落盘：思考是模型产出的新信息，丢了回放永远缺", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = fakeAdapter([{ content: "答", reasoning: "先想想：用户在问……" }]);
    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });
    await engine.runTurn("问");

    const assistant = store.load("s1").find((e) => e.type === "assistant_message");
    expect(assistant).toMatchObject({ reasoning: "先想想：用户在问……" });
    store.close();
  });

  it("usage 随 assistant_message 落盘：token 账单是日志的一部分", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = fakeAdapter([
      { content: "答", usage: { promptTokens: 120, completionTokens: 8 } },
    ]);
    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });
    await engine.runTurn("问");

    const assistant = store.load("s1").find((e) => e.type === "assistant_message");
    expect(assistant).toMatchObject({ usage: { promptTokens: 120, completionTokens: 8 } });
    store.close();
  });

  it("runTurn 带 attachments：落盘的 user_message.attachments 与传入引用相等（钉住焊点）", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = fakeAdapter([{ content: "看到了" }]);
    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });
    const ref: UserAttachmentRef = {
      id: `sha256:${"a".repeat(64)}`,
      mediaType: "image/png",
      bytes: 123,
      name: "cat.png",
    };
    await engine.runTurn("看图", [ref]);

    const evt = store.load("s1").find((e) => e.type === "user_message");
    expect((evt as { attachments?: UserAttachmentRef[] })?.attachments).toEqual([ref]);
    store.close();
  });

  it("runTurn 不传附件（空数组）：user_message 事件不带 attachments 字段（旧日志形状不变）", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = fakeAdapter([{ content: "好" }]);
    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });
    await engine.runTurn("hi", []);

    const evt = store.load("s1").find((e) => e.type === "user_message");
    expect(evt).not.toHaveProperty("attachments");
    store.close();
  });

  it("runTurn 带 textFiles：结构化落 user_message.textFiles,content 保持纯正文（钉住焊点）", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = fakeAdapter([{ content: "读了" }]);
    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });
    const file = { name: "notes.txt", content: "第一行\n第二行", bytes: 16 };
    await engine.runTurn("看文件", [], [file]);

    const evt = store.load("s1").find((e) => e.type === "user_message");
    expect(evt).toMatchObject({ content: "看文件", textFiles: [file] });
    store.close();
  });

  it("runTurn 不传 textFiles（空数组）：user_message 事件不带 textFiles 字段（旧日志形状不变）", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = fakeAdapter([{ content: "好" }]);
    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });
    await engine.runTurn("hi", [], []);

    const evt = store.load("s1").find((e) => e.type === "user_message");
    expect(evt).not.toHaveProperty("textFiles");
    store.close();
  });
});

describe("LoopEngine.compact", () => {
  it("摘要落盘成 context_compacted，之后的 turn 只看到摘要不看到原文", async () => {
    const store = new EventStore(":memory:");
    // 先铺一段历史（直接落库——engine 不在乎事件是谁写的）
    store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "把秘密计划写进文件" });
    store.append({ sessionId: "s1", ts: 2, type: "assistant_message", content: "写好了", model: "m" });

    const seen: string[][] = []; // 每次调用时模型看到的 content 列表
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(messages) {
        seen.push(messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))));
        return seen.length === 1
          ? { content: "摘要：用户让写秘密计划，已完成", usage: { promptTokens: 300, completionTokens: 20 } }
          : { content: "收到" };
      },
    };
    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });

    await engine.compact();
    const compacted = store.load("s1").at(-1);
    expect(compacted).toMatchObject({
      type: "context_compacted",
      summary: "摘要：用户让写秘密计划，已完成",
      model: "fake-model",
      usage: { promptTokens: 300, completionTokens: 20 },
    });

    await engine.runTurn("继续");
    const secondCall = seen[1]!;
    // 摘要在、新消息在、原文不在——压缩真的换掉了模型的历史记忆
    expect(secondCall.some((c) => c.includes("摘要：用户让写秘密计划"))).toBe(true);
    expect(secondCall.some((c) => c === "继续")).toBe(true);
    expect(secondCall.some((c) => c.includes("把秘密计划写进文件"))).toBe(false);
    store.close();
  });

  it("摘要人看到的是压缩投影：长工具输出/参数被截断，不是全保真原文（ADR-0003）", async () => {
    const store = new EventStore(":memory:");
    const bigContent = "字".repeat(1000);
    store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "写篇长文章" });
    store.append({
      sessionId: "s1", ts: 2, type: "assistant_message", content: "", model: "m",
      toolCalls: [{ id: "c1", name: "write_file", args: { path: "文章.txt", content: bigContent } }],
    });
    store.append({ sessionId: "s1", ts: 3, type: "tool_result", toolCallId: "c1", status: "ok", output: bigContent });
    store.append({ sessionId: "s1", ts: 4, type: "assistant_message", content: "写好了", model: "m" });

    let compactInput = "";
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(messages) {
        compactInput = JSON.stringify(messages);
        return { content: "摘要：写了文章.txt" };
      },
    };
    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });
    await engine.compact();

    // 全文没进输入，取而代之的是截断标记（参数和输出各自的）
    expect(compactInput).not.toContain(bigContent);
    expect(compactInput).toContain("上下文压缩：工具参数");
    expect(compactInput).toContain("工具输出原");
    store.close();
  });

  it("模型交白卷 → 抛错且不落任何事件（宁可失败，不落空摘要）", async () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "随便聊聊" });
    const { adapter } = fakeAdapter([{ content: "   " }]);
    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });

    await expect(engine.compact()).rejects.toThrow(/没有产出摘要/);
    expect(store.load("s1")).toHaveLength(1); // 只有原来那条
    store.close();
  });
});

describe("LoopEngine 流式转发", () => {
  it("onAssistantDelta 穿透到 adapter；落盘的事件仍是完整消息", async () => {
    const store = new EventStore(":memory:");
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(_messages, _tools, onDelta) {
        onDelta?.("片1", "content");
        onDelta?.("片2", "content");
        return { content: "片1片2" }; // 直播归直播，resolve 的永远是完整消息
      },
    };
    const deltas: string[] = [];
    const engine = new LoopEngine({
      store, adapter, tools: [], world: fakeWorld, sessionId: "s1",
      onAssistantDelta: (t) => deltas.push(t),
    });
    await engine.runTurn("说点什么");

    expect(deltas).toEqual(["片1", "片2"]);
    const last = store.load("s1").filter((e) => e.type === "assistant_message").at(-1);
    expect(last).toMatchObject({ type: "assistant_message", content: "片1片2" });
    store.close();
  });

  it("compact 不带 onDelta：摘要走非流式，没人看直播", async () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "聊过几句" });
    let sawDelta: unknown = "未记录";
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(_messages, _tools, onDelta) {
        sawDelta = onDelta;
        return { content: "摘要" };
      },
    };
    const engine = new LoopEngine({
      store, adapter, tools: [], world: fakeWorld, sessionId: "s1",
      onAssistantDelta: () => { throw new Error("compact 不该直播"); },
    });
    await engine.compact();
    expect(sawDelta).toBeUndefined();
    store.close();
  });
});

describe("turn 中断（ADR-0006）", () => {
  it("模型调用中中断：turn_ended(aborted)，不 rethrow，半截文本不落盘", async () => {
    const store = new EventStore(":memory:");
    const adapter: ModelAdapter = {
      model: "fake-model",
      chat: (_m, _t, onDelta, signal) =>
        new Promise((_res, rej) => {
          onDelta?.("流到一半的", "content");
          // 真 fetch 的行为：signal 翻转 → reject AbortError
          signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        }),
    };
    const engine = new LoopEngine({
      store, adapter, tools: [], world: fakeWorld, sessionId: "s1",
      onAssistantDelta: () => {},
    });

    const turn = engine.runTurn("讲个长故事");
    engine.abortTurn();
    await turn; // resolve 而非 reject——停止是用户意志，不是故障

    const log = store.load("s1");
    expect(log.map((e) => e.type)).toEqual(["user_message", "turn_ended"]);
    expect(log.at(-1)).toMatchObject({ outcome: "aborted" }); // 无 assistant_message：半截不是消息
    store.close();
  });

  it("工具执行中中断：被杀的调用落 error 结果，剩余调用补'未执行'，不再调模型", async () => {
    const store = new EventStore(":memory:");
    let execStarted!: () => void;
    const started = new Promise<void>((res) => { execStarted = res; });
    // 假 world：exec 挂起直到信号翻转——模拟 LocalWorld 杀进程后 throw
    const hangingWorld: ExecutionWorld = {
      fs: fakeWorld.fs,
      exec: (_cmd, opts) =>
        new Promise((_res, rej) => {
          execStarted();
          opts?.signal?.addEventListener("abort", () =>
            rej(new Error("命令被中断：用户停止了 turn，进程已被终止（SIGTERM）"))
          );
        }),
      http: { postJson: async () => ({}) },
    };
    const slowTool = {
      def: { name: "slow", description: "慢工具", parameters: { type: "object", properties: {} } },
      requiresApproval: false,
      run: async (_args: unknown, world: ExecutionWorld) => (await world.exec("sleep 99")).stdout,
    };
    let chatCalls = 0;
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat() {
        chatCalls++;
        return { content: "", toolCalls: [
          { id: "c1", name: "slow", args: {} },
          { id: "c2", name: "slow", args: {} },
        ] };
      },
    };
    const engine = new LoopEngine({
      store, adapter, tools: [slowTool], world: hangingWorld, sessionId: "s1",
    });

    const turn = engine.runTurn("跑两条慢命令");
    await started; // 等 c1 真的开跑再按停止
    engine.abortTurn();
    await turn;

    const log = store.load("s1");
    const results = log.filter((e) => e.type === "tool_result");
    expect(results[0]).toMatchObject({ toolCallId: "c1", status: "error", output: expect.stringContaining("命令被中断") });
    expect(results[1]).toMatchObject({ toolCallId: "c2", status: "error", output: expect.stringContaining("未执行") });
    // 每个 toolCall 都有答复——OpenAI 方言不留悬空（ADR-0005 的教训）
    expect(log.filter((e) => e.type === "tool_execution_started")).toHaveLength(1); // 只有 c1 碰过世界
    expect(log.at(-1)).toMatchObject({ type: "turn_ended", outcome: "aborted" });
    expect(chatCalls).toBe(1); // 中断后没再浪费一次模型调用
    store.close();
  });

  it("审批等待中中断：挂起的审批按 denied 收场，approval_decision + tool_result 照常落盘", async () => {
    const store = new EventStore(":memory:");
    // 假审批人 = UIApprover 的中断行为：不 resolve，直到信号翻转
    const hangingApprover = {
      decide: (_call: unknown, _tool: unknown, signal?: AbortSignal) =>
        new Promise<{ decision: "denied"; reason: string }>((res) => {
          signal?.addEventListener("abort", () =>
            res({ decision: "denied", reason: "turn 被用户中断" })
          );
        }),
    };
    const { adapter } = fakeAdapter([
      { content: "", toolCalls: [{ id: "c1", name: "bash", args: { cmd: "rm -rf /" } }] },
    ]);
    const engine = new LoopEngine({
      store, adapter, tools: [bashTool], world: fakeWorld, sessionId: "s1",
      approver: hangingApprover,
    });

    const turn = engine.runTurn("删库");
    await new Promise((r) => setTimeout(r, 0)); // 让 turn 跑到审批门挂起
    engine.abortTurn();
    await turn;

    const log = store.load("s1");
    expect(log.find((e) => e.type === "approval_decision")).toMatchObject({ decision: "denied" });
    expect(log.find((e) => e.type === "tool_result")).toMatchObject({ status: "denied" });
    expect(log.map((e) => e.type)).not.toContain("tool_execution_started"); // 执行器未达
    expect(log.at(-1)).toMatchObject({ type: "turn_ended", outcome: "aborted" });
    store.close();
  });

  it("幂等：没 turn 在跑时 abortTurn 无操作；中断不污染下一个 turn", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = fakeAdapter([{ content: "好" }]);
    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });

    engine.abortTurn(); // idle 时按停止：啥也不发生
    await engine.runTurn("你好"); // 新 turn 用新 controller，上面那下不影响它

    expect(store.load("s1").at(-1)).toMatchObject({ type: "turn_ended", outcome: "completed" });
    store.close();
  });
});

describe("lifecycle 事件（ADR-0004）", () => {
  it("收口 turn：末尾落 turn_ended(completed)；工具执行前落 tool_execution_started", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = fakeAdapter([
      { content: "", toolCalls: [{ id: "c1", name: "read_file", args: { path: "/a.txt" } }] },
      { content: "读完了" },
    ]);
    const engine = new LoopEngine({
      store, adapter, tools: [readFileTool], world: fakeWorld, sessionId: "s1",
    });
    await engine.runTurn("读 /a.txt");

    const types = store.load("s1").map((e) => e.type);
    expect(types).toEqual([
      "user_message",
      "assistant_message",
      "tool_execution_started", // 碰世界前留痕
      "tool_result",
      "assistant_message",
      "turn_ended",             // 收口边界
    ]);
    expect(store.load("s1").at(-1)).toMatchObject({ outcome: "completed" });
    store.close();
  });

  it("turn 暴死：turn_ended(error) 补记事实，错误照旧向上抛", async () => {
    const store = new EventStore(":memory:");
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat() { throw new Error("API 超时了"); },
    };
    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });

    await expect(engine.runTurn("你好")).rejects.toThrow("API 超时了");
    expect(store.load("s1").at(-1)).toMatchObject({
      type: "turn_ended", outcome: "error", error: "API 超时了",
    });
    store.close();
  });

  it("被拒绝的调用没有 tool_execution_started：审批门短路，执行器未达", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = fakeAdapter([
      { content: "", toolCalls: [{ id: "c1", name: "bash", args: { cmd: "rm -rf /" } }] },
      { content: "好吧不删了" },
    ]);
    // 不给 approver：requiresApproval 的工具默认拒绝
    const engine = new LoopEngine({
      store, adapter, tools: [bashTool], world: fakeWorld, sessionId: "s1",
    });
    await engine.runTurn("删库");

    const types = store.load("s1").map((e) => e.type);
    expect(types).not.toContain("tool_execution_started");
    expect(types).toContain("approval_decision");
    expect(store.load("s1").find((e) => e.type === "tool_result")).toMatchObject({ status: "denied" });
    store.close();
  });

  it("onToolOutput 带着 toolCallId 转发 exec 直播碎片；碎片不落盘", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = fakeAdapter([
      { content: "", toolCalls: [{ id: "c9", name: "bash", args: { cmd: "make build" } }] },
      { content: "编译完了" },
    ]);
    // 假 world：exec 时主动吐两段直播——模拟子进程分批输出
    const streamingWorld: ExecutionWorld = {
      fs: fakeWorld.fs,
      exec: async (_cmd, opts) => {
        opts?.onOutput?.("第一段\n", "stdout");
        opts?.onOutput?.("警告\n", "stderr");
        return { stdout: "第一段\n", stderr: "警告\n", exitCode: 0 };
      },
      http: { postJson: async () => ({}) },
    };
    const got: Array<{ id: string; chunk: string; stream: string }> = [];
    const engine = new LoopEngine({
      store, adapter, tools: [bashTool], world: streamingWorld, sessionId: "s1",
      approver: { decide: async () => ({ decision: "approved" as const }) },
      onToolOutput: (id, chunk, stream) => got.push({ id, chunk, stream }),
    });
    await engine.runTurn("跑个编译");

    // 直播层：碎片挂着发起调用的 id（engine 按调用包 world，工具无感）
    expect(got).toEqual([
      { id: "c9", chunk: "第一段\n", stream: "stdout" },
      { id: "c9", chunk: "警告\n", stream: "stderr" },
    ]);
    // 事实层：日志只有完整 tool_result，没有任何碎片事件
    const log = store.load("s1");
    expect(log.filter((e) => e.type === "tool_result")).toHaveLength(1);
    store.close();
  });

  it("不给 onToolOutput：world 原样直达，接口向后兼容", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = fakeAdapter([
      { content: "", toolCalls: [{ id: "c1", name: "bash", args: { cmd: "ls" } }] },
      { content: "好" },
    ]);
    let sawOnOutput: unknown = "未调用";
    const world: ExecutionWorld = {
      fs: fakeWorld.fs,
      exec: async (_cmd, opts) => {
        sawOnOutput = opts?.onOutput;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      http: { postJson: async () => ({}) },
    };
    const engine = new LoopEngine({
      store, adapter, tools: [bashTool], world, sessionId: "s1",
      approver: { decide: async () => ({ decision: "approved" as const }) },
    });
    await engine.runTurn("列一下");
    expect(sawOnOutput).toBeUndefined(); // 没人订阅直播就不包装，不塞多余回调
    store.close();
  });

  it("失控空转靠 abort 兜底：模型永远要工具也不报错，直到用户停止", async () => {
    const store = new EventStore(":memory:");
    // 模型永远要工具、永不收敛——DSH 式设计里这不再报"超过 N 步"，
    // 兜底是用户停止键（abortTurn）翻信号，loop 当圈从 throwIfAborted 收口
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(_messages, _tools, _delta, signal) {
        signal?.throwIfAborted();
        return {
          content: "",
          toolCalls: [{ id: `c${Math.random()}`, name: "read_file", args: { path: "/a" } }],
        };
      },
    };
    const engine = new LoopEngine({
      store, adapter, tools: [readFileTool], world: fakeWorld, sessionId: "s1",
    });
    // 跑起来后立刻打断：不依赖步数上限，中断信号就是那个天花板
    const running = engine.runTurn("无限循环吧");
    await Promise.resolve(); // 让 loop 先进入第一轮
    engine.abortTurn();
    await running;

    expect(store.load("s1").at(-1)).toMatchObject({ type: "turn_ended", outcome: "aborted" });
    store.close();
  });
});
