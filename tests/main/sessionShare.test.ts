import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import { shareSessionToFriend, type ShareSendDeps } from "../../src/main/sessionShare.js";
import { importSharedSession, type ShareReceiveDeps } from "../../src/main/sessionShareReceive.js";
import { decodeEnvelope } from "../../src/shared/sessionPackageCodec.js";

// 会话分享的发送/接收编排（issue #611，PR#2）。依赖全注入，用 mock 验证
// 编排逻辑与隐私闸在整条链路上生效，不碰真 Supabase/SQLite。

let ts = 0;
function ev(e: { type: SessionEvent["type"] } & Record<string, unknown>): SessionEvent {
  return { seq: -1, sessionId: "src", ts: ++ts, ...e } as unknown as SessionEvent;
}

const SOURCE_EVENTS: SessionEvent[] = [
  ev({ type: "session_created", title: "源会话", workspace: "/Users/stan/secret" }),
  ev({ type: "memory_loaded", memory: "我的私密记忆" }),
  ev({ type: "user_message", content: "帮我看下 bug", attachments: [{ id: "sha256:aa", mediaType: "image/png", bytes: 3 }] }),
  ev({ type: "assistant_message", content: "我看看", model: "m" }),
  ev({ type: "turn_ended", outcome: "completed" }),
];

function sendDeps(overrides: Partial<ShareSendDeps> = {}): ShareSendDeps & {
  uploaded: Map<string, Uint8Array> | null; dmBody: string | null;
} {
  const state = { uploaded: null as Map<string, Uint8Array> | null, dmBody: null as string | null };
  return Object.assign(state, {
    myUid: async () => "sender-uid",
    loadEvents: () => SOURCE_EVENTS,
    readAttachment: (id: string) => (id === "sha256:aa" ? new Uint8Array([1, 2, 3]) : new Uint8Array()),
    upload: async (files: ReadonlyMap<string, Uint8Array>) => { state.uploaded = new Map(files); },
    sendDm: async (_f: string, body: string) => { state.dmBody = body; },
    newPkgId: () => "pkg-1",
    now: () => 1000,
    ...overrides,
  });
}

