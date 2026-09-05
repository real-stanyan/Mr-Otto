import { describe, it, expect } from "vitest";
import { createTurnCoordinator, type TurnJob } from "../../services/runtime/src/turnCoordinator.js";

const job = (agentId: string): TurnJob => ({ agentId, fromUid: "u1", label: "alice", text: "干活" });

/** 调用方的标准消费形状 —— 测试里复用它,免得每条各写一遍 */
function drain(c: ReturnType<typeof createTurnCoordinator>): string[] {
  const ran: string[] = [];
  let j: TurnJob | null;
  while ((j = c.nextJob()) !== null) ran.push(j.agentId);
  return ran;
}

describe("turnCoordinator 串行队列（#928 切片 1a）", () => {
  it("空闲时第一条回 start_turn,且它本身也在队里", () => {
    const c = createTurnCoordinator();
    expect(c.enqueue(job("ops"))).toBe("start_turn");
    expect(drain(c)).toEqual(["ops"]);
  });

  it("排空之前进来的排队,按先来后到跑", () => {
    const c = createTurnCoordinator();
    expect(c.enqueue(job("ops"))).toBe("start_turn");
    expect(c.enqueue(job("ads"))).toBe("queued");
    expect(drain(c)).toEqual(["ops", "ads"]);
  });

  it("没点名的发言不进队 —— 它只落 chat_message,靠投影天然生效", () => {
    const c = createTurnCoordinator();
    expect(c.enqueue({ ...job("ops"), agentId: "" })).toBe("logged_only");
    expect(drain(c)).toEqual([]);
  });

  it("同一只已经在队里就不重复排 —— 连点三下 @运营 不该跑三遍", () => {
    const c = createTurnCoordinator();
    expect(c.enqueue(job("ops"))).toBe("start_turn");
    expect(c.enqueue(job("ops"))).toBe("logged_only");
    expect(drain(c)).toEqual(["ops"]);
  });

  it("排空之后再来一条,又是 start_turn —— 一轮结束协调器归 idle", () => {
    const c = createTurnCoordinator();
    c.enqueue(job("ops"));
    drain(c);
    expect(c.isRunning()).toBe(false);
    expect(c.enqueue(job("ads"))).toBe("start_turn");
  });

  it("isRunning 在排空期间为真 —— daemon 用它判「这个工作区此刻在跑吗」", () => {
    const c = createTurnCoordinator();
    c.enqueue(job("ops"));
    expect(c.isRunning()).toBe(true);
    expect(c.nextJob()).toMatchObject({ agentId: "ops" });
    expect(c.isRunning()).toBe(true); // 还没排空,这一轮还在跑
    expect(c.nextJob()).toBeNull();
    expect(c.isRunning()).toBe(false);
  });
});
