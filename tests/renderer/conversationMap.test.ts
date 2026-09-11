// conversationMap（ADR-0292）：会话地图的纯逻辑——一轮怎么切、每一格叫什么、此刻在读哪一轮。
// 元件那半（刻度、悬停卡、键盘）钉在 conversationMapElement.test.tsx；与时间线窗口的
// 接线钉在 ottoThreadReveal.test.tsx。
//
// 这份逻辑取代的是「分区轨」：那条轨的格子由便宜模型判「话题换了」，真库里 15 条长会话
// 只有 2 条凑够两个分区，于是实际用的时候从来不出现（#1259）。这里的格子是投影——
// 第一组用例钉的就是「两轮对话 = 两格」这件事本身，不需要任何模型判断。

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessage } from "@assistant-ui/react";

import {
  cloudConversationEntries,
  cutAtWord,
  describeTurn,
  groupIntoTurns,
  measureTurns,
  readingLine,
  reuseEntries,
  scrollToTurn,
  turnOwners,
  type ConversationMapEntry,
} from "../../src/renderer/src/lib/conversationMap.js";
import { voiceCallCards } from "../../src/renderer/src/lib/cloudTimeline.js";
import { SYSTEM_SPEAKER_UID } from "../../src/shared/promptSafe.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

type Part = { type: string; text?: string; toolName?: string };

/** 只填 conversationMap 读得到的那几格 —— 其余字段它一个都不碰 */
function msg(id: string, role: "user" | "assistant" | "system", content: Part[], custom: Record<string, unknown> = {}): ThreadMessage {
  return { id, role, content, metadata: { custom }, attachments: [] } as unknown as ThreadMessage;
}

describe("groupIntoTurns / describeTurn（本地会话那半）", () => {
  const messages = [
    msg("0", "system", []),
    msg("1", "user", [{ type: "text", text: "帮我修登录\n顺便看看注册" }]),
    msg("2", "assistant", [{ type: "reasoning", text: "想一想" }, { type: "tool-call", toolName: "read_file" }]),
    msg("3", "assistant", [{ type: "text", text: "## 结论\n- 改好了 **auth.ts**\n\n> 注意重启" }]),
    msg("4", "user", [{ type: "text", text: "谢谢" }]),
  ];

  it("一句人话 + 回它的那几条 = 一轮；两轮就是两格（不需要任何模型判断）；system 审计行不进任何一轮", () => {
    const turns = groupIntoTurns(messages);
    expect(turns.map((t) => t.head.id)).toEqual(["1", "4"]);
    expect(turns[0]!.members.map((m) => m.id)).toEqual(["1", "2", "3"]);
    expect(turns.map(describeTurn)).toEqual([
      // 预览取第一条**有字**的回答（只跑工具的那条跳过），剥掉 markdown 的行首记号与行内粗体
      { id: "1", title: "帮我修登录", preview: "结论 改好了 auth.ts 注意重启" },
      { id: "4", title: "谢谢" },
    ]);
  });

  it("还在答的那一轮：预览退回这句话自己剩下的部分", () => {
    const [entry] = groupIntoTurns([msg("1", "user", [{ type: "text", text: "帮我修登录\n顺便看看注册" }])]).map(describeTurn);
    expect(entry).toEqual({ id: "1", title: "帮我修登录", preview: "顺便看看注册" });
  });

  it("没有字的那一轮按内容起名：图片（本仓附件挂在 metadata.custom.otto）/ 工具 / 思考 / 兜底", () => {
    const photo = msg("1", "user", [], {
      otto: { attachments: [{ id: "sha256:x", mediaType: "image/png", bytes: 1 }] },
    });
    expect(describeTurn({ head: photo, members: [photo] }).title).toBe("图片");
    const bare = msg("2", "user", []);
    expect(describeTurn({ head: bare, members: [bare] }).title).toBe("消息");
    // 开头没有人话的那一段：没有当前轮时 assistant 自己起一轮（上游同一个判据）
    const lead = msg("3", "assistant", [{ type: "tool-call", toolName: "bash" }]);
    const turns = groupIntoTurns([lead]);
    expect(turns).toHaveLength(1);
    expect(describeTurn(turns[0]!).title).toBe("bash");
    const two = msg("4", "assistant", [
      { type: "tool-call", toolName: "bash" },
      { type: "tool-call", toolName: "read_file" },
    ]);
    expect(describeTurn({ head: two, members: [two] }).title).toBe("2 次工具调用");
    const think = msg("5", "assistant", [{ type: "reasoning", text: "…" }]);
    expect(describeTurn({ head: think, members: [think] }).title).toBe("思考");
  });

  it("标题按词切，不断在词中间；中文没有空格，退回硬切", () => {
    expect(cutAtWord("short", 72)).toBe("short");
    expect(cutAtWord("alpha beta gamma delta epsilon", 12)).toBe("alpha beta");
    expect(cutAtWord("一二三四五六七八九十", 4)).toBe("一二三四");
  });

  it("turnOwners：每条消息都能替它那一轮说「我在屏幕上」", () => {
    expect(Object.fromEntries(turnOwners(groupIntoTurns(messages)))).toEqual({
      "1": "1",
      "2": "1",
      "3": "1",
      "4": "4",
    });
  });

  it("reuseEntries：内容没变交回上一份（流式期间刻度不跟着每个 token 重渲），变了才换", () => {
    const prev: ConversationMapEntry[] = [{ id: "1", title: "a", preview: "x" }];
    expect(reuseEntries(prev, [{ id: "1", title: "a", preview: "x" }])).toBe(prev);
    const changed = [{ id: "1", title: "a", preview: "xy" }];
    expect(reuseEntries(prev, changed)).toBe(changed);
    const longer = [...prev, { id: "2", title: "b" }];
    expect(reuseEntries(prev, longer)).toBe(longer);
  });
});

