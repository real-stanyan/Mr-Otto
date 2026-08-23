import { describe, it, expect } from "vitest";
import { DEFAULT_COMPRESSION, deriveMessages } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

// 信封字段工厂：测试里只关心 payload，信封统一生成
let seq = 0;
function env() {
  return { seq: seq++, sessionId: "s1", ts: 1700000000000 };
}

describe("deriveMessages", () => {
  it("拒绝流：审批事件被丢弃，denied 结果作为 tool 消息可见", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "session_created", title: "test" },
      { ...env(), type: "model_changed", provider: "deepseek", model: "deepseek-v4-pro" },
      { ...env(), type: "user_message", content: "删掉 /tmp/x" },
      {
        ...env(),
        type: "assistant_message",
        content: "",
        model: "deepseek-v4-pro",
        toolCalls: [{ id: "call_1", name: "bash", args: { cmd: "rm /tmp/x" } }],
      },
      { ...env(), type: "approval_decision", toolCallId: "call_1", decision: "denied", reason: "危险" },
      { ...env(), type: "tool_result", toolCallId: "call_1", status: "denied", output: "用户拒绝了此操作：危险" },
    ];

    const messages = deriveMessages(events);

    expect(messages).toEqual([
      { role: "user", content: "删掉 /tmp/x" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"rm /tmp/x"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "用户拒绝了此操作：危险" },
    ]);
  });

  it("无工具调用的回复不带 tool_calls 字段", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "user_message", content: "你好" },
      { ...env(), type: "assistant_message", content: "你好！", model: "deepseek-v4-pro" },
    ];

    const messages = deriveMessages(events);
    expect(messages[1]).toEqual({ role: "assistant", content: "你好！" });
    expect(messages[1]).not.toHaveProperty("tool_calls");
  });

  it("纯函数：同样输入两次调用结果一致", () => {
    const events: SessionEvent[] = [{ ...env(), type: "user_message", content: "hi" }];
    expect(deriveMessages(events)).toEqual(deriveMessages(events));
  });

  it("session_created 带 workspace → 投影成打头的 system 消息", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "session_created", workspace: "/Users/x/proj" },
      { ...env(), type: "user_message", content: "hi" },
    ];

    const messages = deriveMessages(events);
    expect(messages[0]).toMatchObject({ role: "system" });
    expect((messages[0] as { content: string }).content).toContain("/Users/x/proj");
    expect(messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("session_created 不带 workspace（旧日志）→ 投影和从前一样没有 system 消息", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "session_created", title: "老会话" },
      { ...env(), type: "user_message", content: "hi" },
    ];

    expect(deriveMessages(events)).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("deriveMessages 上下文压缩", () => {
  const OPTS = { keepRecentTurns: 2, maxOldToolOutputChars: 50, maxOldToolArgChars: 60 };
  const LONG = "x".repeat(200); // 超上限的工具输出
  const toolTurn = (n: number, output: string): SessionEvent[] => [
    { ...env(), type: "user_message", content: `问题${n}` },
    {
      ...env(),
      type: "assistant_message",
      content: "",
      model: "m",
      toolCalls: [{ id: `call_${n}`, name: "bash", args: { cmd: "ls" } }],
    },
    { ...env(), type: "tool_result", toolCallId: `call_${n}`, status: "ok", output },
    { ...env(), type: "assistant_message", content: `答案${n}`, model: "m" },
  ];
  // 3 个 turn：turn1 = 老区（可压缩），turn2 / turn3 = 保真区
  const events: SessionEvent[] = [...toolTurn(1, LONG), ...toolTurn(2, LONG), ...toolTurn(3, LONG)];

  it("不传 opts = 不压缩：与旧行为逐字节一致（向后兼容）", () => {
    const plain = deriveMessages(events);
    expect(plain.filter((m) => m.role === "tool").every((m) => m.content === LONG)).toBe(true);
  });

  it("老 turn 的长输出截断且带原始长度标记；最近 K 个 turn 原文保真", () => {
    const msgs = deriveMessages(events, OPTS);
    const tools = msgs.filter((m) => m.role === "tool");
    expect(tools[0]!.content).toContain("[上下文压缩：工具输出原 200 字符");
    expect(tools[0]!.content.startsWith("x".repeat(50))).toBe(true);
    expect(tools[1]!.content).toBe(LONG); // turn2 起进保真区
    expect(tools[2]!.content).toBe(LONG);
  });

  it("只瘦内容不动结构：消息数量与 tool_call_id 配对与未压缩完全一致", () => {
    const plain = deriveMessages(events);
    const compressed = deriveMessages(events, OPTS);
    expect(compressed.length).toBe(plain.length);
    expect(compressed.map((m) => (m.role === "tool" ? m.tool_call_id : m.role))).toEqual(
      plain.map((m) => (m.role === "tool" ? m.tool_call_id : m.role))
    );
  });

  it("老区的短输出不动：低于上限没有折叠的必要", () => {
    const short: SessionEvent[] = [...toolTurn(1, "短输出"), ...toolTurn(2, LONG), ...toolTurn(3, LONG)];
    const tools = deriveMessages(short, OPTS).filter((m) => m.role === "tool");
    expect(tools[0]!.content).toBe("短输出"); // 无标记、无截断
  });

  it("user_message 不足 K 个 = 全部保真（新会话永不压缩）", () => {
    const one = toolTurn(1, LONG);
    const tools = deriveMessages(one, OPTS).filter((m) => m.role === "tool");
    expect(tools[0]!.content).toBe(LONG);
  });

  it("确定性：同 events 同 opts 两次投影深等——重放的根基", () => {
    expect(deriveMessages(events, OPTS)).toEqual(deriveMessages(events, OPTS));
  });

  // 回归锚：这条曾经是一次真实的 400。压缩把序列化后的 JSON 从中间砍断，
  // 本机 Ollama 严格解析 arguments，当场回 invalid tool call arguments；
  // DeepSeek / GLM 恰好容忍，所以它藏了很久。
  it("折叠后的 tool_calls.arguments 永远是合法 JSON，且参数名保得住", () => {
    const fat = { path: "/tmp/a.md", content: "字".repeat(2000) };
    const evts: SessionEvent[] = [
      { ...env(), type: "user_message", content: "写文件" },
      {
        ...env(),
        type: "assistant_message",
        content: "",
        model: "m",
        toolCalls: [{ id: "c1", name: "write_file", args: fat }],
      },
      { ...env(), type: "tool_result", toolCallId: "c1", status: "ok", output: "ok" },
      ...toolTurn(2, "短"),
      ...toolTurn(3, "短"),
    ];
    const msgs = deriveMessages(evts, { ...OPTS, maxOldToolArgChars: 400 });
    const asst = msgs.find((m) => m.role === "assistant" && m.tool_calls) as {
      tool_calls: { function: { arguments: string } }[];
    };
    const args = asst.tool_calls[0]!.function.arguments;

    expect(() => JSON.parse(args)).not.toThrow();
    const parsed = JSON.parse(args) as Record<string, unknown>;
    // 折叠在值上做，所以结构还在：模型仍看得出这次调用动的是哪个文件
    expect(parsed["path"]).toBe("/tmp/a.md");
    expect(String(parsed["content"])).toContain("上下文压缩");
    expect(args.length).toBeLessThan(JSON.stringify(fat).length);
  });

  it("老 turn 的长工具参数截断带标记；保真区参数原文——write_file 的 content 不再永远躺在历史里", () => {
    const bigArgs = { path: "a.txt", content: "长".repeat(100) };
    const argTurn = (n: number): SessionEvent[] => [
      { ...env(), type: "user_message", content: `问题${n}` },
      {
        ...env(),
        type: "assistant_message",
        content: "",
        model: "m",
        toolCalls: [{ id: `call_${n}`, name: "write_file", args: bigArgs }],
      },
      { ...env(), type: "tool_result", toolCallId: `call_${n}`, status: "ok", output: "写好" },
    ];
    const evts: SessionEvent[] = [...argTurn(1), ...argTurn(2), ...argTurn(3)];
    const asst = deriveMessages(evts, OPTS).filter((m) => m.role === "assistant");

    const oldArgs = asst[0]!.tool_calls![0]!.function.arguments;
    // 不变量比文案重要：折叠后仍必须是**合法 JSON**。
    // OpenAI 方言规定 arguments 是 JSON 字符串，严格的服务端（Ollama）会当场解析，
    // 从中间砍断换来的是 400 invalid tool call arguments
    expect(() => JSON.parse(oldArgs)).not.toThrow();
    expect(oldArgs).toContain("上下文压缩");
    expect(oldArgs.length).toBeLessThan(JSON.stringify(bigArgs).length);
    // turn2 起进保真区：逐字节原文
    expect(asst[1]!.tool_calls![0]!.function.arguments).toBe(JSON.stringify(bigArgs));
    expect(asst[2]!.tool_calls![0]!.function.arguments).toBe(JSON.stringify(bigArgs));
  });

  it("压缩永不增肥：刚过上限的文本（截断+标记反而更长）原样放行", () => {
    const barely = "x".repeat(55); // 超过 50 上限，但截到 50 加约 40 字符标记会更长
    const evts: SessionEvent[] = [...toolTurn(1, barely), ...toolTurn(2, LONG), ...toolTurn(3, LONG)];
    const tools = deriveMessages(evts, OPTS).filter((m) => m.role === "tool");
    expect(tools[0]!.content).toBe(barely); // 原样，无标记
  });

  it("keepRecentTurns: 0 = 无保真区：连最后一个 turn 也压——compact 摘要档的地基", () => {
    const opts = { keepRecentTurns: 0, maxOldToolOutputChars: 50, maxOldToolArgChars: 60 };
    const one = toolTurn(1, LONG); // 只有一个 turn，K=2 时它是保真区
    const tools = deriveMessages(one, opts).filter((m) => m.role === "tool");
    expect(tools[0]!.content).toContain("[上下文压缩：工具输出原 200 字符");
  });
});

