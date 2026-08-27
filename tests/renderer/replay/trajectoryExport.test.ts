import { describe, it, expect } from "vitest";
import { buildTrajectory, rowMatches } from "../../../src/renderer/src/replay/trajectory.js";
import {
  buildExport,
  eventsJsonl,
  exportFilename,
  exportTotals,
  stepStatus,
  toExportStep,
  trajectoryDoc,
  trajectoryMarkdown,
  type ExportMeta,
} from "../../../src/renderer/src/replay/trajectoryExport.js";
import type { SessionEvent } from "../../../src/session/events.js";

// 两个 turn：写文件（审批 + 执行 + token）、bash 报错、turn 暴死
const log: SessionEvent[] = [
  { seq: 0, sessionId: "sess-abcdef123456", ts: 1000, type: "session_created", workspace: "/proj/x" },
  { seq: 1, sessionId: "sess-abcdef123456", ts: 2000, type: "user_message", content: "写个文件" },
  {
    seq: 2, sessionId: "sess-abcdef123456", ts: 3000, type: "assistant_message", content: "", model: "glm-4.5",
    toolCalls: [{ id: "c1", name: "write_file", args: { path: "a.txt", content: "hi" } }],
    usage: { promptTokens: 100, completionTokens: 20 },
  },
  { seq: 3, sessionId: "sess-abcdef123456", ts: 3500, type: "approval_decision", toolCallId: "c1", decision: "approved" },
  { seq: 4, sessionId: "sess-abcdef123456", ts: 4000, type: "tool_execution_started", toolCallId: "c1" },
  {
    seq: 5, sessionId: "sess-abcdef123456", ts: 4800, type: "tool_result", toolCallId: "c1", status: "ok",
    output: "已写入", diffStat: { additions: 3, deletions: 0 },
  },
  {
    seq: 6, sessionId: "sess-abcdef123456", ts: 5000, type: "assistant_message", content: "写好了", model: "glm-4.5",
    usage: { promptTokens: 200, completionTokens: 8 }, reasoning: "先看目录", reasoningMs: 120,
  },
  { seq: 7, sessionId: "sess-abcdef123456", ts: 5001, type: "turn_ended", outcome: "completed" },
  { seq: 8, sessionId: "sess-abcdef123456", ts: 6000, type: "user_message", content: "跑一下" },
  {
    seq: 9, sessionId: "sess-abcdef123456", ts: 7000, type: "assistant_message", content: "", model: "glm-4.5",
    toolCalls: [{ id: "c2", name: "bash", args: { command: "boom" } }],
  },
  { seq: 10, sessionId: "sess-abcdef123456", ts: 7900, type: "tool_result", toolCallId: "c2", status: "error", output: "炸了" },
  { seq: 11, sessionId: "sess-abcdef123456", ts: 8000, type: "turn_ended", outcome: "error", error: "后来炸了" },
];

const traj = buildTrajectory(log);
const meta: ExportMeta = {
  sessionId: "sess-abcdef123456",
  title: "写个文件",
  workspace: "/proj/x",
  model: "glm-4.5",
  exportedTs: new Date(2026, 7, 27, 14, 30, 12).getTime(),
  query: "",
};

describe("exportFilename", () => {
  it("会话 id 取前 8 位 + 本地时间戳 + 各自的后缀", () => {
    expect(exportFilename(meta, "json")).toBe("otto-trajectory-sess-abc-20260827-143012.json");
    expect(exportFilename(meta, "jsonl")).toBe("otto-trajectory-sess-abc-20260827-143012.jsonl");
    expect(exportFilename(meta, "markdown")).toBe("otto-trajectory-sess-abc-20260827-143012.md");
  });

  it("没有会话 id 也得有个名字，不能落出 `otto-trajectory--…`", () => {
    expect(exportFilename({ ...meta, sessionId: "" }, "json")).toContain("otto-trajectory-session-");
  });
});

