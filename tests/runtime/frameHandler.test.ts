// frameHandler 的五条断言（task-10-brief.md Step 1）+ 若干补充覆盖
// （onCtlFrame 的 hello/create 链路、approve 回 false、backlog）。
// 全假 deps：不碰真网络/真 Supabase/真 CloudSession，只验 cid 世界的纯协调逻辑。

import { describe, it, expect } from "vitest";
import { createFrameHandler, type FrameHandlerDeps } from "../../services/runtime/src/frameHandler.js";
import { CS_PROTOCOL_VERSION, encodeCs, csChannel, type CsDown } from "../../src/shared/remote/cloudSession.js";
import type { CloudSession } from "../../services/runtime/src/sessionService.js";

function fakeSession(overrides: Partial<CloudSession> = {}): CloudSession {
  return {
    say: async () => {},
    approve: () => true,
    backlog: () => [],
    isRunning: () => false,
    lastSeq: () => -1,
    initiatorUid: () => null,
    ...overrides,
  };
}

interface Sent {
  cid: string;
  msg: CsDown;
}

/** jwt 约定："jwt:<uid>" 验签成功回 {userId:<uid>}，其余一律 bad_jwt——
    比真 HS256 简单得多，frameHandler 只关心 verifyJwt 的返回值,不关心它怎么验 */
function makeDeps(config: {
  verifyJwt?: FrameHandlerDeps["verifyJwt"];
  isMember?: FrameHandlerDeps["isMember"];
  labelOf?: FrameHandlerDeps["labelOf"];
  getSession?: (workspaceId: string, sessionId: string) => CloudSession | null;
  createSession?: (workspaceId: string, byUid: string) => Promise<{ sessionId: string }>;
  ownerOf?: (workspaceId: string) => Promise<string>;
  saveConfig?: FrameHandlerDeps["saveConfig"];
} = {}): { deps: FrameHandlerDeps; sent: Sent[] } {
  const sent: Sent[] = [];
  const deps: FrameHandlerDeps = {
    verifyJwt: config.verifyJwt ?? (async (token) => (token.startsWith("jwt:") ? { userId: token.slice(4) } : null)),
    isMember: config.isMember ?? (async () => true),
    labelOf: config.labelOf ?? (async (uid) => `Label(${uid})`),
    sessions: {
      get: config.getSession ?? (() => fakeSession()),
      create: config.createSession ?? (async () => ({ sessionId: "new-session" })),
      ownerOf: config.ownerOf ?? (async () => "owner-uid"),
    },
    saveConfig: config.saveConfig ?? (async () => {}),
    send: (cid, msg) => sent.push({ cid, msg }),
  };
  return { deps, sent };
}

const hello = (v: number, jwt: string) => encodeCs({ t: "hello", v, jwt });