describe("deriveMessages context_compacted", () => {
  const base: SessionEvent[] = [
    { ...env(), type: "session_created", workspace: "/proj" },
    { ...env(), type: "user_message", content: "原文问题" },
    { ...env(), type: "assistant_message", content: "原文回答", model: "m" },
    { ...env(), type: "context_compacted", summary: "一句话摘要", model: "m" },
    { ...env(), type: "user_message", content: "压缩后的新问题" },
  ];

  it("摘要替换此前一切；围栏 system 消息幸存；之后事件照常", () => {
    const msgs = deriveMessages(base);
    expect(msgs).toHaveLength(3); // system + 摘要 + 新问题
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain("/proj"); // 工作目录认知没被压掉
    expect(msgs[1]!.role).toBe("user");
    expect(msgs[1]!.content).toContain("一句话摘要");
    expect(msgs[2]).toEqual({ role: "user", content: "压缩后的新问题" });
    // 原文彻底离开模型视野
    expect(msgs.some((m) => typeof m.content === "string" && m.content.includes("原文问题"))).toBe(false);
  });

  // issue #193：auto-compact 发生在 turn 中途时，正在处理的 user_message 随历史
  // 被折进摘要，此前只靠提示词求摘要模型「逐字保留」。投影兜底：compact 之后
  // 还没有新 user_message（= 被折的那条就是当前请求）时，把它原文重注
  it("compact 之后还没有新 user_message：最后一条 user 原文重注在摘要后", () => {
    const midTurn = base.slice(0, 4); // created, user, assistant, compact——auto 截胡当前请求
    const msgs = deriveMessages(midTurn);
    expect(msgs).toHaveLength(3); // system + 摘要 + 当前请求原文
    expect(msgs[2]!.role).toBe("user");
    expect(msgs[2]!.content).toContain("原文问题");
    // 有了更新的 user_message 就不再重注（base 全量：新问题顶上，旧请求已是历史）
    const after = deriveMessages(base);
    expect(after.some((m) => typeof m.content === "string" && m.content.includes("原文问题"))).toBe(false);
  });

  it("二次 compact 复合：只剩最新摘要", () => {
    const twice: SessionEvent[] = [
      ...base,
      { ...env(), type: "context_compacted", summary: "第二份摘要", model: "m" },
    ];
    const msgs = deriveMessages(twice);
    expect(msgs.some((m) => typeof m.content === "string" && m.content.includes("第二份摘要"))).toBe(true);
    expect(msgs.some((m) => typeof m.content === "string" && m.content.includes("一句话摘要"))).toBe(false);
  });

  it("usage 是账单不是内容：不进模型视野", () => {
    const withUsage: SessionEvent[] = [
      { ...env(), type: "user_message", content: "hi" },
      { ...env(), type: "assistant_message", content: "答", model: "m", usage: { promptTokens: 9, completionTokens: 1 } },
    ];
    expect(deriveMessages(withUsage)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "答" },
    ]);
  });

  it("reasoning 落盘但不进模型视野：API 禁止思考回流上下文（塞了 400）", () => {
    const withReasoning: SessionEvent[] = [
      { ...env(), type: "user_message", content: "hi" },
      { ...env(), type: "assistant_message", content: "答", model: "m", reasoning: "先想想……" },
    ];
    expect(deriveMessages(withReasoning)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "答" },
    ]);
  });
});

