// 强化 L1 第二轮（#1659）：定时任务放宽（every + 上限 50）与专员上报通道（escalate_to_admin）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEscalateTool } from "../../services/runtime/src/escalateTool.js";
import { escalationNoteText, escalationOpeningText, ESCALATION_PER_HOUR_MAX } from "../../src/shared/escalation.js";
import { openingTraits } from "../../src/shared/outreach.js";
import { parseReportPlan } from "../../src/shared/quietHours.js";
import { nextRunAt, parseRoutineSchedule, routineErrors, scheduleText, ROUTINES_ENABLED_MAX } from "../../src/shared/routines.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const read = (p: string): string => readFileSync(p, "utf8");
const TZ = "Australia/Brisbane"; // UTC+10，无夏令时
/** 布里斯班墙上时间 → UTC 毫秒 */
const bne = (d: number, hh: number, mm: number): number => Date.UTC(2026, 9, d, hh - 10, mm);
const world = {} as ExecutionWorld;

describe("定时任务：时段内每隔 N 分钟（every）", () => {
  const s = { kind: "every", minutes: 10, from: "10:30", to: "22:30" } as const;

  it("校验：间隔 5..720 的整数；from 早于 to；days 全选等于不传", () => {
    expect(parseRoutineSchedule(s)).toEqual(s);
    expect(parseRoutineSchedule({ ...s, days: [7, 1, 2, 3, 4, 5, 6] })).toEqual(s);
    expect(parseRoutineSchedule({ ...s, days: [6, 6, 7] })).toEqual({ ...s, days: [6, 7] });
    expect(() => parseRoutineSchedule({ ...s, minutes: 3 })).toThrow("5..720");
    expect(() => parseRoutineSchedule({ ...s, minutes: 7.5 })).toThrow("整数");
    expect(() => parseRoutineSchedule({ ...s, from: "22:30", to: "10:30" })).toThrow("不跨夜");
    expect(() => parseRoutineSchedule({ ...s, days: [] })).toThrow("至少选一天");
    expect(routineErrors({ title: "盯盘", instruction: "看一眼", schedule: s, tz: TZ })).toBeNull();
  });

  it("下一跳：营业前 → 当天 from；营业中 → 下一格；最后一格之后 → 明天 from；days 跳过不选的日子", () => {
    expect(nextRunAt(s, TZ, bne(5, 9, 0))).toBe(bne(5, 10, 30));
    expect(nextRunAt(s, TZ, bne(5, 14, 42))).toBe(bne(5, 14, 50));
    expect(nextRunAt(s, TZ, bne(5, 14, 50))).toBe(bne(5, 15, 0)); // 严格大于
    expect(nextRunAt(s, TZ, bne(5, 22, 30))).toBe(bne(6, 10, 30));
    expect(nextRunAt({ ...s, minutes: 60, from: "10:30", to: "12:00" }, TZ, bne(5, 11, 31))).toBe(bne(6, 10, 30)); // 12:30 超出 to
    // 2026-10-05 是周一；只选周三
    expect(nextRunAt({ ...s, days: [3] }, TZ, bne(5, 12, 0))).toBe(bne(7, 10, 30));
  });

  it("一句话：每天 / 每周几、间隔整小时写小时", () => {
    expect(scheduleText(s, TZ)).toBe("每天 10:30–22:30 每 10 分钟 · Australia/Brisbane");
    expect(scheduleText({ ...s, minutes: 120, days: [1, 2] }, TZ)).toBe("每周一、二 10:30–22:30 每 2 小时 · Australia/Brisbane");
  });

  it("免打扰汇报不收 every（汇报是一天一次的形状）", () => {
    expect(parseReportPlan({ mode: "call", schedule: s })).toBeNull();
    expect(parseReportPlan({ mode: "call", schedule: { kind: "daily", time: "21:00" } })).not.toBeNull();
  });

  it("上限 50：代码常量与 0066 的触发器、形状约束对得上；工具表宣称 every", () => {
    expect(ROUTINES_ENABLED_MAX).toBe(50);
    const sql = read("supabase/migrations/0066_routine_every.sql");
    expect(sql).toContain(">= 50 then");
    expect(sql).toContain("in ('once', 'daily', 'weekly', 'every')");
    // monthly（#1682）跟在 every 后面：工具表与 0068 的形状约束一起放宽
    expect(read("services/runtime/src/routineTools.ts")).toContain('enum: ["once", "daily", "weekly", "every", "monthly"]');
    expect(read("supabase/migrations/0068_group_seats.sql")).toContain("in ('once', 'daily', 'weekly', 'every', 'monthly')");
    expect(read("mobile/src/agent/RoutineEditDialog.tsx")).toContain('{ k: "every", label: "时段内重复" }');
  });
});