describe("createFrameHandler", () => {
  it("① 未 hello 先 say → denied not_authorized，且不落到 CloudSession.say", async () => {
    const sayCalls: unknown[] = [];
    const session = fakeSession({
      say: async (...args: Parameters<CloudSession["say"]>) => {
        sayCalls.push(args);
      },
    });
    const { deps, sent } = makeDeps({ getSession: () => session });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "cX", encodeCs({ t: "say", text: "还没打招呼", mention: false }));

    expect(sent).toEqual([{ cid: "cX", msg: { t: "denied", code: "not_authorized" } }]);
    expect(sayCalls).toHaveLength(0);
  });

  it("② hello 全链路：四种拒绝码各一条 + 成功路径 welcome 形状", async () => {
    const { deps, sent } = makeDeps({
      isMember: async (workspaceId, uid) => workspaceId === "w-member" && uid === "u1",
      getSession: (workspaceId, sessionId) =>
        workspaceId === "w-member" && sessionId === "s-exist"
          ? fakeSession({ lastSeq: () => 7, initiatorUid: () => "u1" })
          : null,
      ownerOf: async () => "owner-uid",
    });
    const handler = createFrameHandler(deps);

    // version_mismatch
    await handler.onSessionFrame("w-member", "s-exist", "c1", hello(999, "jwt:u1"));
    expect(sent.at(-1)).toEqual({ cid: "c1", msg: { t: "denied", code: "version_mismatch" } });

    // bad_jwt
    await handler.onSessionFrame("w-member", "s-exist", "c2", hello(CS_PROTOCOL_VERSION, "garbage"));
    expect(sent.at(-1)).toEqual({ cid: "c2", msg: { t: "denied", code: "bad_jwt" } });

    // not_member（同一个 uid，换一个 isMember 查不中的 workspaceId）
    await handler.onSessionFrame("w-other", "s-exist", "c3", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    expect(sent.at(-1)).toEqual({ cid: "c3", msg: { t: "denied", code: "not_member" } });

    // no_session（在籍但 session 不存在）
    await handler.onSessionFrame("w-member", "s-missing", "c4", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    expect(sent.at(-1)).toEqual({ cid: "c4", msg: { t: "denied", code: "no_session" } });

    // 成功路径
    await handler.onSessionFrame("w-member", "s-exist", "c5", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    expect(sent.at(-1)).toEqual({
      cid: "c5",
      msg: {
        t: "welcome",
        v: CS_PROTOCOL_VERSION,
        sessionId: "s-exist",
        lastSeq: 7,
        initiatorUid: "u1",
        ownerUid: "owner-uid",
      },
    });
  });

  it("③ config：非 owner 拒 not_authorized；owner 过，saveConfig 收到 pat", async () => {
    const saveConfigCalls: { workspaceId: string; cfg: { repoUrl: string; pat?: string } }[] = [];
    const { deps, sent } = makeDeps({
      ownerOf: async () => "owner-uid",
      saveConfig: async (workspaceId, cfg) => {
        saveConfigCalls.push({ workspaceId, cfg });
      },
    });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "cMember", hello(CS_PROTOCOL_VERSION, "jwt:member-uid"));
    await handler.onSessionFrame("w1", "s1", "cOwner", hello(CS_PROTOCOL_VERSION, "jwt:owner-uid"));
    sent.length = 0; // 只关心 config 之后发生了什么

    await handler.onSessionFrame(
      "w1",
      "s1",
      "cMember",
      encodeCs({ t: "config", repoUrl: "https://example.com/repo.git", pat: "secret-pat" })
    );
    expect(sent).toEqual([{ cid: "cMember", msg: { t: "denied", code: "not_authorized" } }]);
    expect(saveConfigCalls).toHaveLength(0);

    await handler.onSessionFrame(
      "w1",
      "s1",
      "cOwner",
      encodeCs({ t: "config", repoUrl: "https://example.com/repo.git", pat: "secret-pat" })
    );
    expect(saveConfigCalls).toEqual([
      { workspaceId: "w1", cfg: { repoUrl: "https://example.com/repo.git", pat: "secret-pat" } },
    ]);
  });

  it("④ say 落到 sessions.get(...).say 且带 label（hello 时缓存的那份，不是每次现查）", async () => {
    const sayCalls: { uid: string; label: string; text: string; mention: boolean }[] = [];
    const session = fakeSession({
      say: async (uid, label, text, mention) => {
        sayCalls.push({ uid, label, text, mention });
      },
    });
    const { deps } = makeDeps({
      getSession: () => session,
      labelOf: async (uid) => `Label(${uid})`,
    });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "干活", mention: true }));

    expect(sayCalls).toEqual([{ uid: "u1", label: "Label(u1)", text: "干活", mention: true }]);
  });

  it("⑤ onGone 清 cid 表：清完后同 cid 再 say 回 denied not_authorized", async () => {
    const { deps, sent } = makeDeps();
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    handler.onGone("c1");
    sent.length = 0;

    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "还在吗", mention: false }));

    expect(sent).toEqual([{ cid: "c1", msg: { t: "denied", code: "not_authorized" } }]);
  });

  // ── 补充覆盖（超出五条最低要求，但同一份纯逻辑，成本很低）──────────────

  it("onCtlFrame：hello 成功后 create 成功，回 created；非成员 create 回 denied not_member", async () => {
    const createCalls: { workspaceId: string; byUid: string }[] = [];
    const { deps, sent } = makeDeps({
      isMember: async (workspaceId, uid) => workspaceId === "w-ok" && uid === "u1",
      createSession: async (workspaceId, byUid) => {
        createCalls.push({ workspaceId, byUid });
        return { sessionId: "s-new" };
      },
    });
    const handler = createFrameHandler(deps);

    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    expect(sent).toEqual([]); // ctl 房 hello 成功静默，没有 welcome 概念

    await handler.onCtlFrame("c1", encodeCs({ t: "create", workspaceId: "w-bad" }));
    expect(sent.at(-1)).toEqual({ cid: "c1", msg: { t: "denied", code: "not_member" } });
    expect(createCalls).toHaveLength(0);

    await handler.onCtlFrame("c1", encodeCs({ t: "create", workspaceId: "w-ok" }));
    expect(sent.at(-1)).toEqual({
      cid: "c1",
      msg: { t: "created", workspaceId: "w-ok", sessionId: "s-new", channel: csChannel("w-ok", "s-new") },
    });
    expect(createCalls).toEqual([{ workspaceId: "w-ok", byUid: "u1" }]);
  });

  it("onCtlFrame：未 hello 先 create → denied not_authorized", async () => {
    const { deps, sent } = makeDeps();
    const handler = createFrameHandler(deps);

    await handler.onCtlFrame("c1", encodeCs({ t: "create", workspaceId: "w1" }));

    expect(sent).toEqual([{ cid: "c1", msg: { t: "denied", code: "not_authorized" } }]);
  });

  it("approve：CloudSession.approve 回 false 时回 error 帧；回 true 时静默", async () => {
    const approveCalls: unknown[] = [];
    const sessionFalse = fakeSession({
      approve: (...args) => {
        approveCalls.push(args);
        return false;
      },
    });
    const { deps, sent } = makeDeps({ getSession: () => sessionFalse });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame(
      "w1",
      "s1",
      "c1",
      encodeCs({ t: "approve", callId: "call-1", decision: "approved" })
    );

    expect(approveCalls).toEqual([["call-1", "u1", "Label(u1)", "approved"]]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg.t).toBe("error");
  });

  it("backlog：回 sessions.get(...).backlog(afterSeq) 的全量结果，done:true", async () => {
    const events = [{ type: "turn_ended", sessionId: "s1", seq: 3, ts: 1, outcome: "completed" }] as never[];
    const session = fakeSession({ backlog: () => events as ReturnType<CloudSession["backlog"]> });
    const { deps, sent } = makeDeps({ getSession: () => session });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "backlog", afterSeq: 0 }));

    expect(sent).toEqual([{ cid: "c1", msg: { t: "backlog", events, done: true } }]);
  });

  it("解不开的帧静默丢弃，不回任何帧", async () => {
    const { deps, sent } = makeDeps();
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "c1", "!!!not-b64!!!");
    await handler.onCtlFrame("c1", "!!!not-b64!!!");

    expect(sent).toEqual([]);
  });
});