describe("lifecycle 事件对投影隐形（ADR-0004）", () => {
  it("同一段日志加不加 lifecycle 事件，投影逐字节一致", () => {
    const base: SessionEvent[] = [
      { seq: 0, sessionId: "s", ts: 1, type: "session_created", workspace: "/w" },
      { seq: 1, sessionId: "s", ts: 2, type: "user_message", content: "写个文件" },
      {
        seq: 2, sessionId: "s", ts: 3, type: "assistant_message", model: "m", content: "",
        toolCalls: [{ id: "c1", name: "write_file", args: { path: "a.txt", content: "hi" } }],
      },
      { seq: 3, sessionId: "s", ts: 4, type: "tool_result", toolCallId: "c1", status: "ok", output: "已写入" },
      { seq: 4, sessionId: "s", ts: 5, type: "assistant_message", model: "m", content: "写好了" },
    ];
    const withLifecycle: SessionEvent[] = [
      base[0]!, base[1]!, base[2]!,
      { seq: 5, sessionId: "s", ts: 3, type: "tool_execution_started", toolCallId: "c1" },
      base[3]!, base[4]!,
      { seq: 6, sessionId: "s", ts: 6, type: "turn_ended", outcome: "completed" },
      { seq: 7, sessionId: "s", ts: 7, type: "turn_ended", outcome: "error", error: "假装炸了" },
      { seq: 8, sessionId: "s", ts: 8, type: "turn_ended", outcome: "aborted" }, // ADR-0006 加宽
      { seq: 9, sessionId: "s", ts: 9, type: "session_renamed", title: "改了名" }, // /rename：模型不消费
      // 跟进建议：给人点的快捷键，喂回去等于让模型读自己上一轮的猜测再基于它猜
      { seq: 10, sessionId: "s", ts: 10, type: "suggestions_generated", suggestions: ["跑一下测试"], model: "glm-4.5-flash" },
    ];

    expect(JSON.stringify(deriveMessages(withLifecycle))).toBe(JSON.stringify(deriveMessages(base)));
  });
});

