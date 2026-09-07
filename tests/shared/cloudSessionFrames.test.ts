import { describe, it, expect } from "vitest";
import { CS_PROTOCOL_VERSION, encodeCs, decodeCsUp, decodeCsDown } from "../../src/shared/remote/cloudSession.js";

/** 帧走 base64（encodeCs 的格式），不是裸 JSON。畸形用例编不出来，手工造一条 */
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

describe("cs_say 的 mentions（#928 切片 1a）", () => {
  it("带 mentions 解得出来", () => {
    const frame = encodeCs({ t: "say", text: "@运营 看下销量", mention: true, mentions: ["ops"] });
    expect(decodeCsUp(frame)).toEqual({ t: "say", text: "@运营 看下销量", mention: true, mentions: ["ops"] });
  });

  it("不带 mentions 照常解 —— 手机端和旧桌面还在发布尔那一版", () => {
    expect(decodeCsUp(encodeCs({ t: "say", text: "在吗", mention: true })))
      .toEqual({ t: "say", text: "在吗", mention: true });
  });

  it("mentions 不是字符串数组就整帧拒掉,不是悄悄丢字段", () => {
    expect(decodeCsUp(b64({ t: "say", text: "x", mention: true, mentions: [1, 2] }))).toBeNull();
    expect(decodeCsUp(b64({ t: "say", text: "x", mention: true, mentions: "ops" }))).toBeNull();
  });
});

describe("cs 协议 6（#957 第三批：stop 帧与 say/approve/stop 回执）", () => {
  it("CS_PROTOCOL_VERSION === 12（…；10 = #1044 删除；11 = #1056 工作文件夹读帧；12 = #1066 搜索）", () => {
    expect(CS_PROTOCOL_VERSION).toBe(12);
  });

  it("stop 上行往返", () => {
    expect(decodeCsUp(encodeCs({ t: "stop" }))).toEqual({ t: "stop" });
  });

  // 复审 C2-I3：桌面按**行**画停止按钮，而不带 turn 标识的 stop 帧一律停"当前
  // 那一轮"——按第二行那颗，停掉的是第一行。seq 是 add-only 的（协议号仍是 6）
  it("stop 带 seq 往返；缺席 = 旧客户端，照常解", () => {
    expect(decodeCsUp(encodeCs({ t: "stop", seq: 7 }))).toEqual({ t: "stop", seq: 7 });
    expect(decodeCsUp(encodeCs({ t: "stop", seq: 0 }))).toEqual({ t: "stop", seq: 0 });
    expect(decodeCsUp(encodeCs({ t: "stop" }))).toEqual({ t: "stop" });
  });

  // 形状不对**整帧无效**，不是"当没带过"：后者会把一条本该被拒的停止悄悄
  // 升级成"停掉当前那一轮"，正是这个字段要防的那件事
  it("seq 不是非负整数就整帧拒掉，不降级成不带 seq 的 stop", () => {
    expect(decodeCsUp(b64({ t: "stop", seq: -1 }))).toBeNull();
    expect(decodeCsUp(b64({ t: "stop", seq: "7" }))).toBeNull();
    expect(decodeCsUp(b64({ t: "stop", seq: 1.5 }))).toBeNull();
    expect(decodeCsUp(b64({ t: "stop", seq: null }))).toBeNull();
  });

  it("say_result 下行往返（有/无 message）", () => {
    expect(decodeCsDown(encodeCs({ t: "say_result", ok: true }))).toEqual({ t: "say_result", ok: true });
    expect(decodeCsDown(encodeCs({ t: "say_result", ok: false, message: "限速了，稍等" }))).toEqual({
      t: "say_result",
      ok: false,
      message: "限速了，稍等",
    });
  });

  it("approve_result 下行往返（有/无 message）", () => {
    expect(decodeCsDown(encodeCs({ t: "approve_result", callId: "c1", ok: true }))).toEqual({
      t: "approve_result",
      callId: "c1",
      ok: true,
    });
    expect(
      decodeCsDown(encodeCs({ t: "approve_result", callId: "c1", ok: false, message: "这一条已经过期" }))
    ).toEqual({ t: "approve_result", callId: "c1", ok: false, message: "这一条已经过期" });
  });

  it("stop_result 下行往返（有/无 message）", () => {
    expect(decodeCsDown(encodeCs({ t: "stop_result", ok: true }))).toEqual({ t: "stop_result", ok: true });
    expect(decodeCsDown(encodeCs({ t: "stop_result", ok: false, message: "此刻没有正在跑的 turn" }))).toEqual({
      t: "stop_result",
      ok: false,
      message: "此刻没有正在跑的 turn",
    });
  });

  it("decodeCsDown 对形状不对的 approve_result.callId 回 null", () => {
    expect(decodeCsDown(b64({ t: "approve_result", ok: true }))).toBeNull();
    expect(decodeCsDown(b64({ t: "approve_result", callId: 1, ok: true }))).toBeNull();
  });
});

