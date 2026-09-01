import { describe, expect, it, vi } from "vitest";
import {
  CTRL_CID,
  CTRL_GONE,
  CTRL_PEER,
  MAX_CONNS_PER_USER,
  MAX_FRAME_BYTES,
  decodeFrame,
  encodeFrame,
  newCid,
  otherRole,
  parseRole,
  peersOf,
  targetOf,
  type RelayRole,
} from "../../services/edge/src/relay.js";

// ---- 假 DO ----
//
// relay.ts 是纯函数,状态归 Durable Object(一户一个实例,连接由运行时持有,
// role 与 cid 存在 tag 里)。下面这个 FakeRelay **照着 services/edge/src/worker.ts
// 的动作顺序写**,好让"多连接互转""按 cid 寻址""负载不进日志"这些性质仍然有
// 端到端的测试,而不必为了它们起一个 workerd —— 安全不变量的测试必须便宜到
// 每次提交都跑。
//
// 它**不**覆盖的:DO 的运行时接缝本身(acceptWebSocket 的休眠语义、tag 存取、
// 101 响应的形状、子协议 echo)。那一层由 services/edge/checks/relay.mjs
// 打真 workerd 兜。改 worker.ts 的动作顺序时,这里要跟着改。

interface FakeConn {
  cid: string;
  role: RelayRole;
  /** 连接计数桶（issue #824）：edge.ts 按 (房间, 用户) 算出来的分桶键。
      同一个房间里两个人拿到两个不同的 ck，各自数各自的 */
  ck: string;
  open: boolean;
  sent: string[];
  closed: { code: number; reason: string } | null;
}

function fakeRelay() {
  const conns: FakeConn[] = [];
  const send = (c: FakeConn, s: string): void => {
    if (c.open) c.sent.push(s);
  };
  const self = {
    conns,
    /** 照 worker.ts 的 fetch() */
    connect(role: RelayRole, ck = "user-a"): FakeConn | "full" {
      // 按桶数，不按房间总数（issue #824）——照 worker.ts 的 fetch()
      if (conns.filter((c) => c.open && c.ck === ck).length >= MAX_CONNS_PER_USER) return "full";
      const existing = conns.slice();
      const me: FakeConn = { cid: newCid(), role, ck, open: true, sent: [], closed: null };
      conns.push(me);
      send(me, `${CTRL_CID} ${me.cid}`);
      for (const p of peersOf(existing, role)) {
        send(me, `${CTRL_PEER} ${p.cid}`);
        send(p, `${CTRL_PEER} ${me.cid}`);
      }
      return me;
    },
    /** 照 worker.ts 的 webSocketMessage() */
    frame(from: FakeConn, to: string, payload: string): "delivered" | "dropped" | "too-large" {
      const msg = encodeFrame(to, payload);
      if (msg.length > MAX_FRAME_BYTES) {
        from.open = false;
        from.closed = { code: 1009, reason: "frame too large" };
        return "too-large";
      }
      const target = targetOf(conns, from.role, to);
      if (!target) return "dropped";
      send(target, encodeFrame(from.cid, payload));
      return "delivered";
    },
    /** 照 worker.ts 的 webSocketClose() */
    drop(c: FakeConn): void {
      c.open = false;
      for (const p of peersOf(conns, c.role)) {
        if (p.cid !== c.cid) send(p, `${CTRL_GONE} ${c.cid}`);
      }
    },
  };
  return self;
}

const conn = (r: fakeRelayConn): FakeConn => r as FakeConn;
type fakeRelayConn = FakeConn | "full";

describe("配对的纯逻辑", () => {
  it("otherRole / parseRole", () => {
    expect(otherRole("desktop")).toBe("mobile");
    expect(otherRole("mobile")).toBe("desktop");
    // host↔guest:好友代理那一对(ADR-0151)
    expect(otherRole("host")).toBe("guest");
    expect(otherRole("guest")).toBe("host");
    expect(parseRole("desktop")).toBe("desktop");
    expect(parseRole("host")).toBe("host");
    expect(parseRole("guest")).toBe("guest");
    for (const bad of [null, "", "DESKTOP", "both", "server"]) {
      expect(parseRole(bad)).toBeNull();
    }
  });

  it("peersOf 只挑对端角色、且还活着的", () => {
    const conns = [
      { cid: "a", role: "desktop" as const, open: true },
      { cid: "b", role: "mobile" as const, open: true },
      { cid: "c", role: "mobile" as const, open: false },
      { cid: "d", role: "mobile" as const, open: true },
    ];
    expect(peersOf(conns, "desktop").map((c) => c.cid)).toEqual(["b", "d"]);
    expect(peersOf(conns, "mobile").map((c) => c.cid)).toEqual(["a"]);
  });

  // 同角色之间不该能互相发东西:桌面发给另一台桌面在这套协议里没有意义,
  // 而它会让"我在跟谁说话"多一种可能性
  it("targetOf 不认同角色的 cid", () => {
    const conns = [
      { cid: "d1", role: "desktop" as const, open: true },
      { cid: "d2", role: "desktop" as const, open: true },
      { cid: "m1", role: "mobile" as const, open: true },
    ];
    expect(targetOf(conns, "desktop", "m1")?.cid).toBe("m1");
    expect(targetOf(conns, "desktop", "d2")).toBeUndefined();
  });

  // cid 撞号 = 两条连接抢同一根管子。DO 睡醒后构造函数重跑、内存清零,
  // 所以它不能是实例字段上的计数器(ADR-0129 的实现补充)
  it("newCid 随机、以字母开头、不含空格", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newCid()));
    expect(ids.size).toBe(500);
    for (const id of ids) {
      expect(id).toMatch(/^c[0-9a-f]+$/);
      expect(id).not.toContain(" ");
    }
  });

  it("encodeFrame / decodeFrame 是一对，密文原样出来", () => {
    const payload = "AAAA-BB_CC-dd";
    const f = decodeFrame(encodeFrame("c123", payload));
    expect(f).toEqual({ cid: "c123", payload });
  });

  it("decodeFrame 解不开的回 null，不抛", () => {
    for (const bad of ["", "nospace", " leading", ":peer c1"]) {
      expect(() => decodeFrame(bad)).not.toThrow();
    }
    expect(decodeFrame("nospace")).toBeNull();
    expect(decodeFrame(" leading")).toBeNull();
  });
});

