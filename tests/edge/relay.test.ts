import { describe, expect, it, vi } from "vitest";
import {
  MAX_FRAME_BYTES,
  PEER_PRESENT,
  otherRole,
  parseRole,
  peerOf,
  supersededBy,
  type RelayRole,
} from "../../services/edge/src/relay.js";

// ---- 假 DO ----
//
// relay.ts 是纯函数,状态归 Durable Object(一户一个实例,连接由运行时持有)。
// 下面这个 FakeRelay **照着 services/edge/src/worker.ts 的动作顺序写**,
// 好让"两端互转字节""顶掉旧连接""负载不进日志"这些性质仍然有端到端的测试,
// 而不必为了它们起一个 workerd —— 安全不变量的测试必须便宜到每次提交都跑。
//
// 它**不**覆盖的:DO 的运行时接缝本身(acceptWebSocket 的休眠语义、tag 存取、
// 101 响应的形状)。那一层薄到几乎没有分支,由 e2e 和真机联调兜。
// 改 worker.ts 的连接顺序时,这里要跟着改 —— 两边对不上就等于这些测试在测别的东西。

interface FakeConn {
  role: RelayRole;
  open: boolean;
  sent: string[];
  closed: { code: number; reason: string } | null;
}

function fakeRelay() {
  const conns: FakeConn[] = [];
  const send = (c: FakeConn, s: string): void => {
    if (c.open) c.sent.push(s);
  };
  return {
    conns,
    /** 照 worker.ts 的 fetch():先顶掉同角色的旧连接,再接上,再看对端在不在 */
    connect(role: RelayRole): FakeConn {
      for (const old of supersededBy(conns, role)) {
        old.open = false;
        old.closed = { code: 1000, reason: "superseded" };
      }
      const me: FakeConn = { role, open: true, sent: [], closed: null };
      conns.push(me);
      const peer = peerOf(conns, role);
      if (peer) {
        send(me, PEER_PRESENT);
        send(peer, PEER_PRESENT);
      }
      return me;
    },
    /** 照 worker.ts 的 webSocketMessage() */
    frame(from: FakeConn, payload: string): "delivered" | "dropped" | "too-large" {
      if (payload.length > MAX_FRAME_BYTES) {
        from.open = false;
        from.closed = { code: 1009, reason: "frame too large" };
        return "too-large";
      }
      const peer = peerOf(conns, from.role);
      if (!peer) return "dropped";
      send(peer, payload);
      return "delivered";
    },
  };
}

describe("配对的纯逻辑", () => {
  it("otherRole / parseRole", () => {
    expect(otherRole("desktop")).toBe("mobile");
    expect(otherRole("mobile")).toBe("desktop");
    expect(parseRole("desktop")).toBe("desktop");
    expect(parseRole("mobile")).toBe("mobile");
    for (const bad of [null, "", "DESKTOP", "both", "server"]) {
      expect(parseRole(bad)).toBeNull();
    }
  });

  it("peerOf 绕开正在关的连接（顶替的瞬间旧连接还在列表里）", () => {
    const dying = { role: "mobile" as const, open: false };
    const live = { role: "mobile" as const, open: true };
    expect(peerOf([dying, live], "desktop")).toBe(live);
  });

  it("peerOf 找不到 = 对端不在线（丢弃，不排队）", () => {
    expect(peerOf([{ role: "desktop", open: true }], "desktop")).toBeUndefined();
    expect(peerOf([], "mobile")).toBeUndefined();
  });

  it("supersededBy 只挑同角色的（一户一桌面一手机）", () => {
    const conns = [
      { role: "desktop" as const, open: true },
      { role: "mobile" as const, open: true },
    ];
    expect(supersededBy(conns, "mobile")).toEqual([conns[1]]);
    expect(supersededBy([], "desktop")).toEqual([]);
  });
});

