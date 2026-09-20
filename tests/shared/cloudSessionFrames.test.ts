import { describe, it, expect } from "vitest";
import { CS_PROTOCOL_VERSION, encodeCs, decodeCsUp, decodeCsDown } from "../../src/shared/remote/cloudSession.js";

/** 帧走 base64url **无填充**（b64.ts 的格式，不是标准 base64），不是裸 JSON。畸形用例编不出来，手工造一条。
    这里必须与 `b64encode` 逐字节同一种编码：标准 base64 的 `+` `/` `=` 三个字符 `b64decode` 一个都不认，
    于是一条本该走到形状校验的畸形帧会在**解码**那一步就回 null——用例照样绿，但守的是另一件事（#1280 撞上的） */
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

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
  it("CS_PROTOCOL_VERSION === 20（…；15 = #1103 Git 凭据；16 = #1107 流式 delta 帧；17 = #1163 语音通话 call 帧；18 = #1140 wiki_write 帧；19 = #1233 say.voice；20 = #1280 聊天）", () => {
    expect(CS_PROTOCOL_VERSION).toBe(20);
  });

  it("delta 下行往返（协议 16，#1107）", () => {
    expect(decodeCsDown(encodeCs({ t: "delta", agentId: "admin", kind: "content", text: "半句话" })))
      .toEqual({ t: "delta", agentId: "admin", kind: "content", text: "半句话" });
    expect(decodeCsDown(encodeCs({ t: "delta", agentId: "ops", kind: "reasoning", text: "想" })))
      .toEqual({ t: "delta", agentId: "ops", kind: "reasoning", text: "想" });
  });

  it("delta 形状不对整帧拒掉——kind 认不出不许猜（两个槽画错位置比不显示更糟）", () => {
    expect(decodeCsDown(b64({ t: "delta", agentId: "a", kind: "thinking", text: "x" }))).toBeNull();
    expect(decodeCsDown(b64({ t: "delta", agentId: "a", kind: "content" }))).toBeNull();
    expect(decodeCsDown(b64({ t: "delta", kind: "content", text: "x" }))).toBeNull();
    expect(decodeCsDown(b64({ t: "delta", agentId: 1, kind: "content", text: "x" }))).toBeNull();
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

describe("协议 20：聊天（#1280）", () => {
  const WS = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
  const SID = "8b1f0c1e-2d3a-4e5f-8a9b-0c1d2e3f4a5b";

  it("create：不带 chat 与今天逐字节相同；带 dm / group 原样往返", () => {
    const plain = { t: "create" as const, workspaceId: WS };
    expect(decodeCsUp(encodeCs(plain))).toEqual(plain);
    const dm = { t: "create" as const, workspaceId: WS, chat: { kind: "dm" as const, agentId: "a_0123456789ab" } };
    expect(decodeCsUp(encodeCs(dm))).toEqual(dm);
    const group = {
      t: "create" as const,
      workspaceId: WS,
      chat: { kind: "group" as const, name: "上线冲刺", agentIds: ["admin", "a_0123456789ab"] },
    };
    expect(decodeCsUp(encodeCs(group))).toEqual(group);
  });

  it.each([
    [{ kind: "dm", agentId: "运营" }],
    [{ kind: "dm" }],
    [{ kind: "group", name: "", agentIds: ["admin"] }],
    [{ kind: "group", name: "x".repeat(61), agentIds: ["admin"] }],
    [{ kind: "group", name: "群", agentIds: [] }],
    [{ kind: "group", name: "群", agentIds: ["admin", 7] }],
    [{ kind: "room" }],
    ["dm"],
  ])("create.chat 形状不对整帧拒掉（静默当成团队会话 = 这条聊天里凭空站着整个团队）：%j", (chat) => {
    expect(decodeCsUp(b64({ t: "create", workspaceId: WS, chat }))).toBeNull();
  });

  it("chat_update：name / agentIds 至少带一样；群名两头的空白剥掉", () => {
    const both = { t: "chat_update" as const, workspaceId: WS, sessionId: SID, name: "新名字", agentIds: ["admin"] };
    expect(decodeCsUp(encodeCs(both))).toEqual(both);
    expect(decodeCsUp(b64({ t: "chat_update", workspaceId: WS, sessionId: SID, name: "  改名  " }))).toEqual({
      t: "chat_update",
      workspaceId: WS,
      sessionId: SID,
      name: "改名",
    });
    expect(decodeCsUp(b64({ t: "chat_update", workspaceId: WS, sessionId: SID }))).toBeNull();
    expect(decodeCsUp(b64({ t: "chat_update", workspaceId: WS, sessionId: SID, agentIds: ["nope"] }))).toBeNull();
  });

  it("backlog：老的 afterSeq 不变；tail 那一种要正整数 limit，beforeSeq 可缺", () => {
    expect(decodeCsUp(encodeCs({ t: "backlog", afterSeq: -1 }))).toEqual({ t: "backlog", afterSeq: -1 });
    expect(decodeCsUp(b64({ t: "backlog", tail: true, limit: 200 }))).toEqual({ t: "backlog", tail: true, limit: 200 });
    expect(decodeCsUp(b64({ t: "backlog", tail: true, limit: 50, beforeSeq: 120 }))).toEqual({
      t: "backlog",
      tail: true,
      limit: 50,
      beforeSeq: 120,
    });
    for (const bad of [{ limit: 0 }, { limit: 501 }, { limit: 1.5 }, { limit: 10, beforeSeq: -1 }, {}])
      expect(decodeCsUp(b64({ t: "backlog", tail: true, ...bad }))).toBeNull();
  });

  it("下行：welcome.chat / backlog.hasMore 缺席时与今天逐字节相同；chat_update_result 往返", () => {
    const welcome = {
      t: "welcome" as const,
      v: CS_PROTOCOL_VERSION,
      sessionId: SID,
      lastSeq: 9,
      initiatorUid: null,
      ownerUid: "o",
      modelRoute: null,
    };
    expect(decodeCsDown(encodeCs(welcome))).toEqual(welcome);
    const withChat = { ...welcome, chat: { kind: "group" as const, agentIds: ["admin", "a_0123456789ab"] } };
    expect(decodeCsDown(encodeCs(withChat))).toEqual(withChat);
    expect(decodeCsDown(b64({ ...welcome, chat: { kind: "dm", agentIds: "admin" } }))).toBeNull();
    expect(decodeCsDown(encodeCs({ t: "backlog", events: [], done: true }))).toEqual({
      t: "backlog",
      events: [],
      done: true,
    });
    expect(decodeCsDown(encodeCs({ t: "backlog", events: [], done: true, hasMore: true }))).toEqual({
      t: "backlog",
      events: [],
      done: true,
      hasMore: true,
    });
    const res = { t: "chat_update_result" as const, workspaceId: WS, sessionId: SID, ok: false, message: "无权修改" };
    expect(decodeCsDown(encodeCs(res))).toEqual(res);
  });
});
