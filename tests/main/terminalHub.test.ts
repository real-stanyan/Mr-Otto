import { describe, it, expect, vi } from "vitest";
import { createTerminalHub } from "../../src/main/terminalHub.js";
import type { TerminalSession } from "../../src/world/executionWorld.js";

/** 假 pty:能被写入、能被外部驱动着吐输出、能被杀 */
function fakePty() {
  let onData: ((d: string) => void) | null = null;
  let onExit: ((c: number) => void) | null = null;
  const written: string[] = [];
  const resized: Array<[number, number]> = [];
  let killed = false;
  const session: TerminalSession = {
    write: (d) => { written.push(d); },
    resize: (c, r) => { resized.push([c, r]); },
    kill: () => { killed = true; onExit?.(0); },
    onData: (cb) => { onData = cb; return () => { onData = null; }; },
    onExit: (cb) => { onExit = cb; return () => { onExit = null; }; },
  };
  return {
    session,
    emit: (d: string) => onData?.(d),
    die: (code: number) => onExit?.(code),
    get written() { return written; },
    get resized() { return resized; },
    get killed() { return killed; },
  };
}

function makeHub(opts: { bufferChars?: number; maxPerSession?: number } = {}) {
  const ptys: ReturnType<typeof fakePty>[] = [];
  const data = vi.fn();
  const exit = vi.fn();
  const hub = createTerminalHub({
    openTerminal: async () => {
      const p = fakePty();
      ptys.push(p);
      return p.session;
    },
    push: { data, exit },
    ...opts,
  });
  return { hub, ptys, data, exit };
}

