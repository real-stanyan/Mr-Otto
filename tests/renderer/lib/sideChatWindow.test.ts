import { describe, expect, it } from "vitest";
import {
  clampToContainer,
  defaultPosition,
  sideChatRows,
  SIDE_CHAT_SIZE,
} from "../../../src/renderer/src/lib/sideChatWindow.js";
import type { SessionEvent } from "../../../src/session/events.js";

const win = { width: 300, height: 400 };
const container = { width: 1000, height: 800 };

describe("clampToContainer", () => {
  it("容器内的位置原样返回", () => {
    expect(clampToContainer({ x: 100, y: 50 }, win, container)).toEqual({ x: 100, y: 50 });
  });

  it("拖出右下角被夹回边缘（标题栏必须留在容器里）", () => {
    expect(clampToContainer({ x: 9999, y: 9999 }, win, container)).toEqual({ x: 700, y: 400 });
  });

  it("拖出左上角夹回 0", () => {
    expect(clampToContainer({ x: -50, y: -50 }, win, container)).toEqual({ x: 0, y: 0 });
  });

  it("容器比浮窗还小：钉在 0，不为负（负值 = 标题栏出界抓不回来）", () => {
    expect(clampToContainer({ x: 10, y: 10 }, win, { width: 200, height: 200 })).toEqual({ x: 0, y: 0 });
  });
});

describe("defaultPosition", () => {
  it("右下角留 24 边距", () => {
    expect(defaultPosition(win, container)).toEqual({ x: 1000 - 300 - 24, y: 800 - 400 - 24 });
  });

  it("默认尺寸下也不越界", () => {
    const p = defaultPosition(SIDE_CHAT_SIZE, { width: 900, height: 600 });
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
  });
});

describe("sideChatRows", () => {
  const base = (seq: number) => ({ seq, sessionId: "side", ts: seq });
  it("只演三种事：用户说的、模型答的、turn 的死因；空 content 的纯工具回合不上屏", () => {
    const events: SessionEvent[] = [
      { ...base(0), type: "session_created", workspace: "/w", sideChat: true },
      { ...base(1), type: "user_message", content: "帮我看看" },
      { ...base(2), type: "assistant_message", content: "", model: "m", toolCalls: [] },
      { ...base(3), type: "assistant_message", content: "看完了", model: "m" },
      { ...base(4), type: "turn_ended", outcome: "error", error: "模型断线" },
    ];
    expect(sideChatRows(events)).toEqual([
      { kind: "user", key: "side:1", text: "帮我看看" },
      { kind: "assistant", key: "side:3", text: "看完了" },
      { kind: "error", key: "side:4", text: "模型断线" },
    ]);
  });

  it("正常收尾的 turn_ended 不上屏", () => {
    expect(sideChatRows([{ ...base(1), type: "turn_ended", outcome: "completed" }])).toEqual([]);
  });
});
