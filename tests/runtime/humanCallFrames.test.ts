// 人与人电话的服务端那一半（#1534）：控制房的 human_call 帖——不过在籍那道闸、限速走 call 那一档、细判交给 deps.humanCall；
// 回执 human_call_result 带 ICE 清单；没接 humanCall 的装配（smoke / 老测试）回一句「不支持」。配置：TURN_* 要么全有要么全无。
import { describe, expect, it } from "vitest";
import { CS_PROTOCOL_VERSION, decodeCsDown, decodeCsUp, encodeCs } from "../../src/shared/remote/cloudSession.js";
import { DEFAULT_STUN } from "../../src/shared/humanCall.js";
import { MissingConfigError, resolveConfig } from "../../services/runtime/src/config.js";

const ME = "11111111-1111-4111-8111-111111111111";

describe("协议 27：human_call / human_call_result 帖", () => {
  it("up：callId 像个随机串、toUid 像 uid（归一小写）；形状不对整帖拒", () => {
    expect(decodeCsUp(encodeCs({ t: "human_call", callId: "abcdefgh-1", toUid: ME.toUpperCase() }))).toEqual({ t: "human_call", callId: "abcdefgh-1", toUid: ME });
    expect(decodeCsUp(encodeCs({ t: "human_call", callId: "short", toUid: ME }))).toBeNull();
    expect(decodeCsUp(encodeCs({ t: "human_call", callId: "abcdefgh-1", toUid: "nope" }))).toBeNull();
  });
  it("down：ok 带 ice 与 expiresTs；失败带 message；ice 形状不对当缺席", () => {
    const ok = { t: "human_call_result" as const, callId: "c", ok: true, ice: [DEFAULT_STUN], expiresTs: 5 };
    expect(decodeCsDown(encodeCs(ok))).toEqual(ok);
    expect(decodeCsDown(encodeCs({ t: "human_call_result", callId: "c", ok: false, message: "只能给朋友打电话。" }))).toEqual({ t: "human_call_result", callId: "c", ok: false, message: "只能给朋友打电话。" });
    expect(decodeCsDown(encodeCs({ t: "human_call_result", callId: "c", ok: true, ice: "x" } as never))).toEqual({ t: "human_call_result", callId: "c", ok: true });
  });
  it("协议号 27 起有这一对帖（此刻 29：#1656 健康三帧在它之后进位）", () => {
    expect(CS_PROTOCOL_VERSION).toBe(29);
  });
});

describe("config：TURN_*", () => {
  const base = {
    RUNTIME_SECRET: "r", SUPABASE_JWT_SECRET: "j", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k", EDGE_BASE: "e", RELAY_BASE: "l",
  };
  it("没配 = null；两个都配 = 拆 urls；只配一个 = 启动失败并点名缺的那个", () => {
    expect(resolveConfig(base).turn).toBeNull();
    expect(resolveConfig({ ...base, TURN_URLS: "turn:h:3478?transport=udp, turn:h:3478?transport=tcp", TURN_SECRET: "s" }).turn)
      .toEqual({ urls: ["turn:h:3478?transport=udp", "turn:h:3478?transport=tcp"], secret: "s" });
    expect(() => resolveConfig({ ...base, TURN_URLS: "turn:h:3478" })).toThrow(MissingConfigError);
    try {
      resolveConfig({ ...base, TURN_SECRET: "s" });
    } catch (e) {
      expect((e as MissingConfigError).missing).toEqual(["TURN_URLS"]);
    }
  });
});
