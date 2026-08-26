import { describe, it, expect, vi } from "vitest";
import { LoopEngine, LONG_TURN_ROUNDS } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import { readFileTool } from "../../src/tools/readFile.js";
import { bashTool } from "../../src/tools/bash.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import { markErrorClass } from "../../src/model/errorClass.js";
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

/** 脚本化 adapter 的增强版：还能录下每次收到的工具声明 */
function fakeAdapterWithTools(script: ModelReply[]) {
  const seenTools: { name: string }[][] = [];
  let i = 0;
  const adapter: ModelAdapter = {
    model: "fake-model",
    async chat(messages, tools) {
      seenTools.push(tools?.map((t) => ({ name: t.name })) ?? []);
      const reply = script[i++];
      if (!reply) throw new Error("脚本用完了还在调");
      return reply;
    },
  };
  return { adapter, seenTools };
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
      "request_envelope",       // 先落信封再喂模型（issue #383）；第二圈信封没变不重复落
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
      "request_envelope",
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

  it("available() === false 的工具不在模型声明表里，但掉线前发出的调用仍能用 toolsByName 解决", async () => {
    const store = new EventStore(":memory:");
    // 两个工具：一个可用，一个已掉线
    const availableTool: Tool = {
      def: {
        name: "available_tool",
        description: "我还在",
        parameters: { type: "object", properties: {} },
      },
      requiresApproval: false,
      available: () => true,
      run: async () => "可用工具响应",
    };
    const unavailableRun = vi.fn(async () => {
      // 模拟 mcpTool.ts 的行为：掉线时抛出人话错误
      throw new Error("当前没连上，这次调用没发出去");
    });
    const unavailableTool: Tool = {
      def: {
        name: "unavailable_tool",
        description: "我掉线了",
        parameters: { type: "object", properties: {} },
      },
      requiresApproval: false,
      available: () => false, // 掉线
      run: unavailableRun,
    };

    const { adapter, seenTools } = fakeAdapterWithTools([
      {
        content: "试试不可用的工具",
        toolCalls: [{ id: "c1", name: "unavailable_tool", args: {} }],
      },
      { content: "完成" },
    ]);

    const engine = new LoopEngine({
      store,
      adapter,
      tools: [availableTool, unavailableTool],
      world: fakeWorld,
      sessionId: "s1",
    });
    await engine.runTurn("查一下");

    // 验证 1a: 声明表里只有可用的工具（掉线的工具被过滤）
    const firstCallTools = seenTools[0];
    expect(firstCallTools?.map((t) => t.name)).toEqual(["available_tool"]);

    // 验证 1b: 掉线的工具仍在 toolsByName 里，调用被解决而非"未知工具"
    // （若 toolsByName 也被过滤，模型请求的工具会失败为"未知工具"；
    // 现在应该成功调用工具，只是工具的 run() 该因为掉线而内部报错）
    const result = store.load("s1").find((e) => e.type === "tool_result");
    expect(result).toMatchObject({
      toolCallId: "c1",
      status: "error", // 工具执行失败
      // 关键：输出应该是 unavailableTool 本身产生的错误，不是 engine 的"未知工具"错误
      // unavailableTool.run 没被执行（因为它会返回成功），
      // 而是在 engine 的 run() 调用中抛了错（检查 live 失败）
      output: expect.not.stringContaining("未知工具"),
    });

    // 验证 1c: 这验证了 toolsByName 没被过滤——若被过滤，run() 永远不会被调
    // 通过检查存储记录验证工具确实被尝试执行了。
    // 按 toolCallId 过滤而不是全会话 .some()（issue #158）：本例一轮只有一次
    // 调用，两种写法今天等价，但"某处有过一条 tool_execution_started"
    // 和"c1 这次调用真的开跑了"是两件事，断言该说后者
    const started = store
      .load("s1")
      .filter((e) => e.type === "tool_execution_started" && e.toolCallId === "c1");
    expect(started).toHaveLength(1);

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
    // resolve 而非 reject——停止是用户意志，不是故障。返回值直接说这一轮怎么收的口：
    // 调用方靠它决定跑不跑 turn 后那几条外挂，不必回头翻日志（issue #112）
    await expect(turn).resolves.toBe("aborted");

    const log = store.load("s1");
    // request_envelope 在喂模型前落（issue #383）——中断的 turn 也留着它：信封是"发过请求"的事实
    expect(log.map((e) => e.type)).toEqual(["user_message", "request_envelope", "turn_ended"]);
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
    await expect(engine.runTurn("读 /a.txt")).resolves.toBe("completed");

    const types = store.load("s1").map((e) => e.type);
    expect(types).toEqual([
      "user_message",
      "request_envelope",
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
    // 未分类的错误不落 errorClass 字段（不硬猜，issue #389）
    expect(store.load("s1").at(-1)).not.toHaveProperty("errorClass");
    store.close();
  });

  it("adapter 抛的分类错误：turn_ended 落 errorClass，error 存原文（issue #389）", async () => {
    const store = new EventStore(":memory:");
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat() {
        throw markErrorClass(new Error("model API 429: rate limited"), "rate-limit");
      },
    };
    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });

    await expect(engine.runTurn("你好")).rejects.toThrow("429");
    expect(store.load("s1").at(-1)).toMatchObject({
      type: "turn_ended",
      outcome: "error",
      error: "model API 429: rate limited", // 原文不动——人话是渲染层的事
      errorClass: "rate-limit",
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

describe("并发安全工具组（issue #283 ③）", () => {
  /** 慢工具：记录并发水位和起止顺序 */
  function slowTool(name: string, parallelSafe: boolean, trace: string[], gauge: { inFlight: number; max: number }): Tool {
    return {
      def: { name, description: "", parameters: { type: "object", properties: {} } },
      requiresApproval: false,
      ...(parallelSafe ? { parallelSafe: true } : {}),
      async run(args) {
        const n = (args as { n: string }).n;
        trace.push(`start-${n}`);
        gauge.inFlight++;
        gauge.max = Math.max(gauge.max, gauge.inFlight);
        await new Promise((r) => setTimeout(r, 20));
        gauge.inFlight--;
        trace.push(`end-${n}`);
        return `done-${n}`;
      },
    };
  }

  it("连续的 parallelSafe 调用并发执行，结果按调用序落盘", async () => {
    const store = new EventStore(":memory:");
    const trace: string[] = [];
    const gauge = { inFlight: 0, max: 0 };
    const { adapter } = fakeAdapter([
      {
        content: "",
        toolCalls: [
          { id: "c1", name: "p", args: { n: "1" } },
          { id: "c2", name: "p", args: { n: "2" } },
        ],
      },
      { content: "收口" },
    ]);
    const engine = new LoopEngine({
      store,
      adapter,
      tools: [slowTool("p", true, trace, gauge)],
      world: fakeWorld,
      sessionId: "s1",
    });
    await engine.runTurn("并发读");

    expect(gauge.max).toBe(2); // 真的并发了
    const results = store.load("s1").filter((e) => e.type === "tool_result");
    expect(results.map((e) => (e.type === "tool_result" ? e.toolCallId : ""))).toEqual(["c1", "c2"]);
    expect(results.map((e) => (e.type === "tool_result" ? e.output : ""))).toEqual([
      "done-1",
      "done-2",
    ]); // 原调用序，不是完成序
    store.close();
  });

  it("非 parallelSafe 工具是屏障：夹在中间时前后严格串行", async () => {
    const store = new EventStore(":memory:");
    const trace: string[] = [];
    const gauge = { inFlight: 0, max: 0 };
    const { adapter } = fakeAdapter([
      {
        content: "",
        toolCalls: [
          { id: "c1", name: "p", args: { n: "1" } },
          { id: "c2", name: "serial", args: { n: "2" } },
          { id: "c3", name: "p", args: { n: "3" } },
        ],
      },
      { content: "收口" },
    ]);
    const engine = new LoopEngine({
      store,
      adapter,
      tools: [slowTool("p", true, trace, gauge), slowTool("serial", false, trace, gauge)],
      world: fakeWorld,
      sessionId: "s1",
    });
    await engine.runTurn("读-跑-读");

    // 屏障语义：1 完成后 2 才开始，2 完成后 3 才开始
    expect(trace).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
    expect(gauge.max).toBe(1);
    store.close();
  });
});

describe("长 turn 软告警（issue #283 ⑥）", () => {
  it("模型步数踩到 LONG_TURN_ROUNDS 喊一次，且只喊一次", async () => {
    const store = new EventStore(":memory:");
    const script: ModelReply[] = Array.from({ length: LONG_TURN_ROUNDS + 1 }, (_, k) =>
      k < LONG_TURN_ROUNDS
        ? { content: "", toolCalls: [{ id: `c${k}`, name: "read_file", args: { path: "/a" } }] }
        : { content: "完" }
    );
    const { adapter } = fakeAdapter(script);
    const alerts: number[] = [];
    const engine = new LoopEngine({
      store,
      adapter,
      tools: [readFileTool],
      world: fakeWorld,
      sessionId: "s1",
      onLongTurn: (rounds) => alerts.push(rounds),
    });
    await engine.runTurn("超长任务");
    expect(alerts).toEqual([LONG_TURN_ROUNDS]); // 恰好一次，越过阈值后不再重复喊
    store.close();
  });
});

// issue #277：快照增量维护——首圈全量、之后补尾段，投影必须与全量重读逐字等价
describe("日志快照增量维护（issue #277）", () => {
  it("三步 turn 只全量 load 一次；每圈投影与全量重读等价", async () => {
    const store = new EventStore(":memory:");
    const seen: unknown[][] = [];
    let step = 0;
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(messages) {
        // 每次模型被调时，把引擎喂来的投影和「此刻全量重读再投影」对表——
        // 这是快照等价性的定义本身
        const { deriveMessages, DEFAULT_COMPRESSION } = await import("../../src/session/deriveMessages.js");
        expect(messages).toEqual(deriveMessages(store.load("s1"), DEFAULT_COMPRESSION));
        seen.push(messages);
        step++;
        if (step <= 2) return { content: "", toolCalls: [{ id: `c${step}`, name: "read_file", args: { path: "/a.txt" } }] };
        return { content: "收口" };
      },
    };
    const loadSpy = vi.spyOn(store, "load");
    const engine = new LoopEngine({ store, adapter, tools: [readFileTool], world: fakeWorld, sessionId: "s1" });
    await engine.runTurn("连跑三步");
    // 全量 load（不带 afterSeq 的调用；等价性断言里测试自己那三次要刨掉）
    const fullLoads = loadSpy.mock.calls.filter((c) => !c[1]).length - step;
    expect(fullLoads).toBe(1);
    store.close();
  });

  it("带外追加（外挂异步落的事件）在下一圈进入投影", async () => {
    const store = new EventStore(":memory:");
    let step = 0;
    let sawInjected = false;
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(messages) {
        step++;
        if (step === 1) {
          // 模拟外挂在 turn 中途带外落事件（不经引擎的 append）
          store.append({ sessionId: "s1", ts: 99, type: "skill_invoked", name: "sk", content: "带外注入的说明" });
          return { content: "", toolCalls: [{ id: "c1", name: "read_file", args: { path: "/a.txt" } }] };
        }
        sawInjected = messages.some((m) => typeof m.content === "string" && m.content.includes("带外注入的说明"));
        return { content: "收口" };
      },
    };
    const engine = new LoopEngine({ store, adapter, tools: [readFileTool], world: fakeWorld, sessionId: "s1" });
    await engine.runTurn("测带外");
    expect(sawInjected).toBe(true);
    store.close();
  });

  it("快照只活一个 turn：第二个 turn 重新全量 load（不吃常驻内存）", async () => {
    const store = new EventStore(":memory:");
    const mk = () => {
      let called = false;
      const adapter: ModelAdapter = {
        model: "fake-model",
        async chat() { if (called) throw new Error("多余的调用"); called = true; return { content: "好" }; },
      };
      return adapter;
    };
    const engine = new LoopEngine({ store, adapter: mk(), tools: [], world: fakeWorld, sessionId: "s1" });
    await engine.runTurn("一");
    const loadSpy = vi.spyOn(store, "load");
    engine.setAdapter(mk());
    await engine.runTurn("二");
    expect(loadSpy.mock.calls.filter((c) => !c[1]).length).toBe(1); // 新 turn 首圈全量一次
    const types = store.load("s1").map((e) => e.type);
    expect(types.filter((t) => t === "user_message")).toHaveLength(2);
    store.close();
  });
});

describe("runTurn 的 origin 标（issue #428）", () => {
  it("传了才落 origin：不传时事件形状与从前逐字节一致", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = fakeAdapter([{ content: "好" }, { content: "好" }]);
    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s" });

    await engine.runTurn("人打的字");
    await engine.runTurn("[后台任务 bg-1 完成] npm test", undefined, undefined, {
      taskIds: ["bg-1"],
    });

    const users = store
      .load("s")
      .filter((e): e is Extract<typeof e, { type: "user_message" }> => e.type === "user_message");
    expect(users).toHaveLength(2);
    expect("origin" in users[0]!).toBe(false); // 缺席 = 人发的
    expect("backgroundTaskIds" in users[0]!).toBe(false);
    expect(users[1]!.origin).toBe("background");
    // 驮的是哪几个任务也记在事件上(issue #452 / ADR-0109)：面板据此知道
    // 结果真的进了对话，不用去正文里认 `[后台任务 bg-N 完成]` 那个前缀
    expect(users[1]!.backgroundTaskIds).toEqual(["bg-1"]);
  });
});

describe("工具表按 turn 重算（MCP server 中途连上要能用）", () => {
  // 假工具跑起来时是否触发钩子——用来模拟"provider 的返回值在工具执行期间被改掉"
  let onToolRunHook: (() => void) | undefined;
  // 假 adapter 每次 chat() 收到的 tools 参数的 name 列表，按调用顺序累积
  let lastSeenTools: string[][] = [];
  let currentStore: EventStore | null = null;
  // engine → 它那份 deferredExposed 活 Set 的映射，供 exposeDeferred 找到写入口
  const deferredSets = new WeakMap<LoopEngine, Set<string>>();

  function fakeTool(name: string, extra: Partial<Tool> = {}): Tool {
    return {
      def: { name, description: "", parameters: { type: "object", properties: {} } },
      requiresApproval: false,
      run: async () => {
        onToolRunHook?.();
        return `${name} ran`;
      },
      ...extra,
    };
  }

  /** 假 adapter 最后一次 chat() 收到的 tools 参数的 name 列表 */
  function lastToolDefs(): string[] {
    return lastSeenTools.at(-1) ?? [];
  }

  /** 日志里最后一条 tool_result 的 status */
  function lastToolResultStatus(): string | undefined {
    if (!currentStore) return undefined;
    const events = currentStore.load("s1");
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === "tool_result") return e.status;
    }
    return undefined;
  }

  /** 模拟 tool_search 命中：把工具名写进这个 engine 的 deferredExposed */
  function exposeDeferred(engine: LoopEngine, name: string): void {
    deferredSets.get(engine)?.add(name);
  }

  function makeEngine(opts: {
    tools: Tool[] | (() => Tool[]);
    /** 工具执行期间的回调——用来在"上一圈工具正在跑"时改掉 provider 的返回值 */
    onToolRun?: () => void;
    /** 不给 = 每次 chat() 都直接收口（不调工具）；给了就按脚本走，用完再调报错 */
    replies?: { text?: string; toolCalls?: { id: string; name: string; args: unknown }[] }[];
  }): LoopEngine {
    onToolRunHook = opts.onToolRun;
    const seenTools: string[][] = [];
    lastSeenTools = seenTools;
    let i = 0;
    const script = opts.replies;
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(_messages, tools) {
        seenTools.push((tools ?? []).map((t) => t.name));
        if (!script) return { content: "" };
        const r = script[i++];
        if (!r) throw new Error("脚本用完了还在调");
        return { content: r.text ?? "", ...(r.toolCalls ? { toolCalls: r.toolCalls } : {}) };
      },
    };
    const store = new EventStore(":memory:");
    currentStore = store;
    const deferredExposed = new Set<string>();
    const engine = new LoopEngine({
      store,
      adapter,
      tools: opts.tools,
      world: fakeWorld,
      sessionId: "s1",
      deferredExposed,
    });
    deferredSets.set(engine, deferredExposed);
    return engine;
  }

  it("传数组时行为与从前一致", async () => {
    const engine = makeEngine({ tools: [fakeTool("a")] });
    await engine.runTurn("用 a");
    expect(lastToolDefs()).toEqual(["a"]);
  });

  it("turn 之间工具表会跟着 provider 变", async () => {
    let live = [fakeTool("a")];
    const engine = makeEngine({ tools: () => live });
    await engine.runTurn("第一轮");
    expect(lastToolDefs()).toEqual(["a"]);
    live = [fakeTool("a"), fakeTool("mcp__supabase__list_tables")];
    await engine.runTurn("第二轮");
    expect(lastToolDefs()).toEqual(["a", "mcp__supabase__list_tables"]);
  });

  it("turn 之内不变——模型按这一轮的声明表发调用，中途换表会变成「未知工具」", async () => {
    // 用两次工具调用而不是一次：第一版用例只调了一次 a，onToolRunHook 在 run()
    // 里触发时查表早已发生，"构造时冻结"/"每 turn 重算"/"每圈重算"三种实现下
    // 结果都是 "ok"——那条用例其实是永真式，验证不了 turn 内冻结。这里让模型
    // 在第二圈再调一次同一把刀：只有"每 turn 重算"才会让第二圈仍查到 [a]；
    // 若代码退化成"每圈重算"，第二圈会看到空表，查不到 a → "未知工具"
    let live = [fakeTool("a")];
    const engine = makeEngine({
      tools: () => live,
      // 第一圈工具执行期间 provider 的返回值被改掉（第二圈 onToolRun 再触发一次
      // 也无害——live 已经是空数组，重复清空是幂等的）
      onToolRun: () => {
        live = [];
      },
      // 三圈：圈 1 调 a，圈 2 再调一次同一把刀，圈 3 收口
      replies: [
        { toolCalls: [{ id: "1", name: "a", args: {} }] },
        { toolCalls: [{ id: "2", name: "a", args: {} }] },
        { text: "好了" },
      ],
    });
    await expect(engine.runTurn("跑一下")).resolves.not.toThrow();
    const statuses = currentStore!
      .load("s1")
      .filter((e): e is Extract<typeof e, { type: "tool_result" }> => e.type === "tool_result")
      .map((e) => e.status);
    expect(statuses).toEqual(["ok", "ok"]); // 两次调用都查到了同一份 turn 内冻结的表，不是 "error: 未知工具"
  });

  it("撞名保护每轮都生效：后到的同名工具照旧被拒", async () => {
    const engine = makeEngine({ tools: () => [fakeTool("a"), fakeTool("a")] });
    await engine.runTurn("一轮");
    expect(lastToolDefs()).toEqual(["a"]);
  });

  it("deferred 已暴露的集合跨轮存活——搜出来的刀不该因为重算又缩回去", async () => {
    const engine = makeEngine({
      tools: () => [fakeTool("a"), { ...fakeTool("deep"), exposure: "deferred" as const }],
    });
    await engine.runTurn("第一轮");
    expect(lastToolDefs()).not.toContain("deep");
    exposeDeferred(engine, "deep"); // 模拟 tool_search 命中
    await engine.runTurn("第二轮");
    expect(lastToolDefs()).toContain("deep");
  });
});