describe("terminalHub 注册表", () => {
  it("开出来的终端能在本会话列到", async () => {
    const { hub } = makeHub();
    const { id } = await hub.open("s1", "/tmp/w", 80, 24);
    expect(hub.list("s1").map((t) => t.id)).toEqual([id]);
  });

  it("会话隔离:A 会话列不到 B 会话的终端", async () => {
    const { hub } = makeHub();
    await hub.open("s1", "/tmp/w", 80, 24);
    await hub.open("s2", "/tmp/w", 80, 24);
    expect(hub.list("s1")).toHaveLength(1);
    expect(hub.list("s2")).toHaveLength(1);
  });

  it("标题带序号,人能分清哪个是哪个", async () => {
    const { hub } = makeHub();
    await hub.open("s1", "/tmp/w", 80, 24);
    await hub.open("s1", "/tmp/w", 80, 24);
    expect(hub.list("s1").map((t) => t.title)).toEqual(["终端 1", "终端 2"]);
  });

  it("每会话上限 8,第 9 个报人话错误", async () => {
    const { hub } = makeHub({ maxPerSession: 2 });
    await hub.open("s1", "/tmp/w", 80, 24);
    await hub.open("s1", "/tmp/w", 80, 24);
    await expect(hub.open("s1", "/tmp/w", 80, 24)).rejects.toThrow(/最多/);
  });

  it("close 后重开:新题号不会和还活着的旧题号撞", async () => {
    const { hub } = makeHub();
    const { id: a } = await hub.open("s1", "/tmp/w", 80, 24); // 终端 1
    const { id: b } = await hub.open("s1", "/tmp/w", 80, 24); // 终端 2
    hub.close(a);
    const { id: c } = await hub.open("s1", "/tmp/w", 80, 24); // 该是 终端 3,不是 终端 2
    expect(hub.list("s1").map((t) => t.id).sort()).toEqual([b, c].sort());
    expect(hub.list("s1").map((t) => t.title)).toEqual(["终端 2", "终端 3"]);
  });

  it("并发 open 挤同一个会话:上限只放行一个,另一个被拒", async () => {
    const { hub } = makeHub({ maxPerSession: 1 });
    const results = await Promise.allSettled([
      hub.open("s1", "/tmp/w", 80, 24),
      hub.open("s1", "/tmp/w", 80, 24),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(hub.list("s1")).toHaveLength(1);
  });

  it("openTerminal 失败不占位:失败后名额还能用", async () => {
    let calls = 0;
    const ptys: ReturnType<typeof fakePty>[] = [];
    const hub = createTerminalHub({
      openTerminal: async () => {
        calls += 1;
        if (calls === 1) throw new Error("模拟 pty 启动失败");
        const p = fakePty();
        ptys.push(p);
        return p.session;
      },
      push: { data: vi.fn(), exit: vi.fn() },
      maxPerSession: 1,
    });
    await expect(hub.open("s1", "/tmp/w", 80, 24)).rejects.toThrow(/模拟 pty 启动失败/);
    const { id } = await hub.open("s1", "/tmp/w", 80, 24);
    expect(hub.list("s1").map((t) => t.id)).toEqual([id]);
  });
});

describe("terminalHub 直播与缓冲", () => {
  it("pty 的输出推给渲染层,同时进缓冲", async () => {
    const { hub, ptys, data } = makeHub();
    const { id } = await hub.open("s1", "/tmp/w", 80, 24);
    ptys[0]!.emit("hello");
    expect(data).toHaveBeenCalledWith(id, "hello");
    expect(hub.attach(id).snapshot).toBe("hello");
  });

  it("缓冲只留尾部:超上限后开头被丢掉", async () => {
    const { hub, ptys } = makeHub({ bufferChars: 10 });
    const { id } = await hub.open("s1", "/tmp/w", 80, 24);
    ptys[0]!.emit("aaaaaaaaaa"); // 10
    ptys[0]!.emit("bbbbb");      // 再 5,总 15 > 10
    const snap = hub.attach(id).snapshot;
    expect(snap.length).toBeLessThanOrEqual(10);
    expect(snap.endsWith("bbbbb")).toBe(true);
  });

  it("bufferChars 量的是 UTF-16 码元,不是字节:多字节字符按码元数计入", async () => {
    const { hub, ptys } = makeHub({ bufferChars: 3 });
    const { id } = await hub.open("s1", "/tmp/w", 80, 24);
    // "中" 在 UTF-16 下是 1 个码元,在 UTF-8 下是 3 字节——3 个字一共 3 码元 / 9 字节。
    // 如果这里量的是字节,9 > 3 的上限该被截断;量的是码元,3 == 3 不截断
    ptys[0]!.emit("中中中");
    expect(hub.attach(id).snapshot).toBe("中中中");
  });

  it("attach 拿的是快照,不重放给别人;新开的终端快照是空的", async () => {
    const { hub } = makeHub();
    const { id, snapshot } = await hub.open("s1", "/tmp/w", 80, 24);
    expect(snapshot).toBe("");
    expect(hub.attach(id).snapshot).toBe("");
  });

  it("认不出的 id:attach 抛错,input/resize/close 静默无视", async () => {
    const { hub } = makeHub();
    expect(() => hub.attach("nope")).toThrow(/终端不存在/);
    expect(() => hub.input("nope", "x")).not.toThrow();
    expect(() => hub.resize("nope", 1, 1)).not.toThrow();
    expect(() => hub.close("nope")).not.toThrow();
  });
});

describe("terminalHub 转发输入", () => {
  it("input / resize 转给对应的 pty", async () => {
    const { hub, ptys } = makeHub();
    const { id } = await hub.open("s1", "/tmp/w", 80, 24);
    hub.input(id, "ls\n");
    hub.resize(id, 120, 40);
    expect(ptys[0]!.written).toEqual(["ls\n"]);
    expect(ptys[0]!.resized).toEqual([[120, 40]]);
  });
});

describe("terminalHub 生命周期", () => {
  it("进程自己死掉:推 exit、标记 exited,缓冲还留着给人看遗言", async () => {
    const { hub, ptys, exit } = makeHub();
    const { id } = await hub.open("s1", "/tmp/w", 80, 24);
    ptys[0]!.emit("boom");
    ptys[0]!.die(1);
    expect(exit).toHaveBeenCalledWith(id, 1);
    expect(hub.list("s1")[0]!.exited).toBe(true);
    expect(hub.attach(id).snapshot).toBe("boom");
  });

  it("close 杀进程并摘出注册表", async () => {
    const { hub, ptys } = makeHub();
    const { id } = await hub.open("s1", "/tmp/w", 80, 24);
    hub.close(id);
    expect(ptys[0]!.killed).toBe(true);
    expect(hub.list("s1")).toHaveLength(0);
  });

  it("killSession 只杀该会话名下的", async () => {
    const { hub, ptys } = makeHub();
    await hub.open("s1", "/tmp/w", 80, 24);
    await hub.open("s2", "/tmp/w", 80, 24);
    hub.killSession("s1");
    expect(ptys[0]!.killed).toBe(true);
    expect(ptys[1]!.killed).toBe(false);
    expect(hub.list("s1")).toHaveLength(0);
    expect(hub.list("s2")).toHaveLength(1);
  });

  it("killAll 全杀(app 退出不留孤儿 dev server)", async () => {
    const { hub, ptys } = makeHub();
    await hub.open("s1", "/tmp/w", 80, 24);
    await hub.open("s2", "/tmp/w", 80, 24);
    hub.killAll();
    expect(ptys.every((p) => p.killed)).toBe(true);
    expect(hub.list("s1")).toHaveLength(0);
    expect(hub.list("s2")).toHaveLength(0);
  });
});
