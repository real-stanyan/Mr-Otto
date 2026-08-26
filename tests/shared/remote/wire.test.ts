import { describe, expect, it } from "vitest";
import { b64encode } from "../../../src/shared/remote/b64.js";
import {
  CONTROL_PREFIX,
  CTRL_CID,
  CTRL_GONE,
  CTRL_PEER,
  CTRL_PING,
  CTRL_PONG,
  MAX_FRAME_BYTES,
  SUBPROTOCOL,
  decodeFrame,
  encodeFrame,
  isControl,
  newCid,
  parseControl,
} from "../../../src/shared/remote/wire.js";

describe("控制信道与载荷分得开", () => {
  // ↓ 这是整个控制信道设计的**唯一前提**:如果密文可能以冒号开头,
  //   一条载荷就会被当成控制消息静默吞掉 —— 表现是"偶尔丢一帧",
  //   而丢的那一帧多半是几十 KB 的时间线帧,肉眼看是"手机上少了一段"
  it("base64url 编出来的东西永远不以控制前缀开头", () => {
    // 0..255 单字节、以及一批多字节样本,覆盖首字节的全部取值
    for (let b = 0; b < 256; b += 1) {
      expect(b64encode(new Uint8Array([b]))).not.toContain(CONTROL_PREFIX);
      expect(b64encode(new Uint8Array([b, 0, 255, 7]))).not.toContain(CONTROL_PREFIX);
    }
  });

  it("每一条控制消息都带前缀（否则会被当成载荷喂给桥）", () => {
    for (const m of [CTRL_CID, CTRL_PEER, CTRL_GONE, CTRL_PING, CTRL_PONG]) {
      expect(isControl(m), m).toBe(true);
    }
  });

  it("控制消息两两不同（同值 = 心跳被当成在场信号，握手会空转）", () => {
    expect(new Set([CTRL_CID, CTRL_PEER, CTRL_GONE, CTRL_PING, CTRL_PONG]).size).toBe(5);
  });

  // 载荷帧长成 `<cid> <base64url>`，而 cid 必然以字母开头
  it("载荷帧不被当成控制消息", () => {
    for (const p of ["AAAA", b64encode(new Uint8Array([1, 2, 3])), ""]) {
      expect(isControl(encodeFrame(newCid(), p))).toBe(false);
    }
  });
});

describe("常量本身", () => {
  // 子协议名进的是 Sec-WebSocket-Protocol,必须是 RFC 7230 的 token
  // (不能有空格/逗号,否则会被当成两个子协议)
  it("子协议名是合法 token", () => {
    expect(SUBPROTOCOL).toMatch(/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/);
  });

  it("单帧上限是 256 KiB", () => {
    expect(MAX_FRAME_BYTES).toBe(256 * 1024);
  });
});

describe("cid 寻址（ADR-0130）", () => {
  it("控制消息解出种类和 cid", () => {
    expect(parseControl(`${CTRL_CID} c1`)).toEqual({ kind: "cid", cid: "c1" });
    expect(parseControl(`${CTRL_PEER} c2`)).toEqual({ kind: "peer", cid: "c2" });
    expect(parseControl(`${CTRL_GONE} c3`)).toEqual({ kind: "gone", cid: "c3" });
    expect(parseControl(CTRL_PONG)).toEqual({ kind: "pong", cid: "" });
  });

  // 线上的字节永远可能是垃圾，认不出一条控制消息不该让整条连接陪葬
  it("认不出的控制消息回 null，不抛", () => {
    for (const bad of [":", ":peer", ":nope c1", "c1 payload", ""]) {
      expect(() => parseControl(bad)).not.toThrow();
      expect(parseControl(bad), bad).toBeNull();
    }
  });

  it("帧编解码是一对，密文原样出来", () => {
    const payload = b64encode(new Uint8Array([0, 1, 255, 7]));
    expect(decodeFrame(encodeFrame("c9", payload))).toEqual({ cid: "c9", payload });
  });

  // cid 撞号 = 两条连接抢同一根管子。DO 睡醒后内存清零，所以不能是计数器
  it("newCid 随机、以字母开头、不含空格", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newCid()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^c[0-9a-f]+$/);
  });
});
