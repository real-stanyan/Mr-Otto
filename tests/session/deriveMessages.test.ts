import { describe, it, expect } from "vitest";
import { deriveMessages } from "../../src/session/deriveMessages.js";
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
    expect(oldArgs).toContain("[上下文压缩：工具参数原");
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

  it("compact 之后 skill 注入随历史一起被摘要替换", () => {
    const events: SessionEvent[] = [
      { seq: 0, sessionId: "s", ts: 1, type: "skill_invoked", name: "tdd", content: "长指令" },
      { seq: 1, sessionId: "s", ts: 2, type: "user_message", content: "干活" },
      { seq: 2, sessionId: "s", ts: 3, type: "context_compacted", summary: "都干完了", model: "m" },
    ];
    const msgs = deriveMessages(events);
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as { content: string }).content).toContain("都干完了");
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
