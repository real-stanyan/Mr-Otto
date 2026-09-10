// 云会话输入框那枚上下文用量环的数据源（#1138）。四件会咬人的事：
//
// ① **视野按 agent 分**：A 报了 50K 的账，B 回一句 8K 的话，A 那一行仍是 50K 起——
//    整份日志当一只算的话 billingAnchor 会被 B 的账顶掉，环从 40% 掉到 6% 而谁都没压缩。
// ② **窗口按这只 agent 自己最后一次真跑的型号**：B 的回复在 A 的视野里还留着
//    （剥掉 usage 但 model 还在），倒着扫不按 agentId 过滤就会拿 B 的型号当 A 的窗口。
// ③ **工具表从自己的信封取**：桌面没有云 runtime 的 toolDefs，request_envelope 是
//    日志里唯一的快照，而信封是按 agent 落的。
// ④ **目录不认识的一律 null**：不画、不参与「最吃紧」的比较（#193）——按假分母报
//    百分比比不报更糟；一只都没有已知窗口时整枚环不出现。

import { describe, expect, it } from "vitest";
import {
  bindingContextRow,
  cloudContextRows,
  contextRowSummary,
  contextWindowOf,
  type AgentContextRow,
} from "../../../src/renderer/src/lib/cloudContext.js";
import { findModel } from "../../../src/shared/modelCatalog.js";
import { fmtCtx } from "../../../src/renderer/src/lib/fmtTokens.js";
import type { SessionEvent } from "../../../src/session/events.js";
import type { ToolDefinition } from "../../../src/model/adapter.js";

/** 目录里一款窗口已知的型号；数字现查目录，目录改了这里不用跟 */
const KNOWN = "deepseek-flash";
const KNOWN_WINDOW = findModel(KNOWN)!.contextWindow;
const STRANGER = "no-such-model";

let seq = 0;
const env = () => ({ seq: seq++, sessionId: "s", ts: 1_700_000_000_000 + seq });
const created = (): SessionEvent => ({ ...env(), type: "session_created", workspace: "/work", cloud: { workspaceId: "w" } });
const said = (text: string): SessionEvent => ({ ...env(), type: "user_message", content: `[Stan]: ${text}`, fromUid: "u1", mentions: [] });
const envelope = (agentId: string | undefined, model: string, tools: ToolDefinition[] = []): SessionEvent =>
  ({ ...env(), type: "request_envelope", ignorable: true, model, system: "", tools, ...(agentId ? { agentId } : {}) });
const reply = (agentId: string | undefined, model: string, prompt: number, completion: number): SessionEvent =>
  ({ ...env(), type: "assistant_message", content: "好。", model, usage: { promptTokens: prompt, completionTokens: completion }, ...(agentId ? { agentId } : {}) });

const TOOLS: ToolDefinition[] = [
  { name: "bash", description: "跑一条命令".repeat(20), parameters: { type: "object", properties: { cmd: { type: "string" } } } },
  { name: "write_file", description: "写文件".repeat(20), parameters: { type: "object", properties: { path: { type: "string" } } } },
];

describe("contextWindowOf", () => {
  it("目录认识 → 窗口；不认识 / 没型号 → null（同 daemon 的 contextWindowOf）", () => {
    expect(contextWindowOf(KNOWN)).toBe(KNOWN_WINDOW);
    expect(contextWindowOf(STRANGER)).toBeNull();
    expect(contextWindowOf(null)).toBeNull();
  });
});

