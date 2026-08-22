import { describe, expect, it, vi } from "vitest";
import { createIslandBridge, decodeCommand, encodeState } from "../../src/main/islandBridge.js";
import type { IslandSnapshot } from "../../src/shared/shellBridge.js";

const IDLE: IslandSnapshot = {
  sessionId: null, model: null, phase: "idle",
  currentTool: null, turnStartedAt: null, pendingApproval: null,
};

describe("encodeState", () => {
  it("一行 JSON 带换行结尾", () => {
    const line = encodeState(IDLE);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line.trim()).type).toBe("state");
    expect(JSON.parse(line.trim()).state.phase).toBe("idle");
  });
});

describe("decodeCommand", () => {
  it("解 send", () => {
    expect(decodeCommand('{"type":"send","sessionId":"s","text":"hi"}')).toEqual({
      type: "send", sessionId: "s", text: "hi",
    });
  });
  it("解 approve 带 grant", () => {
    expect(decodeCommand('{"type":"approve","sessionId":"s","callId":"c","grant":"session"}')).toEqual({
      type: "approve", sessionId: "s", callId: "c", grant: "session",
    });
  });
  it("坏 JSON → null", () => {
    expect(decodeCommand("not json")).toBeNull();
  });
  it("未知 type → null", () => {
    expect(decodeCommand('{"type":"wat"}')).toBeNull();
  });
});

function fakeChild() {
  const dataCbs: ((b: Buffer) => void)[] = [];
  const exitCbs: (() => void)[] = [];
  return {
    stdin: { writes: [] as string[], write(s: string) { this.writes.push(s); } },
    stdout: { on(_ev: "data", cb: (b: Buffer) => void) { dataCbs.push(cb); } },
    on(ev: "exit", cb: () => void) { if (ev === "exit") exitCbs.push(cb); },
    kill: vi.fn(),
    /** 测试入口:模拟子进程退出 */
    emitExit() { exitCbs.forEach((f) => f()); },
    /** 测试入口:模拟 stdout 吐一段字节 */
    emitData(s: string) { const b = Buffer.from(s, "utf8"); dataCbs.forEach((f) => f(b)); },
  };
}

describe("createIslandBridge", () => {
  it("崩溃后重启,超过 3 次不再起", () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawn = () => { const c = fakeChild(); children.push(c); return c as never; };
    createIslandBridge({ binPath: "/x", spawn, onCommand: () => {} });
    expect(children.length).toBe(1);
    // 每次都让"最新"那个子进程退出;初始 1 + 重启 3 = 4 个,第 4 次退出后放弃
    for (let i = 0; i < 5; i++) children[children.length - 1]!.emitExit();
    expect(children.length).toBe(4);
  });

  it("stdout 整行才解码,onCommand 收到 send", () => {
    let got: unknown = null;
    const c = fakeChild();
    createIslandBridge({ binPath: "/x", spawn: () => c as never, onCommand: (cmd) => { got = cmd; } });
    // 分两段喂,验证行缓冲:半行不触发,补齐换行才解码
    c.emitData('{"type":"send","sessionId":"s",');
    expect(got).toBeNull();
    c.emitData('"text":"hi"}\n');
    expect(got).toEqual({ type: "send", sessionId: "s", text: "hi" });
  });
});
