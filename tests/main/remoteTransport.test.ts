import { describe, expect, it, vi } from "vitest";
import { createSseTransport } from "../../src/main/remoteTransport.js";

// 传输层的合同写在 src/main/remoteBridge.ts 的 RemoteTransport 注释里。
// 这个文件钉的是那份合同里桥**依赖但自己管不了**的几条:
//   - `:peer` 必须转成 onPeer(握手唯一的起点,ADR-0100)
//   - onClose 绝不能从 send 内部同步触发(会把桥的 startRound 变成同步死循环)
//   - 断线要自己重连,而且重连本身不发 hello —— 新连接自带一条 :peer

/** 一条能被测试逐块喂进去的假 SSE 响应 */
function fakeStream() {
  let push!: (s: string) => void;
  let finish!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      push = (s) => c.enqueue(enc.encode(s));
      finish = () => c.close();
    },
  });
  return { body, push: (s: string) => push(s), finish: () => finish() };
}

function harness(opts: { status?: number } = {}) {
  const streams: ReturnType<typeof fakeStream>[] = [];
  const posts: { url: string; body: string }[] = [];
  const opened: string[] = [];

  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push({ url, body: String(init.body) });
      return new Response(null, { status: 204 });
    }
    opened.push(url);
    const s = fakeStream();
    streams.push(s);
    return new Response(s.body, { status: opts.status ?? 200 });
  }) as unknown as typeof fetch;

  const t = createSseTransport({
    baseUrl: "https://gw.example/gw",
    role: "desktop",
    authToken: async () => "TOKEN",
    fetchImpl,
    log: () => {},
  });
  return { t, streams, posts, opened, fetchImpl };
}