describe("shareSessionToFriend（发送端编排）", () => {
  // ─── 连带把服务借出去（issue #694，ADR-0177）────────────────────
  it("默认不带授权：信封里没有邀请码，与这个功能上线前一样", async () => {
    const deps = sendDeps();
    await shareSessionToFriend(deps, {
      sessionId: "src", friendUid: "f", message: "看看", title: null, model: null,
    });
    const env = decodeEnvelope(deps.dmBody!);
    expect(env?.invite).toBeUndefined();
    expect(env?.grantServers).toBeUndefined();
  });

  it("给了邀请码就随信封发出去 —— B 那张卡据此长出「接上服务」的按钮", async () => {
    const deps = sendDeps();
    const r = await shareSessionToFriend(deps, {
      sessionId: "src", friendUid: "f", message: "帮我改店铺", title: null, model: null,
      grantServers: ["shopify"], invite: "otto-proxy:1:a:c:cHVi:c2Vj:1",
    });
    expect(r.ok).toBe(true);
    const env = decodeEnvelope(deps.dmBody!);
    expect(env?.grantServers).toEqual(["shopify"]);
    expect(env?.invite).toBe("otto-proxy:1:a:c:cHVi:c2Vj:1");
  });

  it("空服务清单不写进信封（勾光了 = 只分享对话）", async () => {
    const deps = sendDeps();
    await shareSessionToFriend(deps, {
      sessionId: "src", friendUid: "f", message: "", title: null, model: null,
      grantServers: [], invite: null,
    });
    expect(decodeEnvelope(deps.dmBody!)?.grantServers).toBeUndefined();
  });

  it("全链路：load → 打包（剥隐私）→ 上传 → 发信封", async () => {
    const deps = sendDeps();
    const r = await shareSessionToFriend(deps, {
      sessionId: "src", friendUid: "friend-uid", message: "继续查", title: "源会话", model: "m",
    });
    expect(r.ok).toBe(true);

    // 上传的文件在 sender-uid/pkg-1/ 下
    expect(deps.uploaded).not.toBeNull();
    for (const k of deps.uploaded!.keys()) expect(k.startsWith("sender-uid/pkg-1/")).toBe(true);

    // DM 信封可解、指向同一个 prefix、带留言
    const env = decodeEnvelope(deps.dmBody!);
    expect(env?.prefix).toBe("sender-uid/pkg-1");
    expect(env?.message).toBe("继续查");

    // 隐私闸在链路上生效：上传的 events.jsonl 里没有发送方记忆/本机路径
    const eventsBytes = deps.uploaded!.get("sender-uid/pkg-1/events.jsonl")!;
    const text = new TextDecoder().decode(eventsBytes);
    expect(text).not.toContain("我的私密记忆");
    expect(text).not.toContain("/Users/stan/secret");
    expect(text).toContain("帮我看下 bug"); // 对话本体在

    // 附件字节被读出来并进包
    expect(deps.uploaded!.get("sender-uid/pkg-1/attachments/aa")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("未登录 / 空会话 返回 ok:false 不抛", async () => {
    const notSignedIn = sendDeps({ myUid: async () => null });
    expect((await shareSessionToFriend(notSignedIn, { sessionId: "s", friendUid: "f", message: "", title: null, model: null })).ok).toBe(false);

    const empty = sendDeps({ loadEvents: () => [] });
    expect((await shareSessionToFriend(empty, { sessionId: "s", friendUid: "f", message: "", title: null, model: null })).ok).toBe(false);
  });

  it("单张附件读不到不阻塞整包", async () => {
    const deps = sendDeps({ readAttachment: () => { throw new Error("磁盘读不到"); } });
    const r = await shareSessionToFriend(deps, { sessionId: "src", friendUid: "f", message: "", title: null, model: null });
    expect(r.ok).toBe(true); // 包照样发出去
    expect(deps.uploaded!.has("sender-uid/pkg-1/attachments/aa")).toBe(false); // 只是没带那张图
  });
});

describe("importSharedSession（接收端导入编排）", () => {
  /** 先把发送端跑一遍拿到真实的上传文件，再喂给接收端——两端用同一份包 */
  async function makePackageFiles(): Promise<Map<string, Uint8Array>> {
    const deps = sendDeps();
    await shareSessionToFriend(deps, { sessionId: "src", friendUid: "f", message: "继续", title: "源会话", model: "m" });
    // 剥掉前缀，变成「相对包根」的文件表（downloadPackageFiles 的返回形状）
    const rel = new Map<string, Uint8Array>();
    for (const [k, v] of deps.uploaded!) rel.set(k.replace(/^sender-uid\/pkg-1\//, ""), v);
    return rel;
  }

  function receiveDeps(files: Map<string, Uint8Array> | null) {
    const appended: Record<string, unknown>[] = [];
    const savedAttachments = new Map<string, Uint8Array>();
    const deps: ShareReceiveDeps = {
      download: async () => files,
      saveAttachment: (bytes, _name) => { savedAttachments.set("sha256:aa", bytes); return { id: "sha256:aa" }; },
      append: (_sid, e) => { appended.push(e); },
      newSessionId: () => "receiver-fork",
    };
    return { deps, appended, savedAttachments };
  }

  it("下载 → 解包 → 重填 workspace → 逐条 append（fork 出来）", async () => {
    const files = await makePackageFiles();
    const { deps, appended, savedAttachments } = receiveDeps(files);
    const r = await importSharedSession(deps, { prefix: "sender-uid/pkg-1", workspace: "/Users/friend/work" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessionId).toBe("receiver-fork");
    expect(r.value.missingAttachments).toBe(0);

    // append 的事件：首条 session_created 已重填接收方 workspace
    const first = appended[0] as { type: string; workspace?: string; sessionId: string };
    expect(first.type).toBe("session_created");
    expect(first.workspace).toBe("/Users/friend/work"); // 围栏 = 接收方的，不是发送方那条死路径
    expect(first.sessionId).toBe("receiver-fork");

    // 对话本体过来了
    expect(JSON.stringify(appended)).toContain("帮我看下 bug");
    // 发送方记忆没有
    expect(JSON.stringify(appended)).not.toContain("我的私密记忆");
    // 附件落盘了
    expect(savedAttachments.get("sha256:aa")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("成功臂是 FriendsResult：sessionId 在 value 里（shellBridge 契约，#783）", async () => {
    const files = await makePackageFiles();
    const { deps } = receiveDeps(files);
    const r = await importSharedSession(deps, { prefix: "sender-uid/pkg-1", workspace: "/w" });
    expect(r.ok).toBe(true);
    expect("value" in r).toBe(true);
    expect((r as { value: { sessionId: string } }).value.sessionId).toBe("receiver-fork");
  });

  it("workspace 空串直接拒绝——不铸一个 resume 不回来的死会话（#783 下半）", async () => {
    const files = await makePackageFiles();
    const { deps, appended } = receiveDeps(files);
    const r = await importSharedSession(deps, { prefix: "sender-uid/pkg-1", workspace: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("工作");
    expect(appended.length).toBe(0); // 一条都没落——半截导入比失败更坏
  });

  it("包不存在（被撤回）返回「已失效」", async () => {
    const { deps } = receiveDeps(null);
    const r = await importSharedSession(deps, { prefix: "x/y", workspace: "/w" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("撤回");
  });

  it("坏包返回校验错误", async () => {
    const bad = new Map([["manifest.json", new TextEncoder().encode('{"kind":"wrong"}')]]);
    const { deps } = receiveDeps(bad);
    const r = await importSharedSession(deps, { prefix: "x/y", workspace: "/w" });
    expect(r.ok).toBe(false);
  });
});