describe("悬空工具调用自愈（ADR-0005 保命层）", () => {
  const dangling = (withStarted: boolean): SessionEvent[] => [
    { seq: 0, sessionId: "s", ts: 1, type: "user_message", content: "跑个命令" },
    {
      seq: 1, sessionId: "s", ts: 2, type: "assistant_message", model: "m", content: "",
      toolCalls: [{ id: "c1", name: "bash", args: { cmd: "sleep 99" } }],
    },
    ...(withStarted
      ? [{ seq: 2, sessionId: "s", ts: 3, type: "tool_execution_started", toolCallId: "c1" } as SessionEvent]
      : []),
    // 崩溃：没有 tool_result，下一 turn 的输入直接跟上
    { seq: 3, sessionId: "s", ts: 9, type: "user_message", content: "还在吗" },
  ];

  it("悬空调用就地合成占位 tool 消息：紧跟 assistant，配对合法", () => {
    const msgs = deriveMessages(dangling(true));
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    const tool = msgs[2] as { tool_call_id: string; content: string };
    expect(tool.tool_call_id).toBe("c1");
    expect(tool.content).toContain("世界可能已被部分变更");
  });

  it("没有 started 的悬空调用：文案说清执行器未达", () => {
    const msgs = deriveMessages(dangling(false));
    const tool = msgs[2] as { content: string };
    expect(tool.content).toContain("世界未被此调用变更");
  });

  it("配对完好的日志：自愈层一根手指都不动", () => {
    const healthy: SessionEvent[] = [
      { seq: 0, sessionId: "s", ts: 1, type: "user_message", content: "跑" },
      {
        seq: 1, sessionId: "s", ts: 2, type: "assistant_message", model: "m", content: "",
        toolCalls: [{ id: "c1", name: "bash", args: { cmd: "ls" } }],
      },
      { seq: 2, sessionId: "s", ts: 3, type: "tool_result", toolCallId: "c1", status: "ok", output: "a.txt" },
      { seq: 3, sessionId: "s", ts: 4, type: "assistant_message", model: "m", content: "有 a.txt" },
    ];
    expect(deriveMessages(healthy).map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });
});

describe("skill_invoked（$ 指令的注入投影）", () => {
  it("投影成 user 消息：名字 + 全文快照，位置在任务消息之前", () => {
    const events: SessionEvent[] = [
      { seq: 0, sessionId: "s", ts: 1, type: "skill_invoked", name: "tdd", content: "先写测试再写实现" },
      { seq: 1, sessionId: "s", ts: 2, type: "user_message", content: "实现登录" },
    ];
    const msgs = deriveMessages(events);
    expect(msgs.map((m) => m.role)).toEqual(["user", "user"]);
    const skill = msgs[0] as { content: string };
    expect(skill.content).toContain("「tdd」");
    expect(skill.content).toContain("先写测试再写实现");
    expect(msgs[1]).toEqual({ role: "user", content: "实现登录" });
  });

  it("args 进投影头；没有 args 的旧事件投影头不变", () => {
    const events: SessionEvent[] = [
      { seq: 0, sessionId: "s", ts: 1, type: "skill_invoked", name: "ponytail", content: "越少越好", args: "ultra" },
      { seq: 1, sessionId: "s", ts: 2, type: "skill_invoked", name: "tdd", content: "先写测试" },
      { seq: 2, sessionId: "s", ts: 3, type: "user_message", content: "干活" },
    ];
    const msgs = deriveMessages(events);
    expect((msgs[0] as { content: string }).content).toContain("「ponytail」（参数：ultra）");
    // 无 args：旧日志的投影逐字节不变（向后兼容钉住）
    expect((msgs[1] as { content: string }).content).toContain("[本轮启用 skill「tdd」，以下是它的指令");
  });

  // issue #214：此前 compact 清场把 skill 指令连历史一起抹掉——用户没说停，
  // 技能却无声失效。现在清场后按台账重注入（纯投影，快照来自日志里的事件）
  it("compact 清场后已启用的 skill 重注入：摘要之后、当前请求兜底之前，带 args", () => {
    const events: SessionEvent[] = [
      { seq: 0, sessionId: "s", ts: 1, type: "skill_invoked", name: "tdd", content: "长指令", args: "strict" },
      { seq: 1, sessionId: "s", ts: 2, type: "user_message", content: "干活" },
      { seq: 2, sessionId: "s", ts: 3, type: "context_compacted", summary: "都干完了", model: "m" },
    ];
    const msgs = deriveMessages(events);
    // 摘要 + skill 重注入 + 当前请求兜底（issue #193）
    expect(msgs.map((m) => m.role)).toEqual(["user", "user", "user"]);
    expect((msgs[0] as { content: string }).content).toContain("都干完了");
    const re = (msgs[1] as { content: string }).content;
    expect(re).toContain("「tdd」（参数：strict）在压缩前已启用，仍然生效");
    expect(re).toContain("长指令");
    expect((msgs[2] as { content: string }).content).toContain("干活");
  });

  it("同名多次启用去重，后启用的快照覆盖先启用的", () => {
    const events: SessionEvent[] = [
      { seq: 0, sessionId: "s", ts: 1, type: "skill_invoked", name: "tdd", content: "旧版指令" },
      { seq: 1, sessionId: "s", ts: 2, type: "user_message", content: "活一" },
      { seq: 2, sessionId: "s", ts: 3, type: "skill_invoked", name: "tdd", content: "新版指令" },
      { seq: 3, sessionId: "s", ts: 4, type: "user_message", content: "活二" },
      { seq: 4, sessionId: "s", ts: 5, type: "context_compacted", summary: "摘要", model: "m" },
    ];
    const msgs = deriveMessages(events);
    const reinjected = msgs.filter(
      (m) => typeof m.content === "string" && m.content.includes("在压缩前已启用")
    );
    expect(reinjected).toHaveLength(1);
    expect((reinjected[0] as { content: string }).content).toContain("新版指令");
    expect(msgs.some((m) => typeof m.content === "string" && m.content.includes("旧版指令"))).toBe(false);
  });

  it("二次 compact：压缩后新启用的 skill 也进下一轮台账，与旧 skill 一起重注入", () => {
    const events: SessionEvent[] = [
      { seq: 0, sessionId: "s", ts: 1, type: "skill_invoked", name: "tdd", content: "先写测试" },
      { seq: 1, sessionId: "s", ts: 2, type: "user_message", content: "活一" },
      { seq: 2, sessionId: "s", ts: 3, type: "context_compacted", summary: "摘要一", model: "m" },
      { seq: 3, sessionId: "s", ts: 4, type: "skill_invoked", name: "ponytail", content: "越少越好" },
      { seq: 4, sessionId: "s", ts: 5, type: "user_message", content: "活二" },
      { seq: 5, sessionId: "s", ts: 6, type: "context_compacted", summary: "摘要二", model: "m" },
    ];
    const msgs = deriveMessages(events);
    const reinjected = msgs
      .filter((m) => typeof m.content === "string" && m.content.includes("在压缩前已启用"))
      .map((m) => m.content as string);
    expect(reinjected).toHaveLength(2);
    expect(reinjected.some((c) => c.includes("先写测试"))).toBe(true);
    expect(reinjected.some((c) => c.includes("越少越好"))).toBe(true);
    // 只剩最新摘要（复合语义不受重注入影响）
    expect(msgs.some((m) => typeof m.content === "string" && m.content.includes("摘要一"))).toBe(false);
  });
});

describe("user_message 附件投影(file-input-v1)", () => {
  it("带 attachments → content 变 parts:[text, ...image_ref]", () => {
    const events: SessionEvent[] = [
      {
        seq: 1, sessionId: "s", ts: 1, type: "user_message", content: "看看这张图",
        attachments: [{ id: "sha256:" + "a".repeat(64), mediaType: "image/png", bytes: 10, name: "cat.png" }],
      },
    ];
    const out = deriveMessages(events);
    expect(out).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "看看这张图" },
          { type: "image_ref", id: "sha256:" + "a".repeat(64), mediaType: "image/png" },
        ],
      },
    ]);
  });

  it("attachments 空数组 = 无附件,content 保持 string", () => {
    const events: SessionEvent[] = [
      { seq: 1, sessionId: "s", ts: 1, type: "user_message", content: "hi", attachments: [] },
    ];
    expect(deriveMessages(events)).toEqual([{ role: "user", content: "hi" }]);
  });

  it("无 attachments 字段投影与从前逐字节一致(老日志回归)", () => {
    const events: SessionEvent[] = [
      { seq: 1, sessionId: "s", ts: 1, type: "user_message", content: "老消息" },
    ];
    expect(deriveMessages(events)).toEqual([{ role: "user", content: "老消息" }]);
  });

  it("带 textFiles → 全文拼进模型可见文本(content 里存的是纯正文)", () => {
    const events: SessionEvent[] = [
      {
        seq: 1, sessionId: "s", ts: 1, type: "user_message", content: "总结这个文件",
        textFiles: [{ name: "notes.txt", content: "第一行\n第二行", bytes: 16 }],
      },
    ];
    expect(deriveMessages(events)).toEqual([
      {
        role: "user",
        content: "总结这个文件\n\n[用户附上文件「notes.txt」,内容如下]\n第一行\n第二行",
      },
    ]);
  });

  it("textFiles + 图片 attachments 并存 → text part 是拼好的全文", () => {
    const events: SessionEvent[] = [
      {
        seq: 1, sessionId: "s", ts: 1, type: "user_message", content: "对照图和文件",
        attachments: [{ id: "sha256:" + "b".repeat(64), mediaType: "image/jpeg", bytes: 5 }],
        textFiles: [{ name: "a.md", content: "# 标题", bytes: 8 }],
      },
    ];
    expect(deriveMessages(events)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "对照图和文件\n\n[用户附上文件「a.md」,内容如下]\n# 标题" },
          { type: "image_ref", id: "sha256:" + "b".repeat(64), mediaType: "image/jpeg" },
        ],
      },
    ]);
  });
});

