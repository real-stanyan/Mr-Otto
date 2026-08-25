import { describe, it, expect, vi } from "vitest";
import {
  createSimInputBridge,
  type SimInputChild,
} from "../../src/main/simInputBridge.js";

/** 假 helper 进程:记下写进去的每一行,能被测试驱动着吐回复、崩溃 */
function fakeChild() {
  const written: string[] = [];
  let onData: ((b: Buffer) => void) | null = null;
  let onExit: (() => void) | null = null;
  let killed = 0;
  const child: SimInputChild = {
    stdin: { write: (s) => void written.push(s) },
    stdout: { on: (_ev, cb) => void (onData = cb) },
    on: (_ev, cb) => void (onExit = cb),
    kill: () => void killed++,
  };
  return {
    child,
    written,
    get killed() {
      return killed;
    },
    /** 按 id 回一条 */
    reply: (o: object) => onData?.(Buffer.from(JSON.stringify(o) + "\n")),
    raw: (s: string) => onData?.(Buffer.from(s)),
    crash: () => onExit?.(),
    lastRequest: () => JSON.parse(written[written.length - 1]!),
  };
}

describe("模拟器输入桥", () => {
  it("按 id 认领回复 —— 乱序回也能各归各家", async () => {
    const f = fakeChild();
    const bridge = createSimInputBridge({ binPath: "/x", spawn: () => f.child });
    const a = bridge.send({ type: "tap", x: 1, y: 2 });
    const b = bridge.send({ type: "probe" });
    const [ra, rb] = [JSON.parse(f.written[0]!), JSON.parse(f.written[1]!)];
    // 后发的先回
    f.reply({ id: rb.id, ok: true, trusted: true });
    f.reply({ id: ra.id, ok: true });
    expect((await b).trusted).toBe(true);
    expect((await a).ok).toBe(true);
    bridge.dispose();
  });

  it("一行被切成两段到达也认得出来(NDJSON 的行缓冲)", async () => {
    const f = fakeChild();
    const bridge = createSimInputBridge({ binPath: "/x", spawn: () => f.child });
    const p = bridge.send({ type: "probe" });
    const id = f.lastRequest().id;
    f.raw(`{"id":${id},"ok":tr`);
    f.raw('ue}\n');
    expect((await p).ok).toBe(true);
    bridge.dispose();
  });

  it("helper 崩了:挂起的请求立刻收到人话,不是永远挂着", async () => {
    const f = fakeChild();
    const bridge = createSimInputBridge({ binPath: "/x", spawn: () => f.child });
    const p = bridge.send({ type: "tap", x: 1, y: 1 });
    f.crash();
    await expect(p).rejects.toThrow(/退出/);
    bridge.dispose();
  });

  it("崩了之后下一次调用重开一个 —— 但反复崩就不再重开", async () => {
    let spawned = 0;
    let cur = fakeChild();
    const bridge = createSimInputBridge({
      binPath: "/x",
      spawn: () => {
        spawned++;
        cur = fakeChild();
        return cur.child;
      },
    });
    for (let i = 0; i < 5; i++) {
      const p = bridge.send({ type: "probe" });
      cur.crash();
      await expect(p).rejects.toThrow();
    }
    // MAX_RESTARTS = 3:第一次 spawn + 三次重开 = 4,之后拒绝
    expect(spawned).toBe(4);
    await expect(bridge.send({ type: "probe" })).rejects.toThrow(/反复退出/);
    bridge.dispose();
  });

  it("超时给的是人话,不是永远挂着", async () => {
    vi.useFakeTimers();
    const f = fakeChild();
    const bridge = createSimInputBridge({ binPath: "/x", spawn: () => f.child, timeoutMs: 100 });
    const p = bridge.send({ type: "describe" });
    const assertion = expect(p).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
    vi.useRealTimers();
    bridge.dispose();
  });

  it("超时之后迟到的回复被丢掉,不会串到下一条请求上", async () => {
    vi.useFakeTimers();
    const f = fakeChild();
    const bridge = createSimInputBridge({ binPath: "/x", spawn: () => f.child, timeoutMs: 100 });
    const late = bridge.send({ type: "tap", x: 0, y: 0 });
    const lateId = f.lastRequest().id;
    const assertion = expect(late).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
    f.reply({ id: lateId, ok: true }); // 迟到:不该炸,也不该影响别人
    const next = bridge.send({ type: "probe" });
    f.reply({ id: f.lastRequest().id, ok: true, trusted: false });
    expect((await next).trusted).toBe(false);
    vi.useRealTimers();
    bridge.dispose();
  });

  it("dispose 之后不再接活,子进程被杀", async () => {
    const f = fakeChild();
    const bridge = createSimInputBridge({ binPath: "/x", spawn: () => f.child });
    void bridge.send({ type: "probe" }).catch(() => {});
    bridge.dispose();
    expect(f.killed).toBe(1);
    await expect(bridge.send({ type: "probe" })).rejects.toThrow(/已关闭/);
  });
});