describe("toExportStep：一步一条，字段没有就缺席", () => {
  const byKey = (k: string) => traj.rows.find((r) => r.key === k)!;

  it("工具行带 callId / 参数 / 输出 / 真执行耗时 / 审批 / diffStat，模型从请求它的那条回复上带出来", () => {
    const s = toExportStep(byKey("c1"));
    expect(s.kind).toBe("tool");
    expect(s.model).toBe("glm-4.5");
    expect(s.tool).toEqual({
      callId: "c1",
      name: "write_file",
      args: { path: "a.txt", content: "hi" },
      status: "ok",
      output: "已写入",
      durationMs: 800, // 4800 − 4000，审批等待（3500→4000）不计
      startedTs: 4000,
      finishedTs: 4800,
      approval: { decision: "approved", ts: 3500 },
      diffStat: { additions: 3, deletions: 0 },
    });
  });

  it("没配上 started 的工具没有 durationMs——不知道就不说，不编 0", () => {
    const s = toExportStep(byKey("c2"));
    expect(s.tool!.status).toBe("error");
    expect(s.tool).not.toHaveProperty("durationMs");
    expect(s.tool).not.toHaveProperty("approval");
    expect(s.failed).toBe(true);
  });

  it("助手行带 model / 正文 / reasoning / token；工具调用那条正文为空则不出现 content 字段", () => {
    const spoke = toExportStep(traj.rows.find((r) => r.seq === 6)!);
    expect(spoke).toMatchObject({
      model: "glm-4.5",
      content: "写好了",
      reasoning: "先看目录",
      reasoningMs: 120,
      usage: { promptTokens: 200, completionTokens: 8 },
    });
    const callOnly = toExportStep(traj.rows.find((r) => r.seq === 2 && r.kind === "assistant")!);
    expect(callOnly).not.toHaveProperty("content");
  });

  it("用户行给正文；system 行给事件本体（种类太杂，分析侧自己按 type 挑）", () => {
    expect(toExportStep(traj.rows.find((r) => r.kind === "user")!).content).toBe("写个文件");
    const sys = toExportStep(traj.rows.find((r) => r.ev.type === "session_created")!);
    expect(sys.event).toMatchObject({ type: "session_created", workspace: "/proj/x" });
  });
});

describe("stepStatus：结果落了看 status，没结果看走到了哪一步", () => {
  it("工具四态 + turn_ended 用 outcome", () => {
    expect(stepStatus(traj.rows.find((r) => r.key === "c1")!)).toBe("ok");
    expect(stepStatus(traj.rows.find((r) => r.key === "c2")!)).toBe("error");
    expect(stepStatus(traj.rows.find((r) => r.ev.type === "turn_ended" && r.ev.outcome === "error")!)).toBe("error");
  });

  it("只批过、还没开跑 = 那条审批的决定；什么都没有 = pending", () => {
    const row = traj.rows.find((r) => r.key === "c1")!;
    // exactOptionalPropertyTypes：这几个字段要么在要么不在，不能是 undefined
    const without = (...keys: ("result" | "started" | "approval")[]) => {
      const copy = { ...row };
      for (const k of keys) delete copy[k];
      return copy;
    };
    expect(stepStatus(without("result", "started"))).toBe("approved");
    expect(stepStatus(without("result", "started", "approval"))).toBe("pending");
    expect(stepStatus(without("result"))).toBe("running");
  });
});

describe("exportTotals：数字只数导出的那些步，一份文件里必须自洽", () => {
  it("全量：turn / 步数 / 工具成败 / token / 墙钟", () => {
    const t = exportTotals(traj, traj.rows);
    expect(t).toMatchObject({
      turns: 2,
      steps: traj.rows.length,
      exportedSteps: traj.rows.length,
      toolCalls: 2,
      toolErrors: 1,
      toolDenials: 0,
      promptTokens: 300,
      completionTokens: 28,
      wallMs: 7000,
    });
  });

  it("过滤后 exportedSteps 跟着变，steps 仍是整条轨迹的长度", () => {
    const rows = traj.rows.filter((r) => rowMatches(r, "bash"));
    const t = exportTotals(traj, rows);
    expect(t.exportedSteps).toBe(rows.length);
    expect(t.exportedSteps).toBeLessThan(t.steps);
    expect(t.steps).toBe(traj.rows.length);
  });

  it("token 不重复计：工具行挂的是同一条 assistant_message，不能再数一遍", () => {
    // c1 的行和 seq 2 那条 assistant 行共用同一个 ev（usage 100/20）
    const rows = traj.rows.filter((r) => r.seq === 2);
    expect(rows.length).toBe(2);
    expect(exportTotals(traj, rows).promptTokens).toBe(100);
  });
});