describe("专员上报：escalate_to_admin", () => {
  const make = (deliver: Parameters<typeof createEscalateTool>[0]["deliver"], now = { t: 0 }) =>
    createEscalateTool({ agentId: "a_642f0e7623b8", agentName: () => "应用专员", taskTitle: (id) => (id === "t_1" ? "到点提醒" : null), deliver, now: () => now.t });

  it("送达：带上专员名、原话、任务标题；回执说清转给谁、这件别再管", async () => {
    const got: unknown[] = [];
    const tool = make(async (e) => { got.push(e); return { ok: true, adminName: "雨姐" }; });
    const out = await tool.run({ text: "主人要晚上 6 点前接到电话提醒约会", taskId: "t_1" }, world);
    expect(got).toEqual([{ fromAgentId: "a_642f0e7623b8", fromName: "应用专员", text: "主人要晚上 6 点前接到电话提醒约会", taskTitle: "到点提醒" }]);
    expect(out).toContain("已转给「雨姐」");
    expect(out).toContain("别再管");
  });

  it("没送到：照实说没转过去，别让它说已转；空话 / 超长拒绝", async () => {
    const tool = make(async () => ({ ok: false, message: "主人和管理员还没有私聊" }));
    await expect(tool.run({ text: "x" }, world)).rejects.toThrow("没转过去：主人和管理员还没有私聊。别说已经转了");
    await expect(tool.run({ text: "  " }, world)).rejects.toThrow("text 必填");
    await expect(tool.run({ text: "字".repeat(801) }, world)).rejects.toThrow("最多 800 字");
  });

  it("一小时内封顶，过了一小时又能转", async () => {
    const now = { t: 0 };
    const tool = make(async () => ({ ok: true, adminName: "管理员" }), now);
    for (let i = 0; i < ESCALATION_PER_HOUR_MAX; i++) await tool.run({ text: `第 ${i} 件` }, world);
    await expect(tool.run({ text: "再一件" }, world)).rejects.toThrow("这一小时已经转了");
    now.t = 3_600_001;
    await expect(tool.run({ text: "再一件" }, world)).resolves.toContain("已转给");
  });

  it("开场白与灰条：管理员看得到前因与该怎么接；主人看得到是谁转来的", () => {
    const opening = escalationOpeningText({ fromName: "应用专员", text: "到点打电话提醒", taskTitle: "提醒" });
    expect(opening).toContain("【专员上报】「应用专员」转来一件事（关联任务「提醒」）");
    expect(opening).toContain("schedule_task");
    expect(opening).toContain("bring_agent");
    expect(escalationNoteText({ fromName: "应用专员", text: "到点\n打电话" })).toBe("📨 应用专员 转来：到点 打电话");
  });

  it("这一轮的身份：不算主人亲口（打给别人的不亮）、不受监督、标成 escalation", () => {
    const OWNER = "u1";
    expect(openingTraits([{ fromUid: OWNER, greeting: "escalation" }], OWNER)).toEqual({ report: false, ownerSpoke: false, nonOwner: false, ownerReport: false, escalation: true });
    expect(openingTraits([{ fromUid: OWNER }], OWNER).escalation).toBe(false);
  });

  it("接线：只给这条对话里没有管理员的专员；那一轮放行排定时；daemon 送进管理员私聊；手机画灰条", () => {
    const svc = read("services/runtime/src/sessionService.ts");
    expect(svc).toContain("escalateTool !== null && me !== null && tierOf(me) === 1 && !turnRoster.some((a) => a.agentId === ADMIN_AGENT_ID)");
    expect(svc).toContain("available: () => (ownerSpoke || escalationTurn || seatGrantTurn || ownChainTurn) && !supervisedTurn(),");
    expect(svc).toContain('greeting: "escalation"');
    const daemon = read("services/runtime/src/daemon.ts");
    expect(daemon).toContain("escalateToAdmin: async (e) =>");
    expect(daemon).toContain("findDmSession(e.workspaceId, [ADMIN_AGENT_ID])");
    expect(read("src/shared/mobileChat.ts")).toContain('e.greeting === "escalation" && e.escalation !== undefined');
    expect(read("src/shared/tierPrompt.ts")).toContain("escalate_to_admin");
  });
});