describe("image_described 投影(vision-bridge)", () => {
  it("注入为 user 文本,标明代读来源;位置就是事件位置", () => {
    const events: SessionEvent[] = [
      {
        seq: 1, sessionId: "s", ts: 1, type: "image_described",
        content: "图里是一只像素风水獭", model: "glm-4.6v-flash",
      },
      { seq: 2, sessionId: "s", ts: 2, type: "user_message", content: "这是什么" },
    ];
    const out = deriveMessages(events);
    expect(out).toEqual([
      {
        role: "user",
        content:
          "[以下是随后消息附带图片的解析,由视觉模型 glm-4.6v-flash 代读——当前模型不支持直接看图]\n图里是一只像素风水獭",
      },
      { role: "user", content: "这是什么" },
    ]);
  });
});

describe("section_classified 不进模型上下文", () => {
  // 分区事件插在**中间**、且带压缩选项跑（issue #112）：都放在日志尾巴 + 不传
  // 压缩的话，这条测试演示不了它要钉的性质——fidelityBoundary 是同一个数组里的
  // 位置计算，多插两条事件会把保真区的边界推走，尾部的分区事件推不动它
  const turn = (n: number): SessionEvent[] => [
    { seq: n * 10 + 1, sessionId: "s", ts: n * 10 + 1, type: "user_message", content: `问题${n}` },
    {
      seq: n * 10 + 2, sessionId: "s", ts: n * 10 + 2, type: "assistant_message", content: "",
      model: "m", toolCalls: [{ id: `t${n}`, name: "read_file", args: { path: `${n}.ts` } }],
    },
    { seq: n * 10 + 3, sessionId: "s", ts: n * 10 + 3, type: "tool_result", toolCallId: `t${n}`, status: "ok", output: "x".repeat(5000) },
    { seq: n * 10 + 4, sessionId: "s", ts: n * 10 + 4, type: "assistant_message", content: `答案${n}`, model: "m" },
  ];
  const base: SessionEvent[] = [
    { seq: 0, sessionId: "s", ts: 1, type: "session_created", workspace: "/w" },
    ...turn(1), ...turn(2), ...turn(3),
  ];
  const section = (seq: number, title: string | null): SessionEvent =>
    ({ seq, sessionId: "s", ts: seq, type: "section_classified", title, model: "c" });
  // 夹在第一个 turn 之后、第二个 turn 之前 —— 正好落在老区和保真区之间
  const withSections: SessionEvent[] = [
    ...base.slice(0, 5),
    section(15, "第一段"),
    section(16, null),
    ...base.slice(5),
  ];

  it("插在中间的分区事件，投影逐字节等于没有它时的投影（不压缩）", () => {
    expect(JSON.stringify(deriveMessages(withSections))).toBe(JSON.stringify(deriveMessages(base)));
  });

  it("带压缩选项也一样：分区事件不该把保真区的边界推走", () => {
    expect(JSON.stringify(deriveMessages(withSections, DEFAULT_COMPRESSION))).toBe(
      JSON.stringify(deriveMessages(base, DEFAULT_COMPRESSION))
    );
  });
});