describe("trajectoryDoc", () => {
  it("带上认领标记 + 会话身份 + 全部步骤；没过滤时不写 filter 字段", () => {
    const doc = trajectoryDoc(traj, traj.rows, meta);
    expect(doc.kind).toBe("otto.trajectory");
    expect(doc.version).toBe(1);
    expect(doc.session).toMatchObject({ id: "sess-abcdef123456", title: "写个文件", startedTs: 1000, endedTs: 8000 });
    expect(doc.steps.length).toBe(traj.rows.length);
    expect(doc).not.toHaveProperty("filter");
  });

  it("有过滤就写进 filter：读的人得一眼看出这是切片不是全量", () => {
    const rows = traj.rows.filter((r) => rowMatches(r, "bash"));
    expect(trajectoryDoc(traj, rows, { ...meta, query: "  bash " }).filter).toBe("bash");
  });
});

describe("eventsJsonl：无损原始日志", () => {
  it("一行一条，逐条解析回来和输入等价", () => {
    const lines = eventsJsonl(log).trimEnd().split("\n");
    expect(lines.length).toBe(log.length);
    expect(lines.map((l) => JSON.parse(l))).toEqual(log);
  });

  it("空日志导出空文件，不是一个孤零零的换行", () => {
    expect(eventsJsonl([])).toBe("");
  });
});

describe("trajectoryMarkdown", () => {
  it("头部有会话身份和规模，正文按 turn 分节", () => {
    const md = trajectoryMarkdown(traj, traj.rows, meta);
    expect(md).toContain("# 轨迹导出 · 写个文件");
    expect(md).toContain("`/proj/x`");
    expect(md).toContain("2 turns");
    expect(md).toContain("## Turn 1");
    expect(md).toContain("## Turn 2");
    expect(md).toContain("### 3. TOOL `write_file` — ok · 800 ms");
    expect(md).toContain("炸了");
  });

  it("正文里本来就有 ``` 时围栏加长，这一段不会当场断掉", () => {
    const withFence: SessionEvent[] = [
      { seq: 0, sessionId: "s", ts: 1, type: "user_message", content: "```js\nconst a = 1;\n```" },
    ];
    const md = trajectoryMarkdown(buildTrajectory(withFence), buildTrajectory(withFence).rows, meta);
    expect(md).toContain("````\n```js");
  });

  it("超长正文截断，并指路完整内容在哪", () => {
    const long: SessionEvent[] = [
      { seq: 0, sessionId: "s", ts: 1, type: "user_message", content: "x".repeat(9000) },
    ];
    const t = buildTrajectory(long);
    const md = trajectoryMarkdown(t, t.rows, meta);
    expect(md).toContain("截断，共 9000 字符");
    expect(md.length).toBeLessThan(6000);
  });
});

describe("buildExport", () => {
  const input = { traj, rows: traj.rows, events: log, meta };

  it("三种格式各自的文件名 / MIME / 内容", () => {
    const j = buildExport("json", input);
    expect(j.filename.endsWith(".json")).toBe(true);
    expect(j.mime).toBe("application/json");
    expect(JSON.parse(j.text).kind).toBe("otto.trajectory");

    const l = buildExport("jsonl", input);
    expect(l.mime).toBe("application/x-ndjson");
    expect(l.text.trimEnd().split("\n").length).toBe(log.length);

    const m = buildExport("markdown", input);
    expect(m.filename.endsWith(".md")).toBe(true);
    expect(m.mime).toBe("text/markdown");
    expect(m.text.startsWith("# 轨迹导出")).toBe(true);
  });

  it("jsonl 无视过滤：过滤过的日志不是日志", () => {
    const rows = traj.rows.filter((r) => rowMatches(r, "bash"));
    const filtered = { ...input, rows, meta: { ...meta, query: "bash" } };
    expect(buildExport("jsonl", filtered).text).toBe(buildExport("jsonl", input).text);
    expect(JSON.parse(buildExport("json", filtered).text).steps.length).toBe(rows.length);
  });
});
