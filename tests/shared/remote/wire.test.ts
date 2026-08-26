import { describe, expect, it } from "vitest";
import { b64encode } from "../../../src/shared/remote/b64.js";
import {
  CONTROL_PREFIX,
  MAX_FRAME_BYTES,
  PEER_PRESENT,
  PING,
  PONG,
  SUBPROTOCOL,
  isControl,
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
    for (const m of [PEER_PRESENT, PING, PONG]) {
      expect(isControl(m), m).toBe(true);
    }
  });

  it("控制消息两两不同（同值 = 心跳被当成在场信号，握手会空转）", () => {
    expect(new Set([PEER_PRESENT, PING, PONG]).size).toBe(3);
  });

  it("载荷不被当成控制消息", () => {
    for (const p of ["AAAA", b64encode(new Uint8Array([1, 2, 3])), ""]) {
      expect(isControl(p)).toBe(false);
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
