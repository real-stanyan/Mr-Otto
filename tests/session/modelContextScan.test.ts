import { describe, expect, it } from "vitest";
import { EventStore } from "../../src/session/store.js";
import { boundedContextEvents } from "../../src/session/modelContextScan.js";
import { deriveMessages, DEFAULT_COMPRESSION } from "../../src/session/deriveMessages.js";
import { barrenEventIndexes } from "../../src/session/barrenTurns.js";
import { contextUsed } from "../../src/shared/contextEstimate.js";
import { activeSkills } from "../../src/session/activeSkills.js";
import type { NewSessionEvent } from "../../src/session/store.js";

// 模型上下文有界重建（issue #351）：反向扫描 + 有界 cutoff。
// 等价性契约：deriveMessages(有界集) === deriveMessages(全量)，逐字节。

const S = "s1";
let ts = 0;
// Omit 在联合类型上会塌成公共键，逐事件写字面量会全线报错——测试造日志
// 用宽形状 + 收口断言（append 落盘时 schema 由运行时数据说话）
type LooseEvent = { type: NewSessionEvent["type"] } & Record<string, unknown>;
function put(store: EventStore, e: LooseEvent): void {
  store.append({ sessionId: S, ts: ++ts, ...e } as unknown as NewSessionEvent);
}

/** 一个普通 turn：user → assistant(带工具) → 结果 → 收口 */
function turn(store: EventStore, n: number): void {
  put(store, { type: "user_message", content: `请求 ${n}` });
  put(store, {
    type: "assistant_message", content: "", model: "m",
    toolCalls: [{ id: `c${n}`, name: "bash", args: { cmd: `ls ${n}` } }],
  });
  put(store, { type: "tool_execution_started", toolCallId: `c${n}` });
  put(store, { type: "tool_result", toolCallId: `c${n}`, status: "ok", output: `out ${n}` });
  put(store, { type: "assistant_message", content: `答复 ${n}`, model: "m", usage: { promptTokens: 100, completionTokens: 20 } });
  put(store, { type: "turn_ended", outcome: "completed" });
}

function assertEquivalent(store: EventStore): void {
  const full = store.load(S);
  const bounded = boundedContextEvents(store, S);
  expect(bounded).not.toBeNull();
  expect(deriveMessages(bounded!, DEFAULT_COMPRESSION)).toEqual(deriveMessages(full, DEFAULT_COMPRESSION));
  expect(deriveMessages(bounded!)).toEqual(deriveMessages(full));
  // 占用估算同一把尺子（engine 每圈对同一份日志既投影又估占用）
  expect(contextUsed(bounded!, barrenEventIndexes(bounded!))).toBe(
    contextUsed(full, barrenEventIndexes(full))
  );
}

