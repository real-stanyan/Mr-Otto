// applyResidueEvent（issue #759，review finding 1/2）——渲染层对
// residue_detected / residue_cleaned 两条直播事件的归约核心。
//
// finding 1：turn 收口那批（origin:"turn"）只该并入 liveResidue,不该弹出
// 「本次残留」弹窗；只有归档（origin:"archive"，或旧日志没有这个字段）才
// 该弹。且 bootResidue 弹窗还开着时不该叠第二层。
// finding 2：residue_cleaned 无论 ok 与否都要把对应条目从 bootResidue /
// liveResidue 两份里精确摘除（语义对齐 residueProjection.pendingResidue），
// dismissBootResidue/dismissLiveResidue 只应该关弹窗,不该动数组本身。

import { describe, expect, it } from "vitest";
import { applyResidueEvent, useChat } from "../../src/renderer/src/store.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { ResidueItem } from "../../src/shared/residue.js";

const base = { sessionId: "s1", ts: 0 };

const item = (id: string, overrides: Partial<ResidueItem> = {}): ResidueItem => ({
  detector: "process_groups",
  id,
  label: id,
  confidence: "owned",
  cleanupHint: `kill 进程组 ${id}`,
  ...overrides,
});

describe("applyResidueEvent", () => {
  it("origin:'turn' 只并入 liveResidue，不置 liveResidueOpen", () => {
    const e = { ...base, seq: 1, type: "residue_detected", items: [item("111")], origin: "turn" } as unknown as SessionEvent;
    const next = applyResidueEvent({ bootResidue: [], liveResidue: [], bootResidueOpen: false }, e);
    expect(next.liveResidue?.map((i) => i.id)).toEqual(["111"]);
    expect(next.liveResidueOpen).toBeUndefined(); // 没被这条改动过——不弹窗
  });

  it("origin:'archive' 并入 liveResidue 且置 liveResidueOpen=true", () => {
    const e = { ...base, seq: 1, type: "residue_detected", items: [item("111")], origin: "archive" } as unknown as SessionEvent;
    const next = applyResidueEvent({ bootResidue: [], liveResidue: [], bootResidueOpen: false }, e);
    expect(next.liveResidueOpen).toBe(true);
  });

  it("旧日志没有 origin 字段——向前兼容按 archive 处理，宁可多弹一次也不吞", () => {
    const e = { ...base, seq: 1, type: "residue_detected", items: [item("111")] } as unknown as SessionEvent;
    const next = applyResidueEvent({ bootResidue: [], liveResidue: [], bootResidueOpen: false }, e);
    expect(next.liveResidueOpen).toBe(true);
  });

  it("bootResidue 弹窗还开着时，即使是 archive 也不叠第二层 Dialog（sequencing）", () => {
    const e = { ...base, seq: 1, type: "residue_detected", items: [item("111")], origin: "archive" } as unknown as SessionEvent;
    const next = applyResidueEvent({ bootResidue: [], liveResidue: [], bootResidueOpen: true }, e);
    expect(next.liveResidueOpen).toBeUndefined(); // 没被置 true
    // 但 items 照样并入——bootResidue 弹窗关掉后角标能立刻看到这条
    expect(next.liveResidue?.map((i) => i.id)).toEqual(["111"]);
  });

  it("residue_cleaned 按 detector:id 从 bootResidue 和 liveResidue 两份里都精确摘除，不管 ok", () => {
    const cleaned = item("111");
    const e = {
      ...base, seq: 2, type: "residue_cleaned", item: cleaned, result: { id: "111", ok: false },
    } as unknown as SessionEvent;
    const next = applyResidueEvent(
      { bootResidue: [item("111"), item("222")], liveResidue: [item("111"), item("333")], bootResidueOpen: false },
      e
    );
    expect(next.bootResidue?.map((i) => i.id)).toEqual(["222"]);
    expect(next.liveResidue?.map((i) => i.id)).toEqual(["333"]);
  });

  it("residue_cleaned 对不匹配的 key 不动其它条目", () => {
    const e = {
      ...base, seq: 2, type: "residue_cleaned", item: item("does-not-exist"), result: { id: "does-not-exist", ok: true },
    } as unknown as SessionEvent;
    const next = applyResidueEvent({ bootResidue: [item("111")], liveResidue: [], bootResidueOpen: false }, e);
    expect(next.bootResidue?.map((i) => i.id)).toEqual(["111"]);
  });

  it("不认识的事件类型原样透传空 patch", () => {
    const e = { ...base, seq: 3, type: "user_message", content: "hi" } as unknown as SessionEvent;
    expect(applyResidueEvent({ bootResidue: [], liveResidue: [], bootResidueOpen: false }, e)).toEqual({});
  });
});

describe("dismissBootResidue / dismissLiveResidue / openLiveResidue（review finding 2：只关/开弹窗，不碰数组）", () => {
  it("dismissLiveResidue 只关弹窗——勾了 A 清完、B 没勾也不该被这一下吞掉", () => {
    useChat.setState({ liveResidue: [item("A"), item("B")], liveResidueOpen: true });
    useChat.getState().dismissLiveResidue();
    expect(useChat.getState().liveResidueOpen).toBe(false);
    expect(useChat.getState().liveResidue.map((i) => i.id)).toEqual(["A", "B"]); // 都还在
  });

  it("dismissBootResidue 同理：只关弹窗，不清 bootResidue", () => {
    useChat.setState({ bootResidue: [item("A")], bootResidueOpen: true });
    useChat.getState().dismissBootResidue();
    expect(useChat.getState().bootResidueOpen).toBe(false);
    expect(useChat.getState().bootResidue.map((i) => i.id)).toEqual(["A"]);
  });

  it("openLiveResidue 把角标点开的动作落成 liveResidueOpen=true", () => {
    useChat.setState({ liveResidueOpen: false });
    useChat.getState().openLiveResidue();
    expect(useChat.getState().liveResidueOpen).toBe(true);
  });
});
