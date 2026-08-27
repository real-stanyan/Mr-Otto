import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import {
  applyPrivacyGate,
  collectAttachmentRefs,
  packSession,
  PRIVACY_STRIP_TYPES,
  rewriteWorkspace,
  validatePackage,
} from "../../src/shared/sessionPackage.js";

// 会话包（issue #611）的纯逻辑测试。核心是隐私闸——发给好友的副本必须剥掉
// 发送方的记忆/本机快照/本机路径，这是本功能与「轨迹导出（不剥隐私）」的分界。

let ts = 0;
function ev(e: { type: SessionEvent["type"] } & Record<string, unknown>): SessionEvent {
  return { seq: -1, sessionId: "src", ts: ++ts, ...e } as unknown as SessionEvent;
}

/** 一条「什么隐私都沾」的会话流：覆盖每个该剥的类型 + 该留的对话本体 */
function richEvents(): SessionEvent[] {
  return [
    ev({ type: "session_created", title: "源会话", workspace: "/Users/stan/secret/project", workspaceKind: "default" }),
    ev({ type: "memory_loaded", memory: "我的私人记忆", user: "关于我的笔记", project: "项目隐私" }),
    ev({ type: "request_envelope", model: "m", system: "烤着记忆的 system prompt", tools: [] }),
    ev({ type: "user_message", content: "帮我看下这个 bug", attachments: [{ id: "sha256:aaa", mediaType: "image/png", bytes: 3 }] }),
    ev({ type: "assistant_message", content: "我看看", model: "m" }),
    ev({ type: "checkpoint_created", checkpointId: "cp-1" }),
    ev({ type: "tool_result", toolCallId: "t1", status: "ok", output: "结果", images: [{ id: "sha256:bbb", mediaType: "image/png", bytes: 3 }] }),
    ev({ type: "memory_user_edit", target: "memory", before: "a", after: "b" }),
    ev({ type: "memory_nudge", userTurns: 10 }),
    ev({ type: "workspace_restored", checkpointId: "cp-1" }),
    ev({ type: "branch_checked_out", repoDir: "/Users/stan/secret", branch: "main" }),
    ev({ type: "turn_ended", outcome: "completed" }),
  ];
}

describe("applyPrivacyGate（隐私闸，issue #611 的命门）", () => {
  it("剥掉发送方记忆/请求信封/本机快照/本机分支，保留对话本体", () => {
    const { kept, stripped } = applyPrivacyGate(richEvents());
    const keptTypes = kept.map((e) => e.type);

    // 该剥的一个不剩
    expect(keptTypes).not.toContain("request_envelope");
    expect(keptTypes).not.toContain("memory_loaded");
    expect(keptTypes).not.toContain("memory_user_edit");
    expect(keptTypes).not.toContain("memory_nudge");
    expect(keptTypes).not.toContain("checkpoint_created");
    expect(keptTypes).not.toContain("workspace_restored");
    expect(keptTypes).not.toContain("branch_checked_out");

    // 该留的都在：对话本体 + fork 起点
    expect(keptTypes).toEqual([
      "session_created",
      "user_message",
      "assistant_message",
      "tool_result",
      "turn_ended",
    ]);

    // stripped 台账记下了剥过哪些（排序、去重）
    expect(stripped).toContain("memory_loaded");
    expect(stripped).toContain("request_envelope");
    expect(stripped).toContain("checkpoint_created");
    expect([...stripped].sort()).toEqual(stripped);
  });

  it("PRIVACY_STRIP_TYPES 覆盖所有记忆类与请求信封——少一个都是泄露", () => {
    // 钉死清单本身：将来有人加新的记忆类事件类型，这里的断言逼他表态
    expect(PRIVACY_STRIP_TYPES.has("memory_loaded")).toBe(true);
    expect(PRIVACY_STRIP_TYPES.has("memory_user_edit")).toBe(true);
    expect(PRIVACY_STRIP_TYPES.has("memory_nudge")).toBe(true);
    expect(PRIVACY_STRIP_TYPES.has("request_envelope")).toBe(true);
  });

  it("纯净会话（没有隐私事件）原样通过，stripped 为空", () => {
    const clean = [
      ev({ type: "session_created", title: "t" }),
      ev({ type: "user_message", content: "hi" }),
      ev({ type: "turn_ended", outcome: "completed" }),
    ];
    const { kept, stripped } = applyPrivacyGate(clean);
    expect(kept).toHaveLength(3);
    expect(stripped).toEqual([]);
  });

  it("不改传入数组（纯函数）", () => {
    const input = richEvents();
    const before = input.length;
    applyPrivacyGate(input);
    expect(input).toHaveLength(before);
  });
});