describe("LoopEngine —— 中间件给的行数账落进 tool_result（ADR-0141）", () => {
  it("outcome.diffStat 原样进日志:时间线上历史工具组的 +N/−M 只能从这儿来", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = fakeAdapter([
      { content: "", toolCalls: [{ id: "c1", name: "read_file", args: { path: "/a.txt" } }] },
      { content: "好了" },
    ]);
    const engine = new LoopEngine({
      store,
      adapter,
      tools: [readFileTool],
      world: fakeWorld,
      sessionId: "s1",
      middlewares: [
        async (_ctx, next) => ({ ...(await next()), diffStat: { additions: 24, deletions: 6 } }),
      ],
    });
    await engine.runTurn("走一趟");

    const result = store.load("s1").find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ diffStat: { additions: 24, deletions: 6 } });
  });

  it("中间件没给就不写这个键:旧日志和新日志里的「没有账」长得一样", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = fakeAdapter([
      { content: "", toolCalls: [{ id: "c1", name: "read_file", args: { path: "/a.txt" } }] },
      { content: "好了" },
    ]);
    const engine = new LoopEngine({
      store,
      adapter,
      tools: [readFileTool],
      world: fakeWorld,
      sessionId: "s1",
    });
    await engine.runTurn("走一趟");

    const result = store.load("s1").find((e) => e.type === "tool_result");
    expect(result).not.toHaveProperty("diffStat");
  });
});
