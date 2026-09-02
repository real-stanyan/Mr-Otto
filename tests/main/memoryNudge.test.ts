import { describe, expect, it } from "vitest";
import {
  shouldNudge,
  userTurnsSinceNudge,
  settleNudgeSpawn,
  MEMORY_NUDGE_EVERY,
  reviewerTranscript,
  buildReviewerTask,
} from "../../src/main/memoryNudge.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { ChatMessage } from "../../src/session/deriveMessages.js";

const u = (seq: number): SessionEvent => ({ seq, sessionId: "s", ts: 0, type: "user_message", content: "x" });
const nudge = (seq: number): SessionEvent => ({ seq, sessionId: "s", ts: 0, type: "memory_nudge", userTurns: 10 });

describe("memoryNudge", () => {
  it("从最后一条 memory_nudge 之后数 user_message", () => {
    const events = [u(1), u(2), nudge(3), u(4), u(5), u(6)];
    expect(userTurnsSinceNudge(events)).toBe(3);
  });
  it("满 10 才 nudge", () => {
    expect(shouldNudge(Array.from({ length: MEMORY_NUDGE_EVERY }, (_, i) => u(i + 1)))).toBe(true);
    expect(shouldNudge([u(1)])).toBe(false);
  });
  it("刚 nudge 过、下一轮计数才 1，不该再触发", () => {
    const events = [
      ...Array.from({ length: MEMORY_NUDGE_EVERY }, (_, i) => u(i + 1)),
      nudge(MEMORY_NUDGE_EVERY + 1),
      u(MEMORY_NUDGE_EVERY + 2),
    ];
    expect(shouldNudge(events)).toBe(false);
  });
  it("错过整点（第 10 轮 abort/throw 没落 memory_nudge）也该在下一次补上", () => {
    const events = Array.from({ length: MEMORY_NUDGE_EVERY + 1 }, (_, i) => u(i + 1));
    expect(shouldNudge(events)).toBe(true);
  });
  it("子会话（spawnedBy）永不 nudge", () => {
    const events: SessionEvent[] = [
      { seq: 0, sessionId: "s", ts: 0, type: "session_created", workspace: "/w", spawnedBy: { sessionId: "p", toolCallId: "t", agent: "x" } },
      ...Array.from({ length: MEMORY_NUDGE_EVERY }, (_, i) => u(i + 1)),
    ];
    expect(shouldNudge(events)).toBe(false);
  });
});

describe("reviewerTranscript", () => {
  it("丢 system，留 user/assistant/tool", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "系统提示词 + MEMORY/USER 块" },
      { role: "user", content: "帮我看看这个报错" },
      {
        role: "assistant",
        content: "我先读一下文件",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "文件内容……" },
    ];
    const out = reviewerTranscript(messages);
    expect(out).not.toContain("MEMORY/USER 块");
    expect(out).toContain("user: 帮我看看这个报错");
    expect(out).toContain("tool: 文件内容……");
  });

  it("assistant 的 tool_calls 渲成「调用 名字(参数)」，参数超 200 字符截断", () => {
    const longArgs = JSON.stringify({ content: "x".repeat(300) });
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "记一条",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "memory", arguments: longArgs } },
        ],
      },
    ];
    const out = reviewerTranscript(messages);
    expect(out).toContain("assistant: 记一条 [调用 memory(");
    expect(out).not.toContain(longArgs); // 完整参数不该原样出现——必须被截过
    expect(out.length).toBeLessThan(longArgs.length + 100);
  });

  it("多模态 user 消息渲成 [多模态]", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "看图" }] },
    ];
    expect(reviewerTranscript(messages)).toBe("user: [多模态]");
  });

  it("尾部截断到 cap 字符，保留结尾不保留开头", () => {
    const messages: ChatMessage[] = Array.from({ length: 50 }, (_, i) => ({
      role: "user" as const,
      content: `第${i}条消息`,
    }));
    const out = reviewerTranscript(messages, 50);
    expect(out.length).toBe(50);
    expect(out).toContain("第49条消息");
    expect(out).not.toContain("第0条消息");
  });
});

