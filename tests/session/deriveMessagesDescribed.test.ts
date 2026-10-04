// runtime 的代读（#1491 P4）：image_described{agentId, forSeq} 折进它服务的那条发言、替掉 image_ref；
// 事件位置上不再单独注入；桌面那种没有 forSeq 的老形状投影逐字不变；作废的开场白连着它的代读一起跳。
import { describe, expect, it } from "vitest";
import { barrenEventIndexes } from "../../src/session/barrenTurns.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";
import { projectForAgent } from "../../src/session/agentView.js";

const id = "sha256:" + "a".repeat(64);
const img = { id, mediaType: "image/jpeg", bytes: 10 };

describe("带 forSeq 的 image_described", () => {
  it("折进 user_message：正文 + 一行说明 + 解析，没有 image_ref；事件位置上不注入", () => {
    const events: SessionEvent[] = [
      { seq: 1, sessionId: "s", ts: 1, type: "user_message", content: "[Stan]: 看这张", fromUid: "me", mentions: ["ops"], attachments: [img] },
      { seq: 2, sessionId: "s", ts: 2, type: "image_described", content: "一只水獭在吃鱼", model: "glm-4.6v-flash", agentId: "ops", forSeq: 1 },
    ];
    expect(deriveMessages(events)).toEqual([
      { role: "user", content: "[Stan]: 看这张\n[以上消息附带的图片由视觉模型 glm-4.6v-flash 代读——当前模型不支持直接看图，解析如下]\n一只水獭在吃鱼" },
    ]);
  });
  it("折进 chat_message 同样", () => {
    const events: SessionEvent[] = [
      { seq: 1, sessionId: "s", ts: 1, type: "chat_message", fromUid: "u2", label: "阿峰", content: "[图片]", mention: false, attachments: [img] },
      { seq: 2, sessionId: "s", ts: 2, type: "image_described", content: "一张发票", model: "v", agentId: "ops", forSeq: 1 },
    ];
    const out = deriveMessages(events);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ role: "user" });
    expect(typeof out[0]?.content).toBe("string");
    expect(out[0]?.content).toContain("[阿峰]: [图片]");
    expect(out[0]?.content).toContain("一张发票");
  });
  it("桌面那种没有 forSeq 的老形状：仍按事件位置注入一条 user，随后那条照旧带 image_ref", () => {
    const events: SessionEvent[] = [
      { seq: 1, sessionId: "s", ts: 1, type: "image_described", content: "一只水獭", model: "v" },
      { seq: 2, sessionId: "s", ts: 2, type: "user_message", content: "看这张", attachments: [img] },
    ];
    const out = deriveMessages(events);
    expect(out).toHaveLength(2);
    expect(out[0]?.content).toContain("以下是随后消息附带图片的解析");
    expect(out[1]).toEqual({ role: "user", content: [{ type: "text", text: "看这张" }, { type: "image_ref", id, mediaType: "image/jpeg" }] });
  });
  it("作废的开场白连着它后面那条代读一起跳", () => {
    const events: SessionEvent[] = [
      { seq: 1, sessionId: "s", ts: 1, type: "user_message", content: "看这张", attachments: [img] },
      { seq: 2, sessionId: "s", ts: 2, type: "image_described", content: "一只水獭", model: "v", agentId: "ops", forSeq: 1 },
      { seq: 3, sessionId: "s", ts: 3, type: "turn_ended", outcome: "error", error: "boom" } as unknown as SessionEvent,
      { seq: 4, sessionId: "s", ts: 4, type: "user_message", content: "再来" },
    ];
    expect([...barrenEventIndexes(events)].sort()).toEqual([0, 1]);
  });
  it("别只的代读按 agentId 挡在外面，自己的留着", () => {
    const events: SessionEvent[] = [
      { seq: 1, sessionId: "s", ts: 1, type: "user_message", content: "看这张", fromUid: "me", mentions: ["ops", "dev"], attachments: [img] },
      { seq: 2, sessionId: "s", ts: 2, type: "image_described", content: "给 ops 读的", model: "v", agentId: "ops", forSeq: 1 },
      { seq: 3, sessionId: "s", ts: 3, type: "image_described", content: "给 dev 读的", model: "v", agentId: "dev", forSeq: 1 },
    ];
    const forOps = projectForAgent(events, "ops");
    expect(forOps.map((e) => e.seq)).toEqual([1, 2]);
    const forDev = projectForAgent(events, "dev");
    expect(forDev.map((e) => e.seq)).toEqual([1, 3]);
  });
});