describe("cs 协议 10（#1044：delete / delete_result）", () => {
  it("delete 帧 roundtrip；两格必填，缺一格整帧判无效", () => {
    const frame = { t: "delete" as const, workspaceId: "w1", sessionId: "s1" };
    expect(decodeCsUp(encodeCs(frame))).toEqual(frame);
    // 不知道删谁的话这条帧没有意义——退回 null 而不是"当成删当前那条"
    expect(decodeCsUp(encodeCs({ t: "delete", workspaceId: "w1" } as never))).toBeNull();
    expect(decodeCsUp(encodeCs({ t: "delete", sessionId: "s1" } as never))).toBeNull();
  });

  it("delete_result roundtrip：message 可缺席（成功那一路不带）", () => {
    const ok = { t: "delete_result" as const, workspaceId: "w1", sessionId: "s1", ok: true };
    expect(decodeCsDown(encodeCs(ok))).toEqual(ok);
    const failed = { ...ok, ok: false, message: "这一刻读不到这条会话的信息，什么都没删。稍后再试。" };
    expect(decodeCsDown(encodeCs(failed))).toEqual(failed);
    expect(decodeCsDown(encodeCs({ t: "delete_result", workspaceId: "w1", ok: true } as never))).toBeNull();
  });
});

describe("cs 协议 11（#1056：files / files_result）", () => {
  it("files 帧 roundtrip；path 必填，`\"\"` 是合法值（= 工作文件夹本身）", () => {
    const root = { t: "files" as const, workspaceId: "w1", path: "" };
    expect(decodeCsUp(encodeCs(root))).toEqual(root);
    const deep = { t: "files" as const, workspaceId: "w1", path: "src/lib" };
    expect(decodeCsUp(encodeCs(deep))).toEqual(deep);
    // 缺席 ≠ 根：缺了这一格意味着发送方在猜默认值，这一层不替它猜
    expect(decodeCsUp(encodeCs({ t: "files", workspaceId: "w1" } as never))).toBeNull();
    expect(decodeCsUp(encodeCs({ t: "files", path: "" } as never))).toBeNull();
  });

  it("files_result：四种 node 各自 roundtrip", () => {
    const base = { t: "files_result" as const, workspaceId: "w1", path: "", ok: true };
    for (const node of [
      { kind: "absent" as const },
      { kind: "missing" as const },
      { kind: "dir" as const, entries: [{ name: "a.md", kind: "file" as const, size: 12, mtimeMs: 1 }], truncated: false },
      { kind: "file" as const, text: "hi", truncated: false, size: 2 },
      { kind: "binary" as const, size: 99 },
    ]) {
      expect(decodeCsDown(encodeCs({ ...base, node }))).toEqual({ ...base, node });
    }
  });

  it("ok=false 那一路不带 node，message 说明为什么", () => {
    const failed = { t: "files_result" as const, workspaceId: "w1", path: "x", ok: false, message: "这条路径不合法。" };
    expect(decodeCsDown(encodeCs(failed))).toEqual(failed);
  });

  it("node 形状不对 → 整帧不拒，只是没有 node（message 那一路仍然有用）", () => {
    // 与 normalizeModelRoute 同纪律：认不出的降级成缺席，不把整帧判成无效
    const decoded = decodeCsDown(encodeCs({ t: "files_result", workspaceId: "w1", path: "", ok: true, node: { kind: "什么" } } as never));
    expect(decoded).toEqual({ t: "files_result", workspaceId: "w1", path: "", ok: true });
  });

  it("目录项缺字段 → 整份清单判无效，**不静默丢那一项**", () => {
    // 少一项的清单和完整的长得一模一样，而它是假的
    const decoded = decodeCsDown(
      encodeCs({ t: "files_result", workspaceId: "w1", path: "", ok: true, node: { kind: "dir", entries: [{ name: "a" }] } } as never)
    );
    expect(decoded).toEqual({ t: "files_result", workspaceId: "w1", path: "", ok: true });
  });
});