describe("boundedContextEvents（issue #351）", () => {
  it("常规：checkpoint 后接着聊——有界重建与全量逐字节一致", () => {
    const store = new EventStore(":memory:");
    put(store, { type: "session_created", title: "t", workspace: "/w" });
    put(store, { type: "memory_loaded", memory: "§ 记着点事", user: "" });
    for (let i = 1; i <= 8; i++) turn(store, i);
    put(store, { type: "context_compacted", summary: "前八轮的摘要", model: "m" });
    for (let i = 9; i <= 11; i++) turn(store, i);
    assertEquivalent(store);
    store.close();
  });

  it("工作区记忆快照（#949）：checkpoint 之前落的 workspace_memory_loaded 幸存于有界重建", () => {
    const store = new EventStore(":memory:");
    put(store, { type: "session_created", title: "t", workspace: "/w", cloud: { workspaceId: "w1" } });
    put(store, { type: "workspace_memory_loaded", agentId: "ops", agentName: "运营", shared: "[运营] 销量含退款", own: "" });
    for (let i = 1; i <= 8; i++) turn(store, i);
    put(store, { type: "context_compacted", summary: "前八轮的摘要", model: "m" });
    for (let i = 9; i <= 11; i++) turn(store, i);
    assertEquivalent(store);
    store.close();
  });

  it("agent 身份快照（#957 A-3）：checkpoint 之前落的 agent_briefed 幸存于有界重建", () => {
    const store = new EventStore(":memory:");
    put(store, { type: "session_created", title: "t", workspace: "/w", cloud: { workspaceId: "w1" } });
    put(store, { type: "agent_briefed", agentId: "ops", name: "运营", instructions: "你管店铺运营", roster: [] });
    for (let i = 1; i <= 8; i++) turn(store, i);
    put(store, { type: "context_compacted", summary: "前八轮的摘要", model: "m" });
    for (let i = 9; i <= 11; i++) turn(store, i);
    // 有界集里必须还有这条——不然投影出来的 system 里没有身份，而全量里有
    const bounded = boundedContextEvents(store, S)!;
    expect(bounded.some((e) => e.type === "agent_briefed")).toBe(true);
    assertEquivalent(store);
    store.close();
  });

  it("auto-compact 中途触发：当前请求原文兜底重注（issue #193 路径）也一致", () => {
    const store = new EventStore(":memory:");
    put(store, { type: "session_created", title: "t", workspace: "/w" });
    for (let i = 1; i <= 3; i++) turn(store, i);
    // 第 4 轮跑到一半触发 auto-compact：user 落了、compact 落了、turn 还没收口
    put(store, { type: "user_message", content: "正在处理的请求" });
    put(store, { type: "context_compacted", summary: "摘要吞了前三轮和当前请求", model: "m" });
    put(store, { type: "assistant_message", content: "继续处理", model: "m" });
    put(store, { type: "turn_ended", outcome: "completed" });
    assertEquivalent(store);
    store.close();
  });

  it("checkpoint 前最后一个 turn 是空跑：回溯到更早的活 turn，判定一致", () => {
    const store = new EventStore(":memory:");
    put(store, { type: "session_created", title: "t", workspace: "/w" });
    turn(store, 1);
    // 空跑：发出去就中断，模型一个字没回
    put(store, { type: "user_message", content: "被打断的请求" });
    put(store, { type: "turn_ended", outcome: "aborted" });
    put(store, { type: "context_compacted", summary: "摘要", model: "m" });
    turn(store, 2);
    assertEquivalent(store);
    store.close();
  });

  it("skill 台账 + 微压缩：清场重注入的 skill 与 checkpoint 后的 micro 都一致", () => {
    const store = new EventStore(":memory:");
    put(store, { type: "session_created", title: "t", workspace: "/w" });
    put(store, { type: "skill_invoked", name: "review", content: "审查指令全文" });
    turn(store, 1);
    put(store, { type: "skill_invoked", name: "deploy", content: "部署指令全文", args: "prod" });
    turn(store, 2);
    put(store, { type: "context_compacted", summary: "摘要", model: "m" });
    turn(store, 3);
    turn(store, 4);
    turn(store, 5);
    // checkpoint 之后的微压缩：吸收第 3 轮的 assistant/tool
    const cover = store.load(S).filter((e) => e.type === "turn_ended").at(-3)!.seq;
    put(store, { type: "micro_compacted", summary: "第 3 轮的经过", coversUpTo: cover, model: "m" });
    assertEquivalent(store);
    store.close();
  });

  it("checkpoint 之前启用又停用的 skill 不能诈尸：停用记录必须跟启用一起被捞进扫描窗口", () => {
    const store = new EventStore(":memory:");
    put(store, { type: "session_created", title: "t", workspace: "/w" });
    put(store, { type: "skill_invoked", name: "review", content: "审查指令全文" });
    turn(store, 1);
    put(store, { type: "skill_invoked", name: "deploy", content: "部署指令全文", args: "prod" });
    turn(store, 2);
    // review 在 checkpoint 之前就已停用——它和上面两条 skill_invoked 一样落在
    // 「被压缩清场」的历史区间里，只是 turn(3) 把它推得比 head 的判定窗口更远。
    // 只捞 skill_invoked 不捞 skill_released 的话，这条停用连同它所在的那段
    // 历史一起被有界重建丢弃，台账就看不到「review 已经停了」
    put(store, { type: "skill_released", name: "review" });
    turn(store, 3);
    put(store, { type: "context_compacted", summary: "摘要", model: "m" });
    turn(store, 4);

    // 扫描结果里两种事件都要在——只有启用没有停用，台账就配不出正确答案
    const bounded = boundedContextEvents(store, S)!;
    expect(bounded.some((e) => e.type === "skill_invoked")).toBe(true);
    expect(bounded.some((e) => e.type === "skill_released")).toBe(true);
    // 喂给台账之后：review 已停用，只剩 deploy 仍然生效
    const barren = barrenEventIndexes(bounded);
    expect([...activeSkills(bounded, barren).keys()]).toEqual(["deploy"]);

    // 等价性契约同样会炸：有界重建如果漏了这条停用，压缩摘要之后会多出一条
    // 「review 仍然生效」的重注入消息，而全量重建不会——两边逐字节不再相等
    assertEquivalent(store);
    store.close();
  });

  it("没有 checkpoint：返回 null（调用方退回全量）", () => {
    const store = new EventStore(":memory:");
    put(store, { type: "session_created", title: "t", workspace: "/w" });
    turn(store, 1);
    expect(boundedContextEvents(store, S)).toBeNull();
    store.close();
  });

  it("重建读的事件量与尾部成正比，不与总长成正比（1000+ 事件日志）", () => {
    const store = new EventStore(":memory:");
    put(store, { type: "session_created", title: "t", workspace: "/w" });
    for (let i = 1; i <= 200; i++) turn(store, i); // 1200+ 事件
    put(store, { type: "context_compacted", summary: "两百轮的摘要", model: "m" });
    turn(store, 201);
    const full = store.load(S);
    const bounded = boundedContextEvents(store, S)!;
    expect(full.length).toBeGreaterThan(1200);
    expect(bounded.length).toBeLessThan(30); // 头部幸存者 + 最后一个 turn 段 + 尾段
    assertEquivalent(store);
    store.close();
  });
});
