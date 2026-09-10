import { describe, expect, it } from "vitest";
import {
  GROW_STEP,
  INITIAL_WINDOW,
  SMALL_LIST_MARGIN,
  growHidden,
  initialHidden,
  planReveal,
  revealHidden,
  windowIds,
} from "../../src/renderer/src/lib/messageWindow.js";

describe("messageWindow — 时间线窗口(ADR-0285)", () => {
  it("小列表不启用窗口:总数 ≤ INITIAL_WINDOW + 余量时一条都不藏", () => {
    expect(initialHidden(0)).toBe(0);
    expect(initialHidden(INITIAL_WINDOW)).toBe(0);
    expect(initialHidden(INITIAL_WINDOW + SMALL_LIST_MARGIN)).toBe(0);
    // 越过余量才开窗:只留后缀 INITIAL_WINDOW 条
    expect(initialHidden(INITIAL_WINDOW + SMALL_LIST_MARGIN + 1)).toBe(SMALL_LIST_MARGIN + 1);
    expect(initialHidden(624)).toBe(624 - INITIAL_WINDOW);
  });

  it("哨兵补挂按 GROW_STEP 收,到 0 为止(窗口只增不缩:没有反向的函数)", () => {
    expect(growHidden(500, 624)).toBe(500 - GROW_STEP);
    expect(growHidden(GROW_STEP, 624)).toBe(0);
    expect(growHidden(10, 624)).toBe(0);
    // 切会话那一帧:旧会话的 hidden 撞上新的短列表,夹住不切成空
    expect(growHidden(500, 40)).toBe(0);
    expect(growHidden(0, 624)).toBe(0);
  });

  it("reveal 桥:目标在窗口外就把上沿抬到它,已在窗口内不动", () => {
    expect(revealHidden(500, 300)).toBe(300);   // 抬到目标所在那条
    expect(revealHidden(500, 500)).toBe(500);   // 已在窗口内(第一条可见)
    expect(revealHidden(500, 623)).toBe(500);
    expect(revealHidden(0, 10)).toBe(0);
  });

  it("windowIds 切后缀;hidden ≤ 0 原样返回同一个引用(调用方按引用判重)", () => {
    const ids = ["a", "b", "c", "d"];
    expect(windowIds(ids, 2)).toEqual(["c", "d"]);
    expect(windowIds(ids, 0)).toBe(ids);
    expect(windowIds(ids, -1)).toBe(ids);
  });
});

describe("planReveal — reveal 桥的处理计划(ADR-0285 决定 3)", () => {
  // 对齐判据的来源是 buildSectionAnchors 的正查产物(分区 2 挂在消息 "12" 上,
  // 意味着它的 startSeq 落在不产消息的事件上、顺延到了下一条)——planReveal
  // 只反查这张表,不自己拿 startSeq 再比一遍
  const ids = ["10", "11", "12", "13", "live"];
  const anchors = new Map<string, number[]>([["12", [2]]]);
  const req = { section: 2, nonce: 1, sessionId: "s1" };

  it("旧会话的 revealRequest 不作用于新会话 —— passive effect 子先于父,App 的清理赶不上那一帧", () => {
    // 这就是 8df966d6 修歪的那条:清理放在 App 的 effect 里,而 OttoThread 的
    // reveal effect 先跑。判据于是落在请求自带的 sessionId 上
    expect(planReveal(req, "s2", anchors, ids, 3)).toEqual({ kind: "stale" });
  });

  it("目标在窗口外 → grow,上沿抬到目标那条;已在窗口内 → scroll", () => {
    // "12" 在 ids 下标 2:hidden 3 时它在窗口外 → revealHidden(3,2)=2
    expect(planReveal(req, "s1", anchors, ids, 3)).toEqual({ kind: "grow", to: 2 });
    expect(planReveal(req, "s1", anchors, ids, 2)).toEqual({
      kind: "scroll",
      selector: '[data-section="2"]',
    });
  });

  it("分区没有对应的锚点(越界/没产消息)→ settle,无处可滚也收口", () => {
    expect(planReveal({ ...req, section: 7 }, "s1", anchors, ids, 3)).toEqual({ kind: "settle" });
  });
});