describe("cloudConversationEntries（云会话那半）", () => {
  const ws: WorkspaceSnapshot = {
    id: "w", name: "W", ownerUid: "u1", connectors: [], sessions: [], sandboxApproval: "ask",
    agents: [
      { agentId: "a_1", name: "运营", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
      { agentId: "a_2", name: "广告", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
    ],
    members: [
      { uid: "u1", role: "owner", label: "Stan", avatarUrl: "" },
      { uid: "u2", role: "member", label: "小红", avatarUrl: "" },
    ],
  };
  const base = { sessionId: "s" } as const;
  const callChanged = (seq: number, ts: number, ids: string[]): SessionEvent => ({
    ...base, seq, ts, type: "voice_call_changed", ignorable: true, byUid: "u1",
    participants: ids.map((id) => ({ agentId: id, name: `快照${id}` })),
  });
  const events: SessionEvent[] = [
    { ...base, seq: 0, ts: 0, type: "session_created", workspace: "/w" },
    { ...base, seq: 1, ts: 1, type: "user_message", content: "[Stan]: @运营 帮我查下订单\n急", fromUid: "u1", mentions: ["a_1"] },
    // 中间步骤：时间线不画（hiddenFromCloudTimeline ⑥），地图也不拿它当预览
    { ...base, seq: 2, ts: 2, type: "assistant_message", content: "", model: "m", agentId: "a_1", toolCalls: [{ id: "t", name: "bash", args: {} }] },
    { ...base, seq: 3, ts: 3, type: "tool_result", toolCallId: "t", status: "ok", output: "x" },
    { ...base, seq: 4, ts: 4, type: "assistant_message", content: "查到了，三笔。\n\n第二笔退款了", model: "m", agentId: "a_1" },
    { ...base, seq: 5, ts: 5, type: "chat_message", fromUid: "u2", label: "小红", content: "我也看看", mention: false },
    // runtime 自己的发言、engine 注的回注：时间线上是旁白，不是谁说的一句
    { ...base, seq: 6, ts: 6, type: "chat_message", fromUid: SYSTEM_SPEAKER_UID, label: "系统", content: "接力到上限了", mention: false },
    { ...base, seq: 7, ts: 7, type: "user_message", content: "后台任务完成了", origin: "background" },
    // 一场通话：卡片自成一格，里面的话被卡吞掉
    callChanged(8, 10, ["a_1"]),
    { ...base, seq: 9, ts: 11, type: "user_message", content: "[Stan]: 你好", fromUid: "u1", voice: true },
    { ...base, seq: 10, ts: 12, type: "assistant_message", content: "在呢", model: "m", agentId: "a_1" },
    callChanged(11, 20, []),
    // 卡后面冒出来的答案不往卡身上挂预览
    { ...base, seq: 12, ts: 21, type: "assistant_message", content: "通话后补一句", model: "m", agentId: "a_2" },
    // 接力开场白：给模型看的，时间线不画（hiddenFromCloudTimeline ①）
    { ...base, seq: 13, ts: 22, type: "user_message", content: "[系统] 「运营」@ 了你", fromUid: "u1", mentions: ["a_2"], relay: { fromAgentId: "a_1", depth: 1 } },
  ];

  it("头 = 人说的话 + 通话卡；预览是第一条 agent 答案（带名字）；旁白 / 步骤 / 开场白都不是头", () => {
    const entries = cloudConversationEntries(events, ws, "u1", voiceCallCards(events, ws, "u1"));
    expect(entries).toEqual([
      { id: "1", title: "@运营 帮我查下订单", eyebrow: "Stan", preview: "运营：查到了，三笔。 第二笔退款了" },
      { id: "5", title: "我也看看", eyebrow: "小红" },
      { id: "8", title: "语音通话", preview: "运营、Stan · 2 句" },
    ]);
  });

  it("id 就是那一行的 seq —— 渲染循环照这份结果给头行打 data-turn-id，两边出自同一份判据", () => {
    const entries = cloudConversationEntries(events, ws, "u1", voiceCallCards(events, ws, "u1"));
    expect(entries.map((e) => e.id)).toEqual(["1", "5", "8"]);
  });
});

describe("readingLine / measureTurns（量位置）", () => {
  const box = (top: number, height: number) => ({ top, bottom: top + height, height }) as DOMRect;
  const viewport = (scrollTop: number): HTMLElement =>
    ({
      getBoundingClientRect: () => box(0, 500),
      clientHeight: 500,
      scrollHeight: 2000,
      scrollTop,
    }) as unknown as HTMLElement;
  const mark = (id: string, top: number, height = 100): HTMLElement =>
    ({ id, getBoundingClientRect: () => box(top, height) }) as unknown as HTMLElement;
  const owners: Record<string, string> = { m1: "1", m2: "1", m3: "3", m4: "4" };
  const ownerOf = (el: HTMLElement) => owners[el.id];

  it("判定线大半场钉在视口顶，最后一屏滑到底（离结尾不到一屏的那几格才点得亮）", () => {
    expect(readingLine(viewport(0))).toBe(1);
    expect(readingLine(viewport(1500))).toBe(501);
  });

  it("正在读的 = 最后一条过了线的那一轮；视口里有哪几轮；过了视口底就不再往下扫", () => {
    const marks = [mark("m1", -50), mark("m2", 100), mark("m3", 300), mark("m4", 600)];
    expect(measureTurns(viewport(0), marks, ownerOf)).toEqual({ current: "1", onScreen: ["1", "3"] });
  });

  it("一格都没过线：兜底第一个挂着的那一轮（时间线窗口上沿以上的不在 DOM 里）", () => {
    const marks = [mark("m3", 20), mark("m4", 200)];
    expect(measureTurns(viewport(0), marks, ownerOf).current).toBe("3");
  });

  it("最后一屏：线滑到底，最后一轮点得亮", () => {
    const marks = [mark("m1", 100), mark("m3", 400)];
    expect(measureTurns(viewport(1500), marks, ownerOf).current).toBe("3");
  });

  it("认不出的记号跳过：既不算当前，也不进视口名单", () => {
    const marks = [mark("stray", -10), mark("m3", 50)];
    expect(measureTurns(viewport(0), marks, ownerOf)).toEqual({ current: "3", onScreen: ["3"] });
  });
});

describe("scrollToTurn（点一格之后怎么滚、怎么落稳）", () => {
  const box = (top: number, height: number) => ({ top, bottom: top + height, height }) as DOMRect;
  /** 记下每一步往哪滚、怎么滚；scrollTop 夹在 [0, max]；监听器收着，用例自己派 */
  function fakeViewport(scrollTop: number, max = 100_000) {
    const calls: string[] = [];
    const listeners = new Map<string, Set<() => void>>();
    const vp = {
      scrollTop,
      getBoundingClientRect: () => box(0, 500),
      scrollTo: ({ top, behavior }: ScrollToOptions) => {
        calls.push(`to ${Math.round(top!)} ${behavior}`);
        vp.scrollTop = Math.min(max, Math.max(0, top!));
      },
      addEventListener: (type: string, fn: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
    };
    const fire = (type: string) => [...(listeners.get(type) ?? [])].forEach((fn) => fn());
    const listening = () => [...listeners.values()].reduce((n, set) => n + set.size, 0);
    return { vp, calls, fire, listening };
  }
  /** 目标元素：它在内容里的位置是 `at()`，相对视口的位置 = at() - scrollTop（内容换成真高时 at 会变） */
  const targetIn = (vp: { scrollTop: number }, at: () => number) =>
    ({ isConnected: true, getBoundingClientRect: () => box(at() - vp.scrollTop, 50) }) as unknown as HTMLElement;
  const motion = (reduce: boolean) =>
    vi.stubGlobal("window", { matchMedia: () => ({ matches: reduce }) });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("平滑滚到目标；scrollend 之后按住：一路上的消息换成了真高、目标挪了，就瞬时补回去，落稳才收手", () => {
    vi.useFakeTimers();
    motion(false);
    const f = fakeViewport(800);
    let at = 500;
    const onSettled = vi.fn();
    scrollToTurn(f.vp as unknown as HTMLElement, targetIn(f.vp, () => at), { onSettled });
    expect(f.calls).toEqual(["to 500 smooth"]);
    at = 725; // 落地时目标上方那条消息长高了 225px（真机那一回）
    f.fire("scrollend");
    expect(f.calls.at(-1)).toBe("to 725 instant");
    expect(onSettled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16 * 12);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(f.listening()).toBe(0); // 收手时把自己挂的监听都摘干净
  });

  it("用户在落地前后自己动了（滚轮 / 按下 / 键盘 / 触摸）：立刻放手，不替他拽回去", () => {
    vi.useFakeTimers();
    motion(false);
    const f = fakeViewport(800);
    let at = 500;
    const onSettled = vi.fn();
    scrollToTurn(f.vp as unknown as HTMLElement, targetIn(f.vp, () => at), { onSettled });
    at = 725;
    f.fire("wheel");
    expect(onSettled).toHaveBeenCalledTimes(1);
    f.fire("scrollend");
    vi.advanceTimersByTime(2000);
    expect(f.calls).toEqual(["to 500 smooth"]);
  });

  it("reveal 桥那条路（instant）与减动效都瞬时，按住从下一帧开始、不等 scrollend", () => {
    vi.useFakeTimers();
    motion(false);
    const f = fakeViewport(800);
    scrollToTurn(f.vp as unknown as HTMLElement, targetIn(f.vp, () => 300), { instant: true });
    expect(f.calls).toEqual(["to 300 instant"]);

    motion(true);
    const r = fakeViewport(800);
    scrollToTurn(r.vp as unknown as HTMLElement, targetIn(r.vp, () => 300));
    expect(r.calls).toEqual(["to 300 instant"]);
  });

  it("到不了顶的那一轮（最后一屏）：挪不动也算落稳，不空转到时限", () => {
    vi.useFakeTimers();
    motion(false);
    const f = fakeViewport(800, 900); // 最多只能滚到 900
    const onSettled = vi.fn();
    scrollToTurn(f.vp as unknown as HTMLElement, targetIn(f.vp, () => 1200), { instant: true, onSettled });
    vi.advanceTimersByTime(16 * 10);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("scrollend 一直不来：兜底时限到了照样开始按住", () => {
    vi.useFakeTimers();
    motion(false);
    const f = fakeViewport(800);
    let at = 500;
    scrollToTurn(f.vp as unknown as HTMLElement, targetIn(f.vp, () => at));
    at = 540;
    vi.advanceTimersByTime(1500);
    expect(f.calls.at(-1)).toBe("to 540 instant");
  });
});