// memory-reviewer 认三档：项目档的内容和项目根是运行时事实，进 task 字符串
// 而不是静态 instructions（后者放不下"当次是哪个项目"）
describe("buildReviewerTask", () => {
  it("有项目档时拼出 PROJECT 段落，带项目根", () => {
    const task = buildReviewerTask(
      { memory: "M", user: "U", project: "P", projectRoot: "/repo" },
      "最近对话转写",
    );
    expect(task).toContain("当前 MEMORY:\nM");
    expect(task).toContain("当前 USER:\nU");
    expect(task).toContain("当前 PROJECT（/repo）:\nP");
    expect(task).toContain("最近对话：\n最近对话转写");
  });

  // 没有项目档时（workspace 不在 git 仓库里）task 字符串里不该出现 PROJECT 段落——
  // reviewer 手上的 memory 工具那时也没有 project 这个选项，给它看一个写不了的档
  // 只会制造困惑
  it("没有项目档时不出现 PROJECT 段落", () => {
    const task = buildReviewerTask({ memory: "M", user: "U" }, "转写");
    expect(task).not.toContain("PROJECT");
    expect(task).toContain("当前 MEMORY:\nM");
    expect(task).toContain("当前 USER:\nU");
  });

  it("MEMORY/USER/PROJECT 都空时落 (空) 占位", () => {
    const task = buildReviewerTask({ memory: "", user: "", project: "", projectRoot: "/repo" }, "转写");
    expect(task).toContain("当前 MEMORY:\n(空)");
    expect(task).toContain("当前 USER:\n(空)");
    expect(task).toContain("当前 PROJECT（/repo）:\n(空)");
  });

  it("带 topics：拼主题索引 + 非空桶正文", () => {
    const task = buildReviewerTask(
      { memory: "", user: "", topics: [{ slug: "work", label: "工作", content: "" }, { slug: "cars", label: "改装车", content: "WRX" }] },
      "对话",
    );
    expect(task).toContain("主题索引");
    expect(task).toContain("work（工作）· 0 条");
    expect(task).toContain("当前 TOPIC:cars（改装车）:\nWRX");
    expect(task).not.toContain("当前 TOPIC:work");
  });
});

// issue #186：memory-nudge-<seq> 这种合成 parentToolCallId 没有配对的 tool_result，
// subagentRowState 永远 working。settleNudgeSpawn 在 reviewer 跑完后往父会话落
// 一条收口 tool_result（成功 ok / 失败 error），时间线那张卡据此翻成 done。
describe("settleNudgeSpawn", () => {
  const deps = () => {
    const appended: SessionEvent[] = [];
    const sent: SessionEvent[] = [];
    return {
      appended, sent,
      append: (e: Omit<SessionEvent, "seq">) => {
        const full = { ...e, seq: appended.length + 1 } as SessionEvent;
        appended.push(full);
        return full;
      },
      send: (e: SessionEvent) => { sent.push(e); },
    };
  };

  it("reviewer 成功：落 ok tool_result，output 是汇报", async () => {
    const d = deps();
    await settleNudgeSpawn(
      { append: d.append, send: d.send },
      "parent-s", "memory-nudge-7",
      async () => ({ report: "记了 2 条" }),
    );
    expect(d.appended).toHaveLength(1);
    expect(d.appended[0]).toMatchObject({
      sessionId: "parent-s", type: "tool_result", toolCallId: "memory-nudge-7", status: "ok", output: "记了 2 条",
    });
    expect(d.sent).toEqual(d.appended);
  });

  it("reviewer 抛错：落 error tool_result 再把错误往外抛（调用方负责记日志）", async () => {
    const d = deps();
    await expect(
      settleNudgeSpawn({ append: d.append, send: d.send }, "parent-s", "memory-nudge-7", async () => {
        throw new Error("模型不可用");
      }),
    ).rejects.toThrow("模型不可用");
    expect(d.appended[0]).toMatchObject({
      type: "tool_result", toolCallId: "memory-nudge-7", status: "error",
    });
    expect((d.appended[0] as { output: string }).output).toContain("模型不可用");
  });
});