describe("cs 协议 12（#1066：files_search / files_search_result）", () => {
  it("files_search roundtrip；content 必填布尔（两种模式跑的是两条命令）", () => {
    const frame = { t: "files_search" as const, workspaceId: "w1", query: "菜单", content: false };
    expect(decodeCsUp(encodeCs(frame))).toEqual(frame);
    expect(decodeCsUp(encodeCs({ t: "files_search", workspaceId: "w1", query: "x" } as never))).toBeNull();
    expect(decodeCsUp(encodeCs({ t: "files_search", workspaceId: "w1", content: true } as never))).toBeNull();
  });

  it("files_search_result roundtrip：名字模式两个 null，内容模式两个都有", () => {
    const base = { t: "files_search_result" as const, workspaceId: "w1", query: "x", ok: true };
    const hits = [
      { rel: "a.md", line: null, text: null },
      { rel: "sub/b.ts", line: 12, text: "const x = 1" },
    ];
    expect(decodeCsDown(encodeCs({ ...base, hits }))).toEqual({ ...base, hits });
  });

  it("ok=false 那一路不带 hits——「搜不成」与「没有匹配」不是一回事", () => {
    const failed = { t: "files_search_result" as const, workspaceId: "w1", query: "x", ok: false, message: "云端沙箱里没有 ripgrep，搜不了。" };
    expect(decodeCsDown(encodeCs(failed))).toEqual(failed);
  });

  it("一条命中形状不对 → 整份判无效，不静默丢那一条", () => {
    const decoded = decodeCsDown(
      encodeCs({ t: "files_search_result", workspaceId: "w1", query: "x", ok: true, hits: [{ rel: "a" }, { line: 1 }] } as never)
    );
    expect(decoded).toEqual({ t: "files_search_result", workspaceId: "w1", query: "x", ok: true });
  });
});

describe("denied 帧的服务端协议号（复审 C2-I6，add-only、版本仍是 6）", () => {
  it("denied 带 v 往返；缺席 = 老服务端，照常解", () => {
    expect(decodeCsDown(encodeCs({ t: "denied", code: "version_mismatch", v: 6 }))).toEqual({
      t: "denied",
      code: "version_mismatch",
      v: 6,
    });
    expect(decodeCsDown(encodeCs({ t: "denied", code: "version_mismatch" }))).toEqual({
      t: "denied",
      code: "version_mismatch",
    });
    // 别的码不带 v，但真带了也解得出来——解码器不管「该不该带」，只管形状
    expect(decodeCsDown(encodeCs({ t: "denied", code: "bad_jwt" }))).toEqual({ t: "denied", code: "bad_jwt" });
  });

  it("v 不是非负整数就整帧拒掉，不降级成不带 v 的 denied", () => {
    // 一个撒谎的版本号会把方向指反（「云端旧了」vs「你旧了」），比没有版本号更糟
    expect(decodeCsDown(b64({ t: "denied", code: "version_mismatch", v: "6" }))).toBeNull();
    expect(decodeCsDown(b64({ t: "denied", code: "version_mismatch", v: -1 }))).toBeNull();
    expect(decodeCsDown(b64({ t: "denied", code: "version_mismatch", v: 6.5 }))).toBeNull();
    expect(decodeCsDown(b64({ t: "denied", code: "version_mismatch", v: null }))).toBeNull();
  });
});