/** 让已经排好的 microtask 跑完(fetch 是 async 的,流的读取也是) */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe("createSseTransport", () => {
  it("开流的 URL 带 role 和 v=2,鉴权走 Bearer", async () => {
    const { t, opened, fetchImpl } = harness();
    await settle();
    // v=2 声明"我认按 cid 寻址那一套"(ADR-0130)。不声明的话中继按老格式发,
    // 帧上就没有发件人 —— 桌面接着几台手机时不知道该用哪套密钥解
    expect(opened[0]).toBe("https://gw.example/gw/rl/v1/stream?role=desktop&v=2");
    const init = (fetchImpl as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0]![1];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer TOKEN");
    t.close();
  });

  it(":peer 转成 onPeer；:ok 与其它注释行不转", async () => {
    const { t, streams } = harness();
    const peer = vi.fn();
    t.onPeer(peer);
    await settle();
    streams[0]!.push(":ok\n\n");
    await settle();
    expect(peer).not.toHaveBeenCalled();
    streams[0]!.push(":\n\n");      // 心跳
    streams[0]!.push(":peer\n\n");
    await settle();
    expect(peer).toHaveBeenCalledTimes(1);
    t.close();
  });

  it("data 行转成 onMessage，一次收到多帧也逐条派发", async () => {
    const { t, streams } = harness();
    const got: string[] = [];
    t.onMessage((p) => got.push(p));
    await settle();
    streams[0]!.push("data: AAA\n\ndata: BBB\n\n");
    await settle();
    expect(got).toEqual(["AAA", "BBB"]);
    t.close();
  });

  it("半条帧不会被当成完整帧派发（TCP 想在哪断就在哪断）", async () => {
    const { t, streams } = harness();
    const got: string[] = [];
    t.onMessage((p) => got.push(p));
    await settle();
    streams[0]!.push("data: AB");
    await settle();
    expect(got).toEqual([]);
    streams[0]!.push("C\n\n");
    await settle();
    expect(got).toEqual(["ABC"]);
    t.close();
  });

  it("send 走 POST；对端不在线(409)不当错误，也绝不同步触发 onClose", async () => {
    const { t, posts } = harness();
    const closed = vi.fn();
    t.onClose(closed);
    await settle();
    t.send("PAYLOAD", "");
    expect(closed).not.toHaveBeenCalled(); // 同步这一刻就不能触发
    await settle();
    expect(posts[0]).toEqual({ url: "https://gw.example/gw/rl/v1/send?role=desktop", body: "PAYLOAD" });
    expect(closed).not.toHaveBeenCalled();
    t.close();
  });

  // 多连接(ADR-0130):to 决定这一帧塞进哪根管子。空串 = 老中继,不带这个参数 ——
  // 带上去老网关会当成未知 query 忽略,但把它写进 URL 会让"老路径"多一种形态,
  // 而这条路径正是升级期唯一还能用的那条
  it("send 带 to 时 URL 上有 to；空串时按老路径发", async () => {
    const { t, posts } = harness();
    await settle();
    t.send("A", "c7");
    t.send("B", "");
    await settle();
    // from = 自己这条连接的 cid;还没收到 :cid 时是空的(下一条用例覆盖真值)
    expect(posts[0]!.url).toBe("https://gw.example/gw/rl/v1/send?role=desktop&to=c7&from=");
    expect(posts[1]!.url).toBe("https://gw.example/gw/rl/v1/send?role=desktop");
    t.close();
  });

  it("流断了 → 触发 onClose，退避之后自己重连；重连不发任何东西", async () => {
    vi.useFakeTimers();
    try {
      const { t, streams, opened, posts } = harness();
      const closed = vi.fn();
      t.onClose(closed);
      await settle();
      expect(opened).toHaveLength(1);

      streams[0]!.finish();
      await settle();
      expect(closed).toHaveBeenCalledTimes(1);
      expect(opened).toHaveLength(1); // 还没到重连的点

      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      expect(opened).toHaveLength(2);
      expect(posts).toHaveLength(0); // 重连自己不发 hello —— 新连接自带一条 :peer
      t.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("连上就断(网络在抖)时退避照样递增；活满 30s 才算连上，退避归零", async () => {
    vi.useFakeTimers();
    try {
      const { t, streams, opened } = harness();
      await settle();
      streams[0]!.finish();
      await settle();
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
      expect(opened).toHaveLength(2);

      // 第二条也是连上就断 —— 只看"拿到 200"的话退避会永远停在第一档
      streams[1]!.finish();
      await settle();
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
      expect(opened, "连上就断不该让退避归零").toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
      expect(opened).toHaveLength(3);

      // 这一条活满 30s,是真连上了
      await vi.advanceTimersByTimeAsync(30_000);
      streams[2]!.finish();
      await settle();
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
      expect(opened, "活满 30s 之后退避该归零").toHaveLength(4);
      t.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("close 之后不再重连", async () => {
    vi.useFakeTimers();
    try {
      const { t, streams, opened } = harness();
      await settle();
      t.close();
      streams[0]!.finish();
      await settle();
      await vi.advanceTimersByTimeAsync(60_000);
      await settle();
      expect(opened).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("没登录（authToken 回 null）就不连", async () => {
    const opened: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      opened.push(String(input));
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const t = createSseTransport({
      baseUrl: "https://gw.example/gw", role: "desktop",
      authToken: async () => null, fetchImpl, log: () => {},
    });
    await settle();
    expect(opened).toHaveLength(0);
    t.close();
  });

  // 「不连」本身没问题，问题是它**不排重连** —— 没有 retryNow 的话，冷启动时
  // 未登录的用户登录之后要重开 app 才连得上（issue #484）
  it("登录之后 retryNow() 就连上了", async () => {
    const opened: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      opened.push(String(input));
      return new Response(fakeStream().body, { status: 200 });
    }) as unknown as typeof fetch;
    let token: string | null = null;
    const t = createSseTransport({
      baseUrl: "https://gw.example/gw", role: "desktop",
      authToken: async () => token, fetchImpl, log: () => {},
    });
    await settle();
    expect(opened).toHaveLength(0);

    token = "TOKEN"; // 用户登录了
    t.retryNow();
    await settle();
    expect(opened).toHaveLength(1);
    t.close();
  });

  it("连接活着时 retryNow() 是空操作 —— 不开第二条流", async () => {
    const { t, opened } = harness();
    await settle();
    expect(opened).toHaveLength(1);
    t.retryNow();
    await settle();
    expect(opened).toHaveLength(1);
    t.close();
  });

  it("正在退避等待时 retryNow() 把等待掐掉，当场重连", async () => {
    // 「用户刚登录」是新信息，没有理由再等剩下的退避时间
    vi.useFakeTimers();
    try {
      const { t, streams, opened } = harness();
      await settle();
      streams[0]!.finish(); // 断了 → 排一个 1s 后的重连
      await settle();
      expect(opened).toHaveLength(1);

      t.retryNow();
      await settle();
      expect(opened, "不该等满退避").toHaveLength(2);

      // 掐掉的那个定时器不该在后面又醒过来开第三条流
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
      expect(opened).toHaveLength(2);
      t.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("close 之后 retryNow() 叫不醒它", async () => {
    const { t, opened } = harness();
    await settle();
    t.close();
    t.retryNow();
    await settle();
    expect(opened).toHaveLength(1);
  });
});