describe("什么也没产出的 turn 不进上下文（ADR-0042）", () => {
  it("失败重试三次只留成功那一份 —— 而不是同一句话喂给模型四遍", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "user_message", content: "收到这个文件说一个字「收」就行",
        textFiles: [{ name: "a.json", content: "{}", bytes: 2 }] },
      { ...env(), type: "turn_ended", outcome: "aborted" },
      { ...env(), type: "user_message", content: "收到这个文件说一个字「收」就行",
        textFiles: [{ name: "a.json", content: "{}", bytes: 2 }] },
      { ...env(), type: "turn_ended", outcome: "error", error: "model API 429: …" },
      { ...env(), type: "user_message", content: "收到这个文件说一个字「收」就行",
        textFiles: [{ name: "a.json", content: "{}", bytes: 2 }] },
      { ...env(), type: "assistant_message", content: "收", model: "glm-4.5-flash" },
      { ...env(), type: "turn_ended", outcome: "completed" },
    ];

    const messages = deriveMessages(events);

    expect(messages).toEqual([
      {
        role: "user",
        content: "收到这个文件说一个字「收」就行\n\n[用户附上文件「a.json」,内容如下]\n{}",
      },
      { role: "assistant", content: "收" },
    ]);
  });

  it("失败但产出过的 turn 照旧留着：半截对话也是对话", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "user_message", content: "读一下 a.txt" },
      {
        ...env(), type: "assistant_message", content: "", model: "m",
        toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }],
      },
      { ...env(), type: "tool_result", toolCallId: "c1", status: "ok", output: "hi" },
      { ...env(), type: "turn_ended", outcome: "aborted" },
    ];

    expect(deriveMessages(events).map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  });

  it("跳掉的消息带着它那条图片代读一起走 —— 不留一句悬空的「随后那条消息的图」", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "image_described", content: "一只水獭", model: "v" },
      { ...env(), type: "user_message", content: "这是什么" },
      { ...env(), type: "turn_ended", outcome: "error", error: "model API 429: …" },
      { ...env(), type: "user_message", content: "这是什么" },
      { ...env(), type: "assistant_message", content: "水獭", model: "m" },
      { ...env(), type: "turn_ended", outcome: "completed" },
    ];

    expect(deriveMessages(events)).toEqual([
      { role: "user", content: "这是什么" },
      { role: "assistant", content: "水獭" },
    ]);
  });
});