describe("中继（照 worker.ts 的动作顺序）", () => {
  it("接上先收到自己的 cid", () => {
    const r = fakeRelay();
    const d = conn(r.connect("desktop"));
    expect(d.sent).toEqual([`${CTRL_CID} ${d.cid}`]);
  });

  it("对端到场：两侧各收到一条带 cid 的 :peer", () => {
    const r = fakeRelay();
    const d = conn(r.connect("desktop"));
    d.sent.length = 0;
    const m = conn(r.connect("mobile"));
    expect(d.sent).toEqual([`${CTRL_PEER} ${m.cid}`]);
    expect(m.sent).toEqual([`${CTRL_CID} ${m.cid}`, `${CTRL_PEER} ${d.cid}`]);
  });

  // ADR-0130 的核心:几台手机可以同时连着,各是各的
  it("两台手机同时在线：桌面收到两条 :peer，各发各的不串", () => {
    const r = fakeRelay();
    const d = conn(r.connect("desktop"));
    const m1 = conn(r.connect("mobile"));
    const m2 = conn(r.connect("mobile"));
    expect(d.sent.filter((s) => s.startsWith(CTRL_PEER))).toEqual([
      `${CTRL_PEER} ${m1.cid}`,
      `${CTRL_PEER} ${m2.cid}`,
    ]);

    m1.sent.length = 0;
    m2.sent.length = 0;
    expect(r.frame(d, m2.cid, "ONLY-FOR-M2")).toBe("delivered");
    expect(m2.sent).toEqual([encodeFrame(d.cid, "ONLY-FOR-M2")]);
    expect(m1.sent).toEqual([]); // ← 广播就会在这里红
  });

  it("新连的手机也知道桌面在（两侧都通知，不是只通知新来的）", () => {
    const r = fakeRelay();
    const d = conn(r.connect("desktop"));
    const m1 = conn(r.connect("mobile"));
    m1.sent.length = 0;
    const m2 = conn(r.connect("mobile"));
    expect(m2.sent).toContain(`${CTRL_PEER} ${d.cid}`);
    expect(m1.sent).toEqual([]); // 同角色之间不互相通知
  });

  it("收件人知道是谁发的（不知道就不知道用哪套密钥解）", () => {
    const r = fakeRelay();
    const d = conn(r.connect("desktop"));
    const m = conn(r.connect("mobile"));
    m.sent.length = 0;
    r.frame(d, m.cid, "PAYLOAD");
    expect(decodeFrame(m.sent[0]!)).toEqual({ cid: d.cid, payload: "PAYLOAD" });
  });

  // 猜一条发过去,收到的那端解不开,而发的那端以为发成功了 —— 最难查的那种
  it("收件人认不出 → 丢弃，不猜一条发", () => {
    const r = fakeRelay();
    const d = conn(r.connect("desktop"));
    const m = conn(r.connect("mobile"));
    m.sent.length = 0;
    expect(r.frame(d, "c-nobody", "PAYLOAD")).toBe("dropped");
    expect(m.sent).toEqual([]);
  });

  it("对端一条都没有 → 丢弃，不排队（排队 = 落盘）", () => {
    const r = fakeRelay();
    const d = conn(r.connect("desktop"));
    expect(r.frame(d, "c-anything", "AAAA")).toBe("dropped");
    const m = conn(r.connect("mobile"));
    expect(m.sent.some((s) => s.includes("AAAA"))).toBe(false);
  });

  it("连接没了 → 对端收到 :gone，同侧的不收", () => {
    const r = fakeRelay();
    const d = conn(r.connect("desktop"));
    const m1 = conn(r.connect("mobile"));
    const m2 = conn(r.connect("mobile"));
    d.sent.length = 0;
    m2.sent.length = 0;
    r.drop(m1);
    expect(d.sent).toEqual([`${CTRL_GONE} ${m1.cid}`]);
    expect(m2.sent).toEqual([]);
  });

  it("走掉那条不再收帧", () => {
    const r = fakeRelay();
    const d = conn(r.connect("desktop"));
    const m = conn(r.connect("mobile"));
    r.drop(m);
    m.sent.length = 0;
    expect(r.frame(d, m.cid, "PAYLOAD")).toBe("dropped");
    expect(m.sent).toEqual([]);
  });

  it("超过 256 KiB → 关连接，且不看内容", () => {
    const r = fakeRelay();
    const d = conn(r.connect("desktop"));
    const m = conn(r.connect("mobile"));
    expect(r.frame(d, m.cid, "x".repeat(MAX_FRAME_BYTES))).toBe("too-large");
    expect(d.closed?.code).toBe(1009);
  });

  it("一户最多 16 条，满了就不再接", () => {
    const r = fakeRelay();
    for (let i = 0; i < MAX_CONNS_PER_USER; i += 1) {
      expect(r.connect(i % 2 === 0 ? "desktop" : "mobile")).not.toBe("full");
    }
    expect(r.connect("mobile")).toBe("full");
  });

  // issue #824：这个上限的名字一直是 PER_USER，数的却是房间里的连接总数。
  // 自远程的房间键就是 userId，两者碰巧相等，所以一直没露馅；cs-ctl 是
  // 全平台一个固定房，于是"一个人握住 16 条 socket"= 所有人都建不了云会话
  it("一个人占满自己那 16 条，别人照样连得上（共用房间不再是共命运）", () => {
    const r = fakeRelay();
    for (let i = 0; i < MAX_CONNS_PER_USER; i += 1) {
      expect(r.connect("guest", "user-a")).not.toBe("full");
    }
    expect(r.connect("guest", "user-a")).toBe("full");
    expect(r.connect("guest", "user-b")).not.toBe("full");
    expect(r.connect("host", "svc-runtime")).not.toBe("full");
  });

  // ↓ 盲管道这个性质要有测试守着，否则三个月后有人为调试加一行 console.log
  it("负载从不被解析：坏 JSON 也照转不误", () => {
    const r = fakeRelay();
    const d = conn(r.connect("desktop"));
    const m = conn(r.connect("mobile"));
    m.sent.length = 0;
    expect(r.frame(d, m.cid, "{{{ not json at all")).toBe("delivered");
    expect(decodeFrame(m.sent[0]!)?.payload).toBe("{{{ not json at all");
  });

  it("负载从不进日志", () => {
    const spyLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const spyErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = fakeRelay();
    const d = conn(r.connect("desktop"));
    const m = conn(r.connect("mobile"));
    r.frame(d, m.cid, "TOP-SECRET-PAYLOAD");
    const all = [...spyLog.mock.calls, ...spyErr.mock.calls, ...spyWarn.mock.calls].flat().join(" ");
    expect(all).not.toContain("TOP-SECRET-PAYLOAD");
    spyLog.mockRestore();
    spyErr.mockRestore();
    spyWarn.mockRestore();
  });
});