describe("rewriteWorkspace（剥掉发送方本机路径）", () => {
  it("session_created 的 workspace / workspaceKind / forkedFrom 被剥掉", () => {
    const e = ev({
      type: "session_created",
      title: "t",
      workspace: "/Users/stan/secret",
      workspaceKind: "default",
      forkedFrom: { sessionId: "x", seq: 5 },
    });
    const out = rewriteWorkspace(e);
    expect(out.type).toBe("session_created");
    const o = out as unknown as Record<string, unknown>;
    expect(o.workspace).toBeUndefined();
    expect(o.workspaceKind).toBeUndefined();
    expect(o.forkedFrom).toBeUndefined();
    expect(o.title).toBe("t"); // 标题保留
  });

  it("非 session_created 事件原样返回", () => {
    const e = ev({ type: "user_message", content: "hi" });
    expect(rewriteWorkspace(e)).toBe(e);
  });
});

describe("collectAttachmentRefs（附件台账）", () => {
  it("从 user_message.attachments 和 tool_result.images 收集，按 id 去重", () => {
    const refs = collectAttachmentRefs([
      ev({ type: "user_message", content: "a", attachments: [
        { id: "sha256:aaa", mediaType: "image/png", bytes: 3 },
        { id: "sha256:dup", mediaType: "image/png", bytes: 3 },
      ] }),
      ev({ type: "tool_result", toolCallId: "t", status: "ok", output: "", images: [
        { id: "sha256:bbb", mediaType: "image/png", bytes: 3 },
        { id: "sha256:dup", mediaType: "image/png", bytes: 3 }, // 重复引用
      ] }),
    ]);
    expect(refs.map((r) => r.id).sort()).toEqual(["sha256:aaa", "sha256:bbb", "sha256:dup"]);
  });
});

describe("packSession（打包）", () => {
  it("过隐私闸 + 改写 workspace + manifest 自洽", () => {
    const pkg = packSession({
      events: richEvents(),
      message: "帮我继续查这个 bug",
      title: "源会话",
      model: "m",
      exportedTs: 1000,
      attachmentBytes: { "sha256:aaa": new Uint8Array([1, 2, 3]) },
    });

    expect(pkg.manifest.kind).toBe("otto.session-package");
    expect(pkg.manifest.version).toBe(1);
    expect(pkg.manifest.message).toBe("帮我继续查这个 bug");
    expect(pkg.manifest.eventCount).toBe(pkg.events.length);
    expect(pkg.manifest.stripped.length).toBeGreaterThan(0);

    // 剥了隐私：包里没有 memory/request_envelope
    expect(pkg.events.some((e) => e.type === "memory_loaded")).toBe(false);
    expect(pkg.events.some((e) => e.type === "request_envelope")).toBe(false);

    // workspace 被剥
    const created = pkg.events.find((e) => e.type === "session_created") as unknown as Record<string, unknown>;
    expect(created.workspace).toBeUndefined();

    // 附件：台账记全量（2 张），字节表只带传进来的那张（aaa）
    expect(pkg.manifest.attachments.map((r) => r.id).sort()).toEqual(["sha256:aaa", "sha256:bbb"]);
    expect(Object.keys(pkg.attachmentBytes)).toEqual(["sha256:aaa"]);
  });
});

describe("validatePackage（解包校验，接收方的第一道门）", () => {
  function validPkg() {
    return packSession({
      events: richEvents(),
      message: "",
      title: null,
      model: null,
      exportedTs: 1,
      attachmentBytes: {},
    });
  }

  it("合法包通过（无错误）", () => {
    expect(validatePackage(validPkg())).toEqual([]);
  });

  it("拒绝非对象 / 缺 manifest / 错 kind / 错版本", () => {
    expect(validatePackage(null)).not.toEqual([]);
    expect(validatePackage({})).not.toEqual([]);
    const bad = validPkg() as unknown as { manifest: { kind: string } };
    bad.manifest = { ...bad.manifest, kind: "wrong" };
    expect(validatePackage(bad).some((e) => e.includes("kind"))).toBe(true);
    const badV = validPkg();
    (badV.manifest as { version: number }).version = 99;
    expect(validatePackage(badV).some((e) => e.includes("版本"))).toBe(true);
  });

  it("事件条数不自洽被拒", () => {
    const pkg = validPkg();
    (pkg.manifest as { eventCount: number }).eventCount = 999;
    expect(validatePackage(pkg).some((e) => e.includes("不自洽"))).toBe(true);
  });

  it("首条不是 session_created 被拒（fork 建不出起点）", () => {
    const pkg = validPkg();
    pkg.events = pkg.events.filter((e) => e.type !== "session_created");
    (pkg.manifest as { eventCount: number }).eventCount = pkg.events.length;
    expect(validatePackage(pkg).some((e) => e.includes("session_created"))).toBe(true);
  });
});