describe("保真区名额不算空跑（ADR-0042 × 压缩）", () => {
  it("尾部 真/空跑/真：倒数第 2 轮真实对话的工具输出不被截断", () => {
    seq = 0;
    const long = "y".repeat(3000);
    const events: SessionEvent[] = [
      { ...env(), type: "session_created", workspace: "/w" },
      { ...env(), type: "user_message", content: "u1" },
      { ...env(), type: "assistant_message", content: "", model: "m", toolCalls: [{ id: "c1", name: "bash", args: {} }] },
      { ...env(), type: "tool_result", toolCallId: "c1", status: "ok", output: long },
      { ...env(), type: "turn_ended", outcome: "completed" },
      { ...env(), type: "user_message", content: "u2" },
      { ...env(), type: "assistant_message", content: "", model: "m", toolCalls: [{ id: "c2", name: "bash", args: {} }] },
      { ...env(), type: "tool_result", toolCallId: "c2", status: "ok", output: long },
      { ...env(), type: "turn_ended", outcome: "completed" },
      { ...env(), type: "user_message", content: "u3-barren" },
      { ...env(), type: "turn_ended", outcome: "aborted" },
      { ...env(), type: "user_message", content: "u4" },
      { ...env(), type: "assistant_message", content: "a4", model: "m" },
    ];
    const msgs = deriveMessages(events, { keepRecentTurns: 2, maxOldToolOutputChars: 400, maxOldToolArgChars: 400 });
    const tools = msgs.filter((m) => m.role === "tool");
    expect(tools[0]!.content.length).toBeLessThan(long.length); // u1 在老区，截断
    expect(tools[1]!.content).toBe(long); // u2 是倒数第 2 轮真实对话，保真
  });
});