// ─── host/guest 转发（好友代理，ADR-0151，issue #622 PR-A）──────────────────
describe("relay · host/guest（好友代理转发）", () => {
  const peer = (cid: string, role: "host" | "guest", open = true) => ({ cid, role, open });

  it("host 能发给 guest、guest 能发给 host（同对异角色互发）", () => {
    const a = peer("cA", "host");
    const b = peer("cB", "guest");
    const conns = [a, b];
    // host → guest
    expect(targetOf(conns, "host", "cB")?.cid).toBe("cB");
    // guest → host
    expect(targetOf(conns, "guest", "cA")?.cid).toBe("cA");
  });

  it("host 不能发给另一个 host（同角色禁发）", () => {
    const a1 = peer("cA1", "host");
    const a2 = peer("cA2", "host");
    const conns = [a1, a2];
    expect(peersOf(conns, "host")).toHaveLength(0);
    expect(targetOf(conns, "host", "cA2")).toBeUndefined();
  });

  it("host 的对端不包括 desktop/mobile（跨对不可见）", () => {
    const a = peer("cA", "host");
    const b = peer("cB", "guest");
    const conns: { cid: string; role: import("../../services/edge/src/relay.js").RelayRole; open: boolean }[] = [
      a, b,
      { cid: "cD", role: "desktop", open: true },
      { cid: "cM", role: "mobile", open: true },
    ];
    // host 只看得见 guest
    expect(peersOf(conns, "host").map((c) => c.cid)).toEqual(["cB"]);
    // desktop 只看得见 mobile（不受 host/guest 影响）
    expect(peersOf(conns, "desktop").map((c) => c.cid)).toEqual(["cM"]);
  });
});