// ─── 端到端：剥隐私后的包能安全重放（fork 可继续执行的最终证明）──────────
// 复用 fork.test.ts「复制式重放 == 引用型 fork」的断言模式：把剥过隐私的包
// 逐条 append 进接收方新会话，deriveMessages 必须能正常投影——不崩、对话本体完整、
// 且发送方的记忆一个字节都不出现在投影里。
describe("会话包重放安全（fork 后能继续执行）", () => {
  it("剥隐私的包逐条 append 进新会话，deriveMessages 正常投影且无发送方记忆", async () => {
    const { EventStore } = await import("../../src/session/store.js");
    const { deriveMessages } = await import("../../src/session/deriveMessages.js");
    const store = new EventStore(":memory:");

    const pkg = packSession({
      events: richEvents(),
      message: "继续",
      title: "源会话",
      model: "m",
      exportedTs: 1,
      attachmentBytes: {},
    });

    // 接收方导入：剥掉发送方的 seq/sessionId，逐条 append（EventStore 重分配 seq）
    const copyId = "receiver-fork";
    for (const e of pkg.events) {
      const { seq: _s, sessionId: _sid, ...rest } = e;
      store.append({ sessionId: copyId, ...rest } as never);
    }

    // 能投影（不崩）——这是「fork 后能继续跑」的前提
    const msgs = deriveMessages(store.load(copyId));
    const text = JSON.stringify(msgs);

    // 对话本体在
    expect(text).toContain("帮我看下这个 bug");
    expect(text).toContain("我看看");

    // 发送方的隐私一个字节都不在投影里
    expect(text).not.toContain("我的私人记忆");
    expect(text).not.toContain("关于我的笔记");
    expect(text).not.toContain("烤着记忆的 system prompt");
    expect(text).not.toContain("/Users/stan/secret");

    store.close();
  });
});

// ─── 导入端契约：重填 workspace + 换 sessionId ──────────────────────────
describe("导入端契约（fork 必须有围栏）", () => {
  it("fillWorkspaceOnImport 给首条 session_created 填上接收方 workspace", async () => {
    const { fillWorkspaceOnImport } = await import("../../src/shared/sessionPackage.js");
    const pkg = packSession({
      events: richEvents(), message: "", title: null, model: null, exportedTs: 1, attachmentBytes: {},
    });
    // 剥白后首条没有 workspace
    expect((pkg.events[0] as unknown as Record<string, unknown>).workspace).toBeUndefined();
    const filled = fillWorkspaceOnImport(pkg.events, "/Users/friend/work");
    expect((filled[0] as unknown as Record<string, unknown>).workspace).toBe("/Users/friend/work");
    // 其余事件不动
    expect(filled.length).toBe(pkg.events.length);
  });

  it("重填后 deriveMessages 能造出围栏 system 消息", async () => {
    const { EventStore } = await import("../../src/session/store.js");
    const { deriveMessages } = await import("../../src/session/deriveMessages.js");
    const { fillWorkspaceOnImport, retargetForImport } = await import("../../src/shared/sessionPackage.js");
    const store = new EventStore(":memory:");
    const pkg = packSession({
      events: richEvents(), message: "", title: null, model: null, exportedTs: 1, attachmentBytes: {},
    });
    const filled = fillWorkspaceOnImport(pkg.events, "/Users/friend/work");
    const retargeted = retargetForImport(filled, "receiver-fork");
    for (const e of retargeted) store.append(e as never);
    const msgs = deriveMessages(store.load("receiver-fork"));
    // 有 system 围栏（含工作目录）
    const sys = msgs.find((m) => m.role === "system");
    expect(sys).toBeDefined();
    expect(JSON.stringify(sys)).toContain("/Users/friend/work");
    store.close();
  });

  it("retargetForImport 换 sessionId 且剥掉旧 seq", async () => {
    const { retargetForImport } = await import("../../src/shared/sessionPackage.js");
    const pkg = packSession({
      events: richEvents(), message: "", title: null, model: null, exportedTs: 1, attachmentBytes: {},
    });
    const out = retargetForImport(pkg.events, "new-id");
    expect(out.every((e) => (e as { sessionId: string }).sessionId === "new-id")).toBe(true);
    expect(out.every((e) => !("seq" in e))).toBe(true);
  });
});
