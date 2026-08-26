import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWsTransport } from "../../../src/shared/remote/wsTransport.js";
import { PEER_PRESENT, PING, PONG, SUBPROTOCOL } from "../../../src/shared/remote/wire.js";

// 假 WebSocket。只实现传输层真正用到的那几个面:构造参数、readyState、
// 四个事件回调、send/close。测试驱动它"发生什么",而不是等真网络。
class FakeWs {
  static instances: FakeWs[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string, readonly protocols?: string[]) {
    FakeWs.instances.push(this);
  }
  send(s: string): void {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(s);
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.onclose?.({ code, reason });
  }
  // ---- 测试用的驱动 ----
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  rx(data: unknown): void {
    this.onmessage?.({ data });
  }
  die(code = 1006, reason = "abnormal"): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const BASE = "https://edge.example/gw";

function make(over: Partial<Parameters<typeof createWsTransport>[0]> = {}) {
  const logs: string[] = [];
  const t = createWsTransport({
    baseUrl: BASE,
    role: "desktop",
    authToken: async () => "jwt-abc",
    wsImpl: FakeWs as unknown as typeof WebSocket,
    log: (m) => logs.push(m),
    ...over,
  });
  return { t, logs };
}

/** 连接是在构造时异步起的(await authToken),让微任务跑完 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const last = (): FakeWs => FakeWs.instances[FakeWs.instances.length - 1]!;

beforeEach(() => {
  FakeWs.instances = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("建连接", () => {
  it("token 走子协议的第二个值，URL 里一个字都没有", async () => {
    const { t } = make();
    await settle();
    const ws = last();
    expect(ws.protocols).toEqual([SUBPROTOCOL, "jwt-abc"]);
    expect(ws.url).toBe(`${BASE}/rl/v1/connect?role=desktop`);
    expect(ws.url).not.toContain("jwt-abc");
    t.close();
  });

  it("role 跟着走", async () => {
    const { t } = make({ role: "mobile" });
    await settle();
    expect(last().url).toContain("role=mobile");
    t.close();
  });

  it("baseUrl 的尾斜杠不会拼出双斜杠", async () => {
    const { t } = make({ baseUrl: `${BASE}/` });
    await settle();
    expect(last().url).toBe(`${BASE}/rl/v1/connect?role=desktop`);
    t.close();
  });

  // 没登录不连,**也不排重连** —— 退避重连一个必然失败的东西没有意义
  it("没登录 → 不建连接，也不排重连", async () => {
    const { t, logs } = make({ authToken: async () => null });
    await settle();
    expect(FakeWs.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWs.instances).toHaveLength(0);
    expect(logs.join(" ")).toContain("还没登录");
    t.close();
  });
});

describe("收", () => {
  it("`:peer` → onPeer，不当载荷", async () => {
    const { t } = make();
    await settle();
    const peers: number[] = [];
    const msgs: string[] = [];
    t.onPeer(() => peers.push(1));
    t.onMessage((p) => msgs.push(p));
    last().open();
    last().rx(PEER_PRESENT);
    expect(peers).toHaveLength(1);
    expect(msgs).toEqual([]);
    t.close();
  });

  it("载荷 → onMessage，原样交出去（不解析）", async () => {
    const { t } = make();
    await settle();
    const msgs: string[] = [];
    t.onMessage((p) => msgs.push(p));
    last().open();
    last().rx("{{{ not json");
    expect(msgs).toEqual(["{{{ not json"]);
    t.close();
  });

  it("`:pong` 收下即可，既不是载荷也不吵", async () => {
    const { t, logs } = make();
    await settle();
    const msgs: string[] = [];
    t.onMessage((p) => msgs.push(p));
    last().open();
    last().rx(PONG);
    expect(msgs).toEqual([]);
    expect(logs.join(" ")).not.toContain("不认识");
    t.close();
  });

  it("二进制帧忽略（载荷约定是 base64url 文本）", async () => {
    const { t } = make();
    await settle();
    const msgs: string[] = [];
    t.onMessage((p) => msgs.push(p));
    last().open();
    last().rx(new ArrayBuffer(8));
    expect(msgs).toEqual([]);
    t.close();
  });

  // 桥里抛异常不该被报成断线。真机上踩过:Electron 的 BoringSSL 没有
  // chacha20-poly1305 这个 EVP 名字,握手一开就抛,日志却显示成一串退避重连
  it("回调抛异常 = 不是断线：不 onClose、不重连、连接照旧", async () => {
    const { t, logs } = make();
    await settle();
    const closes: number[] = [];
    t.onClose(() => closes.push(1));
    t.onMessage(() => {
      throw new Error("Unknown cipher");
    });
    last().open();
    last().rx("PAYLOAD");
    expect(closes).toEqual([]);
    expect(FakeWs.instances).toHaveLength(1);
    expect(logs.join(" ")).toContain("不是断线");
    t.close();
  });
});

describe("发", () => {
  it("连着就直接发，不排队", async () => {
    const { t } = make();
    await settle();
    last().open();
    t.send("AAAA");
    t.send("BBBB");
    expect(last().sent).toEqual(["AAAA", "BBBB"]);
    t.close();
  });

  // send → onClose → startRound → send 会当场变成同步死循环(见 RemoteTransport 合同)
  it("连接没开 → 丢掉，且**不**触发 onClose", async () => {
    const { t, logs } = make();
    await settle();
    const closes: number[] = [];
    t.onClose(() => closes.push(1));
    t.send("AAAA"); // 还在 CONNECTING
    expect(last().sent).toEqual([]);
    expect(closes).toEqual([]);
    expect(logs.join(" ")).toContain("这一帧丢了");
    t.close();
  });
});

describe("断线与重连", () => {
  it("断了 → onClose + 按退避阶梯重连", async () => {
    const { t } = make();
    await settle();
    const closes: number[] = [];
    t.onClose(() => closes.push(1));
    last().open();
    last().die();
    expect(closes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWs.instances).toHaveLength(1); // 第一档是 1s，还没到
    await vi.advanceTimersByTimeAsync(2);
    expect(FakeWs.instances).toHaveLength(2);
    t.close();
  });

  // 只看"连上了"是不够的:一条连上就断的连接会让退避永远停在第一档,
  // 变成 1 秒一次的热循环
  it("连上就断 → 退避逐档拉长，不归零", async () => {
    const { t } = make();
    await settle();
    for (const wait of [1_000, 2_000, 5_000]) {
      last().open();
      last().die();
      await vi.advanceTimersByTimeAsync(wait - 1);
      const before = FakeWs.instances.length;
      await vi.advanceTimersByTimeAsync(2);
      expect(FakeWs.instances.length, `${wait}ms 那一档`).toBe(before + 1);
    }
    t.close();
  });

  it("reconnectNow 掐掉退避等待，立刻换一条", async () => {
    const { t } = make();
    await settle();
    last().open();
    last().die();
    expect(FakeWs.instances).toHaveLength(1);
    t.reconnectNow("刚登录");
    await settle();
    expect(FakeWs.instances).toHaveLength(2);
    t.close();
  });

  it("reconnectNow 会关掉旧连接并通知桥这一轮作废", async () => {
    const { t } = make();
    await settle();
    last().open();
    const old = last();
    const closes: number[] = [];
    t.onClose(() => closes.push(1));
    t.reconnectNow("回到前台");
    await settle();
    expect(old.closedWith?.code).toBe(1000);
    expect(closes).toHaveLength(1);
    expect(FakeWs.instances).toHaveLength(2);
    t.close();
  });

  it("close() 之后不再重连", async () => {
    const { t } = make();
    await settle();
    last().open();
    t.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWs.instances).toHaveLength(1);
  });

  it("旧连接的 onclose 迟到，不会把新连接的状态清掉", async () => {
    const { t } = make();
    await settle();
    const first = last();
    first.open();
    t.reconnectNow("换一条");
    await settle();
    const second = last();
    second.open();
    const closes: number[] = [];
    t.onClose(() => closes.push(1));
    first.die(); // 迟到的收尾
    expect(closes).toEqual([]);
    expect(FakeWs.instances).toHaveLength(2);
    t.close();
  });
});

describe("心跳", () => {
  it("连上后周期性发 :ping（边缘直接回，不唤醒 DO）", async () => {
    const { t } = make();
    await settle();
    last().open();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(last().sent).toEqual([PING]);
    t.close();
  });

  // "手机看着连着、其实什么都收不到" —— iOS 切后台掐 socket 而 WebSocket
  // 未必立刻 onclose。这是这条心跳存在的全部理由
  it("久不回话 → 主动掐掉换一条（半开连接）", async () => {
    const { t } = make();
    await settle();
    last().open();
    const first = last();
    await vi.advanceTimersByTimeAsync(60_000); // 发了几次 ping，一次回声都没有
    expect(first.closedWith?.code).toBe(4000);
    t.close();
  });

  it("有回声就不掐", async () => {
    const { t } = make();
    await settle();
    const ws = last();
    ws.open();
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      ws.rx(PONG);
    }
    expect(ws.closedWith).toBeNull();
    t.close();
  });

  it("停了就不再发（close 之后没有游离的定时器）", async () => {
    const { t } = make();
    await settle();
    const ws = last();
    ws.open();
    t.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ws.sent).toEqual([]);
  });
});