describe("中继（照 worker.ts 的动作顺序）", () => {
  it("两端互转字节，不回声给发送方", () => {
    const r = fakeRelay();
    const d = r.connect("desktop");
    const m = r.connect("mobile");
    d.sent.length = 0;
    m.sent.length = 0;

    expect(r.frame(d, "AAAA")).toBe("delivered");
    expect(m.sent).toEqual(["AAAA"]);
    expect(d.sent).toEqual([]);

    expect(r.frame(m, "BBBB")).toBe("delivered");
    expect(d.sent).toEqual(["BBBB"]);
  });

  // ── 在场信号 ──
  // 握手是双向的:两端都要拿到对方的 hello 才能派生密钥。而中继按设计不排队,
  // 桌面又是长命的那一端 —— 它开机时若盲发 hello,必然掉进虚空。
  // 于是"对端到场"这件事必须由中继说出来:它是唯一同时看得见两个槽的人。
  it("对端到场时，两侧各收到一条 :peer", () => {
    const r = fakeRelay();
    const d = r.connect("desktop");
    expect(d.sent).toEqual([]); // 独自在线:没有对端,不发信号

    const m = r.connect("mobile");
    expect(d.sent).toEqual([PEER_PRESENT]); // 在位的那端被叫醒
    expect(m.sent).toEqual([PEER_PRESENT]); // 新来的那端也要知道对端已在
  });

  it("同角色重连也重发 :peer（手机切后台再回来，整轮握手要重开）", () => {
    const r = fakeRelay();
    const d = r.connect("desktop");
    r.connect("mobile");
    r.connect("mobile"); // 重连顶掉旧的
    expect(d.sent).toEqual([PEER_PRESENT, PEER_PRESENT]);
  });

  it("同角色重连顶掉旧连接，旧的收 1000 superseded", () => {
    const r = fakeRelay();
    const first = r.connect("mobile");
    const second = r.connect("mobile");
    expect(first.closed).toEqual({ code: 1000, reason: "superseded" });
    expect(second.open).toBe(true);
  });

  it("顶替之后，帧发给新连接而不是正在死的那条", () => {
    const r = fakeRelay();
    const d = r.connect("desktop");
    const first = r.connect("mobile");
    const second = r.connect("mobile");
    first.sent.length = 0;
    second.sent.length = 0;
    r.frame(d, "PAYLOAD");
    expect(first.sent).toEqual([]);
    expect(second.sent).toEqual(["PAYLOAD"]);
  });

  it("对端不在线 → 丢弃，不排队（排队 = 落盘）", () => {
    const r = fakeRelay();
    const d = r.connect("desktop");
    expect(r.frame(d, "AAAA")).toBe("dropped");
    // 后来才连上的手机**不该**收到那一帧
    const m = r.connect("mobile");
    expect(m.sent).toEqual([PEER_PRESENT]);
  });

  it("超过 256 KiB → 关连接，且不看内容", () => {
    const r = fakeRelay();
    const d = r.connect("desktop");
    r.connect("mobile");
    expect(r.frame(d, "x".repeat(MAX_FRAME_BYTES + 1))).toBe("too-large");
    expect(d.closed?.code).toBe(1009);
  });

  // ↓ 盲管道这个性质要有测试守着，否则三个月后有人为调试加一行 console.log
  it("负载从不被解析：坏 JSON 也照转不误", () => {
    const r = fakeRelay();
    const d = r.connect("desktop");
    const m = r.connect("mobile");
    m.sent.length = 0;
    expect(r.frame(d, "{{{ not json at all")).toBe("delivered");
    expect(m.sent).toEqual(["{{{ not json at all"]);
  });

  it("负载从不进日志", () => {
    const spyLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const spyErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = fakeRelay();
    const d = r.connect("desktop");
    r.connect("mobile");
    r.frame(d, "TOP-SECRET-PAYLOAD");
    const all = [...spyLog.mock.calls, ...spyErr.mock.calls, ...spyWarn.mock.calls].flat().join(" ");
    expect(all).not.toContain("TOP-SECRET-PAYLOAD");
    spyLog.mockRestore();
    spyErr.mockRestore();
    spyWarn.mockRestore();
  });
});