describe("cloudContextRows", () => {
  it("还没有任何 agent 露面：整份日志当一行，型号退回团队默认款", () => {
    const rows = cloudContextRows([created(), said("在吗")], KNOWN);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentId).toBeUndefined();
    expect(rows[0]!.model).toBe(KNOWN);
    expect(rows[0]!.window).toBe(KNOWN_WINDOW);
    // 第一句还没发出去：估算侧至少有系统提示词那笔底噪
    expect(rows[0]!.breakdown.total).toBeGreaterThan(0);
  });

  it("团队默认款也没有（探不到 / blocked）→ 窗口 null，环不画", () => {
    const rows = cloudContextRows([created(), said("在吗")], null);
    expect(rows[0]!.window).toBeNull();
    expect(rows[0]!.percent).toBeNull();
    expect(bindingContextRow(rows)).toBeNull();
  });

  it("① 视野按 agent 分：B 的 8K 账单顶不掉 A 的 50K", () => {
    const events = [
      created(),
      said("@运营 @广告 看一下"),
      envelope("a_1", KNOWN, TOOLS),
      reply("a_1", KNOWN, 49_000, 1_000),
      envelope("a_2", KNOWN),
      reply("a_2", KNOWN, 7_000, 1_000),
    ];
    const rows = cloudContextRows(events, null);
    expect(rows.map((r) => r.agentId)).toEqual(["a_1", "a_2"]);
    const [a, b] = rows;
    // A 的锚点是它自己那笔 50K；之后只多了 B 说出口的那句（剥掉 usage 的 assistant_message）
    expect(a!.breakdown.total).toBeGreaterThanOrEqual(50_000);
    expect(a!.breakdown.total).toBeLessThan(51_000);
    // B 的锚点是 8K，A 的 50K 不在它的账上
    expect(b!.breakdown.total).toBeGreaterThanOrEqual(8_000);
    expect(b!.breakdown.total).toBeLessThan(9_000);
    expect(bindingContextRow(rows)).toBe(a);
  });

  it("② 窗口按自己最后一次真跑的型号：B 后来用了目录外的型号，A 的窗口不受影响", () => {
    const events = [
      created(),
      envelope("a_1", KNOWN),
      reply("a_1", KNOWN, 1_000, 100),
      envelope("a_2", STRANGER),
      reply("a_2", STRANGER, 900_000, 100), // 数很大，但窗口未知——不许当最吃紧
    ];
    const rows = cloudContextRows(events, null);
    const [a, b] = rows;
    expect(a!.model).toBe(KNOWN);
    expect(a!.window).toBe(KNOWN_WINDOW);
    expect(b!.model).toBe(STRANGER);
    expect(b!.window).toBeNull();
    expect(b!.percent).toBeNull();
    expect(bindingContextRow(rows)).toBe(a);
  });

  it("跑过的 agent 不吃团队默认款：自己最后一次真跑的型号说了算", () => {
    const rows = cloudContextRows([created(), envelope("a_1", KNOWN), reply("a_1", KNOWN, 10, 5)], STRANGER);
    expect(rows[0]!.model).toBe(KNOWN);
    expect(rows[0]!.window).toBe(KNOWN_WINDOW);
  });

  it("③ 工具表从自己的信封取：A 带两把刀，B 一把都没有", () => {
    const events = [
      created(),
      envelope("a_1", KNOWN, TOOLS),
      reply("a_1", KNOWN, 1_000, 100),
      envelope("a_2", KNOWN),
      reply("a_2", KNOWN, 1_000, 100),
    ];
    const [a, b] = cloudContextRows(events, null);
    expect(a!.breakdown.tools).toBeGreaterThan(0);
    expect(b!.breakdown.tools).toBe(0);
  });

  it("旧云会话（没有 agentId）：一行，型号与工具从不带 agentId 的信封取", () => {
    const events = [created(), said("在吗"), envelope(undefined, KNOWN, TOOLS), reply(undefined, KNOWN, 2_000, 100)];
    const rows = cloudContextRows(events, STRANGER);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentId).toBeUndefined();
    expect(rows[0]!.model).toBe(KNOWN);
    expect(rows[0]!.breakdown.tools).toBeGreaterThan(0);
    expect(rows[0]!.breakdown.total).toBeGreaterThanOrEqual(2_100);
  });

  it("就位了却没跑过的 agent 不占一行（agent_briefed 不算露面）", () => {
    const events: SessionEvent[] = [
      created(),
      { ...env(), type: "agent_briefed", agentId: "a_9", ignorable: true, name: "客服", roster: [] } as unknown as SessionEvent,
      envelope("a_1", KNOWN),
      reply("a_1", KNOWN, 10, 5),
    ];
    expect(cloudContextRows(events, null).map((r) => r.agentId)).toEqual(["a_1"]);
  });
});

describe("bindingContextRow", () => {
  /** 直接造行：两只 agent 的视野里永远有对方说出口的那半句，日志造不出真正的并列 */
  const row = (agentId: string, percent: number | null): AgentContextRow => ({
    agentId, model: KNOWN, window: percent === null ? null : KNOWN_WINDOW, percent,
    breakdown: { system: 0, tools: 0, instructions: 0, messages: 0, total: 0 },
  });

  it("④ 已用占比最高的那只；窗口未知的不参与；并列取先露面的", () => {
    expect(bindingContextRow([row("a_1", 10), row("a_2", 40), row("a_3", null)])!.agentId).toBe("a_2");
    expect(bindingContextRow([row("a_1", 40), row("a_2", 40)])!.agentId).toBe("a_1");
    expect(bindingContextRow([row("a_1", null), row("a_2", null)])).toBeNull();
    expect(bindingContextRow([])).toBeNull();
  });
});

describe("contextRowSummary", () => {
  it("窗口已知：百分比 · 已用 / 窗口，单位同卡上别的数（fmtCtx）", () => {
    const [row] = cloudContextRows([created(), envelope("a_1", KNOWN), reply("a_1", KNOWN, 400_000, 0)], null);
    expect(contextRowSummary(row!)).toBe(
      `${Math.round(row!.percent!)}% · ${fmtCtx(row!.breakdown.total)} / ${fmtCtx(KNOWN_WINDOW)}`,
    );
  });

  it("型号不在目录里：说出是哪款——目录欠一行，不是「还没跑过」", () => {
    const [row] = cloudContextRows([created(), envelope("a_1", STRANGER), reply("a_1", STRANGER, 10, 5)], null);
    expect(contextRowSummary(row!)).toBe(`窗口未知（${STRANGER} 不在目录里）`);
  });

  it("一次都没跑过、团队默认款也探不到：还没跑过", () => {
    const [row] = cloudContextRows([created()], null);
    expect(contextRowSummary(row!)).toBe("还没跑过");
  });
});
