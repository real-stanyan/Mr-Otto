import { describe, expect, it } from "vitest";
import { BackgroundTasks, formatCompletion } from "../../src/main/backgroundTasks.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { ExecResult } from "../../src/world/executionWorld.js";

// 后台任务完成回注（issue #389）：跟踪 + 完成回调 + 回注文案。

const ok: ExecResult = { stdout: "built\n", stderr: "", exitCode: 0 };

describe("BackgroundTasks", () => {
  it("start 立即返回递增 id，完成时带原命令回调，live 表随之增减", async () => {
    const bg = new BackgroundTasks();
    const got: Array<{ id: string; cmd: string; exitCode: number }> = [];
    bg.onCompletion((c) => got.push({ id: c.id, cmd: c.cmd, exitCode: c.result.exitCode }));

    let release!: (r: ExecResult) => void;
    const gate = new Promise<ExecResult>((r) => (release = r));
    const id = bg.start("npm run build", () => gate);
    expect(id).toBe("bg-1");
    expect(bg.live()).toEqual([{ id: "bg-1", cmd: "npm run build" }]);

    release(ok);
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual([{ id: "bg-1", cmd: "npm run build", exitCode: 0 }]);
    expect(bg.live()).toEqual([]);
  });

  it("armed = 接了完成回调；run 抛异常兜成 exitCode 1 的结果，完成事实不丢", async () => {
    const bg = new BackgroundTasks();
    expect(bg.armed).toBe(false);
    const got: ExecResult[] = [];
    bg.onCompletion((c) => got.push(c.result));
    expect(bg.armed).toBe(true);

    bg.start("boom", () => Promise.reject(new Error("spawn 失败")));
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual([{ stdout: "", stderr: "spawn 失败", exitCode: 1 }]);
  });
});

describe("formatCompletion", () => {
  it("带任务 id、命令、退出码与输出段", () => {
    const text = formatCompletion({ id: "bg-2", cmd: "npm test", result: ok });
    expect(text).toContain("[后台任务 bg-2 完成] npm test");
    expect(text).toContain("exit code: 0");
    expect(text).toContain("stdout:\nbuilt");
  });

  it("超长输出中间截断，头尾都在", () => {
    const text = formatCompletion({
      id: "bg-3",
      cmd: "cat big",
      result: { stdout: "HEAD" + "x".repeat(20_000) + "TAIL", stderr: "", exitCode: 0 },
    });
    expect(text.length).toBeLessThan(10_000);
    expect(text).toContain("HEAD");
    expect(text).toContain("TAIL");
    expect(text).toContain("中间省略");
  });
});

describe("background_task_completed 事件", () => {
  it("对投影字节不可见（模型可见载体是回注 user_message）", () => {
    const base = { sessionId: "s1", ts: 1 };
    const log: SessionEvent[] = [
      { ...base, seq: 0, type: "session_created", workspace: "/w" },
      { ...base, seq: 1, type: "user_message", content: "你好" },
      { ...base, seq: 2, type: "assistant_message", content: "好", model: "m" },
      { ...base, seq: 3, type: "turn_ended", outcome: "completed" },
    ];
    const withEvent: SessionEvent[] = [
      ...log,
      {
        ...base,
        seq: 4,
        type: "background_task_completed",
        ignorable: true,
        taskId: "bg-1",
        cmd: "npm test",
        exitCode: 0,
      },
    ];
    expect(deriveMessages(withEvent)).toEqual(deriveMessages(log));
  });
});

describe("回注 user_message 的 origin 标（issue #428）", () => {
  const base = { sessionId: "s1", ts: 1 };
  const human: SessionEvent[] = [
    { ...base, seq: 0, type: "session_created", workspace: "/w" },
    { ...base, seq: 1, type: "user_message", content: "[后台任务 bg-1 完成] npm test" },
  ];
  const reinjected: SessionEvent[] = [
    human[0]!,
    { ...base, seq: 1, type: "user_message", content: "[后台任务 bg-1 完成] npm test", origin: "background" },
  ];

  it("模型投影读都不读它——带标与不带标逐字节一致", () => {
    expect(deriveMessages(reinjected)).toEqual(deriveMessages(human));
  });

  it("UI 分得出来：标只在事件上，不靠正文前缀猜", () => {
    const e = reinjected[1]!;
    expect(e.type === "user_message" && e.origin).toBe("background");
    // 人打的字里凑巧写了同样的正文也不会被认成后台任务
    const h = human[1]!;
    expect(h.type === "user_message" && h.origin).toBeUndefined();
  });
});
