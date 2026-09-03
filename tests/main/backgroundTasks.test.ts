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
    expect(bg.live()).toEqual([{ id: "bg-1", cmd: "npm run build", tail: "" }]);

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
    const text = formatCompletion({ id: "bg-2", cmd: "npm test", result: ok, claimed: false });
    expect(text).toContain("[后台任务 bg-2 完成] npm test");
    expect(text).toContain("exit code: 0");
    expect(text).toContain("stdout:\nbuilt");
  });

  it("超长输出中间截断，头尾都在", () => {
    const text = formatCompletion({
      id: "bg-3",
      cmd: "cat big",
      result: { stdout: "HEAD" + "x".repeat(20_000) + "TAIL", stderr: "", exitCode: 0 },
      claimed: false,
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

// 输出直播（issue #772 / ADR-0195）：主进程既往外推碎片，也自己留一份尾巴——
// 推送只覆盖此刻在场的人，重开面板 / 重载渲染层要靠 live() 里那份尾巴补回来。
describe("BackgroundTasks 的输出尾巴", () => {
  it("run 拿到的 sink 一头喂订阅者、一头攒进 live() 的尾巴", async () => {
    const bg = new BackgroundTasks();
    const pushed: string[] = [];
    bg.onCompletion(() => {});
    bg.onOutput((o) => pushed.push(`${o.id}:${o.stream}:${o.chunk}`));

    let release!: (r: ExecResult) => void;
    const gate = new Promise<ExecResult>((r) => (release = r));
    bg.start("npm run build", (onOutput) => {
      onOutput("webpack…\n", "stdout");
      onOutput("warn\n", "stderr");
      return gate;
    });

    expect(pushed).toEqual(["bg-1:stdout:webpack…\n", "bg-1:stderr:warn\n"]);
    // stdout/stderr 不分家：终端视角按到达顺序混流（同 toolOutputByCall）
    expect(bg.live()).toEqual([
      { id: "bg-1", cmd: "npm run build", tail: "webpack…\nwarn\n" },
    ]);

    release(ok);
    await new Promise((r) => setTimeout(r, 0));
    // 完成了也留着：结果贴回对话之前那张卡还画在面板上
    expect(bg.tailOf("bg-1")).toBe("webpack…\nwarn\n");
  });

  it("没人订阅照样攒尾巴 —— 直播是增强，攒不攒不取决于有没有人在看", () => {
    const bg = new BackgroundTasks();
    bg.start("x", (onOutput) => {
      onOutput("有", "stdout");
      return new Promise<ExecResult>(() => {});
    });
    expect(bg.tailOf("bg-1")).toBe("有");
  });

  it("尾巴有界：只留最后 4000 字，头部先丢", () => {
    const bg = new BackgroundTasks();
    bg.start("x", (onOutput) => {
      onOutput("头".repeat(3_000), "stdout");
      onOutput("尾".repeat(3_000), "stdout");
      return new Promise<ExecResult>(() => {});
    });
    const tail = bg.tailOf("bg-1");
    expect(tail.length).toBe(4_000);
    expect(tail.endsWith("尾")).toBe(true);
    expect(tail.startsWith("头")).toBe(true); // 丢的是头部，不是整段重来
  });

  it("任务数超上限时淘汰已死的那些，正在写字的终端不被清屏", async () => {
    const bg = new BackgroundTasks();
    bg.onCompletion(() => {});
    // 一个长跑的：先起，永远不完
    bg.start("长跑", (onOutput) => {
      onOutput("still here", "stdout");
      return new Promise<ExecResult>(() => {});
    });
    // 再灌 40 个瞬间跑完的，把上限撑爆
    for (let i = 0; i < 40; i++) {
      bg.start(`短命 ${i}`, (onOutput) => {
        onOutput("x", "stdout");
        return Promise.resolve(ok);
      });
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(bg.tailOf("bg-1")).toBe("still here");
    expect(bg.tailOf("bg-2")).toBe(""); // 最早那批已经被淘汰
  });
});

// 同一 turn 里等结果（issue #871 / ADR-0205，Claude Code TaskOutput 对照）：
// wait() 是 wait_task 工具的底座。等到的结果从工具那条路回模型，完成回调带
// claimed:true 让组装根只记账不追加——一份结果不进两次上下文。
describe("BackgroundTasks.wait", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("活着的任务：挂起到完成，拿到结果；完成回调带 claimed:true", async () => {
    const bg = new BackgroundTasks();
    const got: boolean[] = [];
    bg.onCompletion((c) => got.push(c.claimed));
    let release!: (r: ExecResult) => void;
    const id = bg.start("npm run build", () => new Promise<ExecResult>((r) => (release = r)));

    const waiting = bg.wait(id, 10_000);
    release(ok);
    await expect(waiting).resolves.toEqual({ kind: "done", id: "bg-1", cmd: "npm run build", result: ok });
    expect(got).toEqual([true]);
  });

  it("没人等：完成回调 claimed:false（组装根照常追加进对话）", async () => {
    const bg = new BackgroundTasks();
    const got: boolean[] = [];
    bg.onCompletion((c) => got.push(c.claimed));
    bg.start("npm test", () => Promise.resolve(ok));
    await tick();
    expect(got).toEqual([false]);
  });

  it("已完成的任务：直接回结果（模型来晚了也拿得到）", async () => {
    const bg = new BackgroundTasks();
    bg.onCompletion(() => {});
    const id = bg.start("npm test", () => Promise.resolve(ok));
    await tick();
    await expect(bg.wait(id, 10)).resolves.toMatchObject({ kind: "done", id: "bg-1" });
  });

  it("超时：回 timeout 与此刻的输出尾巴，任务继续跑；之后完成照常回调且 claimed:false", async () => {
    const bg = new BackgroundTasks();
    const got: boolean[] = [];
    bg.onCompletion((c) => got.push(c.claimed));
    let release!: (r: ExecResult) => void;
    const id = bg.start("npm run build", (out) => {
      out("compiling…", "stdout");
      return new Promise<ExecResult>((r) => (release = r));
    });
    await expect(bg.wait(id, 5)).resolves.toEqual({
      kind: "timeout",
      id: "bg-1",
      cmd: "npm run build",
      tail: "compiling…",
    });
    expect(bg.live().map((t) => t.id)).toEqual(["bg-1"]); // 还活着
    release(ok);
    await tick();
    expect(got).toEqual([false]); // 等的人已经走了，结果该走追加那条路
  });

  it("不认识的 id：unknown（打错了，或上一次启动留下的）", async () => {
    const bg = new BackgroundTasks();
    await expect(bg.wait("bg-9", 10)).resolves.toEqual({ kind: "unknown", id: "bg-9" });
  });

  it("中断信号：reject 成 AbortError——用户叫停不能伪装成等超时", async () => {
    const bg = new BackgroundTasks();
    bg.onCompletion(() => {});
    const id = bg.start("sleep", () => new Promise<ExecResult>(() => {}));
    const ac = new AbortController();
    const waiting = bg.wait(id, 10_000, ac.signal);
    ac.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });
});
