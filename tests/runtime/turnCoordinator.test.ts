import { describe, it, expect } from "vitest";
import { createTurnCoordinator } from "../../services/runtime/src/turnCoordinator.js";

describe("turn 协调器", () => {
  it("mention 且空闲 → start_turn", () => {
    const c = createTurnCoordinator();
    expect(c.onChat(true)).toBe("start_turn");
  });
  it("非 mention 永远只落日志", () => {
    const c = createTurnCoordinator();
    expect(c.onChat(false)).toBe("logged_only");
  });
  it("turn 跑着时 mention 不排队、不点火——注入语义", () => {
    const c = createTurnCoordinator();
    expect(c.onChat(true)).toBe("start_turn");
    c.turnStarted();
    expect(c.onChat(true)).toBe("logged_only");   // 没有隐形队列
    expect(c.isRunning()).toBe(true);
    c.turnEnded();
    expect(c.onChat(true)).toBe("start_turn");    // 结束后可再点火
  });
  it("onChat 回 start_turn 后、turnStarted 前，第二条 mention 也不重复点火", () => {
    const c = createTurnCoordinator();
    expect(c.onChat(true)).toBe("start_turn");
    expect(c.onChat(true)).toBe("logged_only");   // start 已被认领，装配层保证随后 turnStarted
  });
  it("turnEnded 在 claimed 态也能恢复到 idle（异常路径：turnStarted 失败）", () => {
    const c = createTurnCoordinator();
    expect(c.onChat(true)).toBe("start_turn");
    c.turnEnded();
    expect(c.onChat(true)).toBe("start_turn");
  });
});
