// frameHandler 的五条断言（task-10-brief.md Step 1）+ 若干补充覆盖
// （onCtlFrame 的 hello/create 链路、approve 回 false、backlog）。
// 全假 deps：不碰真网络/真 Supabase/真 CloudSession，只验 cid 世界的纯协调逻辑。

import { describe, it, expect } from "vitest";
import {
  createFrameHandler,
  chunkBacklogFrames,
  safeEncodeCs,
  type FrameHandlerDeps,
} from "../../services/runtime/src/frameHandler.js";
import { CS_PROTOCOL_VERSION, encodeCs, csChannel, type CsDown } from "../../src/shared/remote/cloudSession.js";
import type { CloudSession } from "../../services/runtime/src/sessionService.js";
import type { ChatMessageEvent, SessionEvent } from "../../src/session/events.js";

function fakeSession(overrides: Partial<CloudSession> = {}): CloudSession {
  return {
    say: async () => {},
    approve: () => true,
    backlog: () => [],
    isRunning: () => false,
    lastSeq: () => -1,
    initiatorUid: () => null,
    createdByUid: () => "creator-uid",
    archive: () => true,
    isArchived: () => false,
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
  archiveSession?: FrameHandlerDeps["sessions"]["archive"];
  saveConfig?: FrameHandlerDeps["saveConfig"];
  repoState?: FrameHandlerDeps["repoState"];
  modelState?: FrameHandlerDeps["modelState"];
  dropCid?: FrameHandlerDeps["dropCid"];
  /** issue #819：默认全放行（绝大多数用例不关心限流）。要验闸门的用例
      传一个只对某几档说 false 的假货 */
  rateLimit?: FrameHandlerDeps["rateLimit"];
} = {}): { deps: FrameHandlerDeps; sent: Sent[]; dropCidCalls: string[] } {
  const sent: Sent[] = [];
  const dropCidCalls: string[] = [];
  const deps: FrameHandlerDeps = {
    verifyJwt: config.verifyJwt ?? (async (token) => (token.startsWith("jwt:") ? { userId: token.slice(4) } : null)),
    isMember: config.isMember ?? (async () => true),
    labelOf: config.labelOf ?? (async (uid) => `Label(${uid})`),
    sessions: {
      get: config.getSession ?? (() => fakeSession()),
      create: config.createSession ?? (async () => ({ sessionId: "new-session" })),
      ownerOf: config.ownerOf ?? (async () => "owner-uid"),
      archive: config.archiveSession ?? (async () => true),
    },
    saveConfig: config.saveConfig ?? (async () => {}),
    repoState: config.repoState ?? (() => null),
    modelState: config.modelState ?? (() => null),
    rateLimit: config.rateLimit ?? { allow: () => true },
    send: (cid, msg) => sent.push({ cid, msg }),
    dropCid: config.dropCid ?? ((cid) => dropCidCalls.push(cid)),
  };
  return { deps, sent, dropCidCalls };
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
        repo: null, // 没配仓库（issue #834：welcome 现在带这一格）
        model: null, // 没配模型（issue #844：同一条读路径上的第二格）
      },
    });
  });

  it("③ config：非 owner 拒 not_authorized；owner 过，saveConfig 收到 pat", async () => {
    const saveConfigCalls: {
      workspaceId: string;
      cfg: { repoUrl?: string; pat?: string; model?: { baseUrl: string; modelId: string; apiKey?: string } };
    }[] = [];
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
    // issue #834：存成功要回执，不再静默
    expect(sent.at(-1)).toEqual({
      cid: "cOwner",
      msg: { t: "config_result", ok: true, repo: null, model: null },
    });
  });

  // ── issue #834：服务端自己校验 + 回执 ────────────────────────────────
  // 校验只在渲染层是不够的：那份的定位是"提交前的早期 UX 提示"（文件头
  // 写着），一个改造过的客户端能直接发 `ext::sh -c ...` 上来，那是 git 的
  // 一种传输，会以 root 在容器里跑起来。

  it("③b config：地址过不了服务端校验 → 回 config_result ok:false，saveConfig 一次都不调", async () => {
    const saveConfigCalls: unknown[] = [];
    const { deps, sent } = makeDeps({
      ownerOf: async () => "owner-uid",
      saveConfig: async (workspaceId, cfg) => {
        saveConfigCalls.push({ workspaceId, cfg });
      },
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "cOwner", hello(CS_PROTOCOL_VERSION, "jwt:owner-uid"));
    sent.length = 0;

    for (const repoUrl of ["ext::sh -c whoami", "git@github.com:acme/x.git", "https://tok@github.com/a/b.git"]) {
      await handler.onSessionFrame("w1", "s1", "cOwner", encodeCs({ t: "config", repoUrl }));
    }

    expect(saveConfigCalls).toHaveLength(0);
    expect(sent).toHaveLength(3);
    for (const s of sent) {
      expect(s.msg.t).toBe("config_result");
      expect(s.msg).toMatchObject({ ok: false });
    }
  });

  it("③c config：saveConfig 抛异常 → 也回执（以前只冒到 daemon 的 .catch 记一行日志，按钮照样说已保存）", async () => {
    const { deps, sent } = makeDeps({
      ownerOf: async () => "owner-uid",
      saveConfig: async () => {
        throw new Error("EACCES: 落盘失败");
      },
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "cOwner", hello(CS_PROTOCOL_VERSION, "jwt:owner-uid"));
    sent.length = 0;

    await handler.onSessionFrame(
      "w1",
      "s1",
      "cOwner",
      encodeCs({ t: "config", repoUrl: "https://example.com/repo.git" })
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg).toMatchObject({ t: "config_result", ok: false });
    expect((sent[0]!.msg as { message: string }).message).toContain("EACCES");
  });

  it("③d welcome 带 repoState——任何成员一 join 就看得见仓库状态，不必是 owner", async () => {
    const { deps, sent } = makeDeps({
      ownerOf: async () => "owner-uid",
      repoState: () => ({ url: "https://example.com/repo.git", hasPat: true, clone: null }),
    });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "cMember", hello(CS_PROTOCOL_VERSION, "jwt:member-uid"));

    expect(sent.at(-1)!.msg).toMatchObject({
      t: "welcome",
      repo: { url: "https://example.com/repo.git", hasPat: true, clone: null },
      model: null,
    });
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

  it("复审 Important：say/approve/config 在 hello 之后复查在籍——isMember 翻 false 后被拒且 cid 清出表", async () => {
    let member = true;
    const sayCalls: unknown[] = [];
    const session = fakeSession({
      say: async (...args: Parameters<CloudSession["say"]>) => {
        sayCalls.push(args);
      },
    });
    const { deps, sent, dropCidCalls } = makeDeps({
      isMember: async () => member,
      getSession: () => session,
    });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    member = false; // 被踢出工作区，但 60s 缓存窗口 / 连接本身都还没体现出来
    sent.length = 0;

    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "还能说话吗", mention: false }));
    expect(sent).toEqual([{ cid: "c1", msg: { t: "denied", code: "not_authorized" } }]);
    expect(sayCalls).toHaveLength(0); // 没有落到 CloudSession.say
    expect(dropCidCalls).toEqual(["c1"]); // 复审补漏：同时摘掉广播席位（daemon.ts 的 roomRosters）

    // cid 已经被清出验籍表：同一个 cid 再发 say，走的是「未过 hello」分支
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "再试一次", mention: false }));
    expect(sent).toEqual([{ cid: "c1", msg: { t: "denied", code: "not_authorized" } }]);
  });

  it("复审补漏：backlog 也挂在籍复查——isMember 翻 false 后 backlog 被拒、没调到 session.backlog、dropCid 带正确 cid", async () => {
    let member = true;
    const backlogCalls: unknown[] = [];
    const session = fakeSession({
      backlog: (...args: Parameters<CloudSession["backlog"]>) => {
        backlogCalls.push(args);
        return [];
      },
    });
    const { deps, sent, dropCidCalls } = makeDeps({
      isMember: async () => member,
      getSession: () => session,
    });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    member = false; // 被踢出工作区，读路径（backlog）原本完全不受影响——这正是要堵的口子
    sent.length = 0;

    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "backlog", afterSeq: 0 }));

    expect(sent).toEqual([{ cid: "c1", msg: { t: "denied", code: "not_authorized" } }]);
    expect(backlogCalls).toHaveLength(0); // ① 没有落到 CloudSession.backlog
    expect(dropCidCalls).toEqual(["c1"]); // ② dropCid 被调用，且带的是这个 cid
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

// 终审 C2：一条超限事件（水獭 read_file 一个 ~190KB+ 的 package-lock/打包
// 产物/日志很常见）曾经能让 encodeCs 直接抛错——daemon.ts 的 globalSend
// 扇出时 roster 后半收不到（静默分叉），backlog 重放时异常被 daemon.ts 的
// .catch 吞掉、连 error 帧都不回，客户端死等 done:true 永远停在 connecting。
function chatEvent(seq: number, contentLen: number): ChatMessageEvent {
  return {
    type: "chat_message", sessionId: "s1", seq, ts: seq,
    fromUid: "u", label: "L", content: "x".repeat(contentLen), mention: false,
  };
}

function backlogFramesOf(frames: CsDown[]): Extract<CsDown, { t: "backlog" }>[] {
  return frames.filter((f): f is Extract<CsDown, { t: "backlog" }> => f.t === "backlog");
}

describe("chunkBacklogFrames（终审 C2）", () => {
  it("累计超过阈值时按累计字节切片：多帧、末帧 done:true，事件不丢不重，顺序不变", () => {
    const events = [chatEvent(0, 40), chatEvent(1, 40), chatEvent(2, 40), chatEvent(3, 40)];
    // 单条约 150 字节（40 字符内容 + JSON 信封），阈值调小到 400——两条累计
    // 300 字节还放得下，第三条会把累计推到 450 才触发切片；不用造几十 KB
    // 的 payload 也能验证分片逻辑
    const frames = chunkBacklogFrames(events, 400);

    const backlog = backlogFramesOf(frames);
    expect(backlog.length).toBeGreaterThan(1); // 确实分了不止一片
    expect(frames.at(-1)).toMatchObject({ t: "backlog", done: true }); // 末帧一定是 done:true
    expect(backlog.slice(0, -1).every((f) => f.done === false)).toBe(true); // 中间片都不是 done

    const deliveredSeqs = backlog.flatMap((f) => f.events.map((e) => e.seq));
    expect(deliveredSeqs).toEqual([0, 1, 2, 3]); // 不丢、不重、顺序不乱
  });

  it("单条事件自身超过阈值：跳过并换一条可见 error 帧，仍以 done:true 收尾（不让它绑架同批其余事件）", () => {
    const small = chatEvent(0, 10); // JSON 后约 120 字节，落在阈值以内
    const huge = chatEvent(1, 500); // JSON 后约 610 字节，独自就超过阈值
    const frames = chunkBacklogFrames([small, huge], 200); // 阈值取两者之间

    const deliveredSeqs = backlogFramesOf(frames).flatMap((f) => f.events.map((e) => e.seq));
    expect(deliveredSeqs).toEqual([0]); // huge 没有出现在任何一条 backlog 帧里

    expect(frames.some((f) => f.t === "error")).toBe(true); // 但有一条可见的 error 帧提示它被跳过
    expect(frames.at(-1)).toMatchObject({ t: "backlog", done: true }); // 末帧依然是 done:true——
    // 不然客户端会永远等不到 done:true，原地卡在 connecting（终审 C2 的原始复现）
  });

  it("空事件列表 / 单条小事件：形状与分片之前完全一致（不引入回归）", () => {
    expect(chunkBacklogFrames([])).toEqual([{ t: "backlog", events: [], done: true }]);

    const events = [chatEvent(0, 5)];
    expect(chunkBacklogFrames(events)).toEqual([{ t: "backlog", events, done: true }]);
  });
});

describe("safeEncodeCs（终审 C2）", () => {
  it("编码失败（超过 MAX_FRAME_BYTES）→ 返回 null，调用 onError，不抛出", () => {
    const bigEvent = chatEvent(0, 300 * 1024);
    const errors: unknown[] = [];

    const payload = safeEncodeCs({ t: "event", event: bigEvent }, (err) => errors.push(err));

    expect(payload).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it("正常消息 → 返回与 encodeCs 相同的编码，不调用 onError", () => {
    const errors: unknown[] = [];
    const msg: CsDown = { t: "denied", code: "not_member" };

    const payload = safeEncodeCs(msg, (err) => errors.push(err));

    expect(payload).toBe(encodeCs(msg));
    expect(errors).toHaveLength(0);
  });
});

describe("onSessionFrame 的 backlog 分片接线（终审 C2）", () => {
  it("累计超阈值时 deps.send 收到多条 backlog 帧，末帧 done:true，合并后 seq 连续不重不丢", async () => {
    // 每条约 80KB，默认分片阈值 128KB——两条累计就超阈值，触发切片
    const events: SessionEvent[] = [chatEvent(0, 80_000), chatEvent(1, 80_000), chatEvent(2, 80_000)];
    const session = fakeSession({ backlog: () => events as ReturnType<CloudSession["backlog"]> });
    const { deps, sent } = makeDeps({ getSession: () => session });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "backlog", afterSeq: 0 }));

    const backlogSent = sent
      .filter((s) => s.cid === "c1")
      .map((s) => s.msg)
      .filter((m): m is Extract<CsDown, { t: "backlog" }> => m.t === "backlog");

    expect(backlogSent.length).toBeGreaterThan(1); // 分了不止一片
    expect(backlogSent.at(-1)!.done).toBe(true); // 末片 done:true
    expect(backlogSent.slice(0, -1).every((m) => m.done === false)).toBe(true);

    const merged = backlogSent.flatMap((m) => m.events).map((e) => e.seq);
    expect(merged).toEqual([0, 1, 2]); // 合并后 seq 连续、不重不丢
  });
});

// issue #819：过渡期烧的是维护者的模型 key，而 say / turn 触发 / create
// 三条路一道闸都没有。闸门本身的逻辑在 rateLimit.test.ts，这里验的是接线：
// 拒绝**看得见**（不静默丢），且会话房与控制房用的是两种不同的回执。
describe("限流接线（issue #819）", () => {
  const denying = (deniedKinds: string[]): FrameHandlerDeps["rateLimit"] => ({
    allow: (kind) => !deniedKinds.includes(kind),
  });

  it("say 超速 → 回一条看得见的 error 帧，且不落到 CloudSession.say", async () => {
    const sayCalls: unknown[] = [];
    const session = fakeSession({
      say: async (...args: Parameters<CloudSession["say"]>) => { sayCalls.push(args); },
    });
    const { deps, sent } = makeDeps({ getSession: () => session, rateLimit: denying(["say"]) });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "刷屏", mention: false }));

    expect(sayCalls).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg.t).toBe("error");
  });

  it("会话房里限速回 error 不回 denied —— 客户端把 denied 当终态会直接断连接", async () => {
    const { deps, sent } = makeDeps({ rateLimit: denying(["say", "turn"]) });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "@Agent", mention: true }));
    expect(sent.map((s) => s.msg.t)).toEqual(["error"]);
  });

  it("@Agent 走 turn 桶、普通发言走 say 桶 —— 一帧只记一个桶", async () => {
    const sayCalls: unknown[] = [];
    const session = fakeSession({
      say: async (...args: Parameters<CloudSession["say"]>) => { sayCalls.push(args); },
    });
    // turn 桶空了，say 桶还有：普通发言照常放行，@Agent 被拦
    const { deps, sent } = makeDeps({ getSession: () => session, rateLimit: denying(["turn"]) });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;

    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "闲聊", mention: false }));
    expect(sayCalls).toHaveLength(1);

    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "@Agent 干活", mention: true }));
    expect(sayCalls).toHaveLength(1); // 没再涨
    expect(sent.map((s) => s.msg.t)).toEqual(["error"]);
  });

  it("create 超速 → denied rate_limited（控制房只认 created/denied，回 error 等于让它白等超时）", async () => {
    const created: unknown[] = [];
    const { deps, sent } = makeDeps({
      createSession: async (w, u) => { created.push([w, u]); return { sessionId: "s-new" }; },
      rateLimit: denying(["create"]),
    });
    const handler = createFrameHandler(deps);

    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    await handler.onCtlFrame("c1", encodeCs({ t: "create", workspaceId: "w1" }));

    expect(created).toHaveLength(0);
    expect(sent).toEqual([{ cid: "c1", msg: { t: "denied", code: "rate_limited" } }]);
  });

  it("在籍复查在限流**之前** —— 被踢的人拿到的是「你不在这了」，不是「慢一点」", async () => {
    let member = true;
    const { deps, sent } = makeDeps({
      isMember: async () => member,
      rateLimit: { allow: () => false }, // 三档全空，但它不该是第一个说话的
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    member = false; // hello 之后被踢出工作区
    sent.length = 0;

    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "x", mention: false }));
    expect(sent.map((s) => s.msg)).toEqual([{ t: "denied", code: "not_authorized" }]);
  });
});

// issue #822：`archive` 分支原来是**显式 no-op**（CloudSession 没有 archive
// 方法，deps 也没暴露）。链路上 cs_archive 帧 / ShellBridge / preload / IPC
// 全通，只有服务端什么都不做——好在渲染层也一直没人调，没做出一个"点了
// 没反应"的按钮。
describe("归档（issue #822）", () => {
  const sessionOf = (createdBy: string): CloudSession =>
    fakeSession({ createdByUid: () => createdBy });

  it("owner 可以归档 → 调到 sessions.archive，不回错", async () => {
    const calls: unknown[] = [];
    const { deps, sent } = makeDeps({
      getSession: () => sessionOf("someone-else"),
      ownerOf: async () => "u1",
      archiveSession: async (...args) => { calls.push(args); return true; },
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "archive" }));

    expect(calls).toEqual([["w1", "s1", "Label(u1)"]]);
    expect(sent).toEqual([]); // 成功不回执：session_archived 广播给所有人，那就是回执
  });

  it("建这条会话的人也可以归档（不是只有 owner）", async () => {
    const calls: unknown[] = [];
    const { deps } = makeDeps({
      getSession: () => sessionOf("u1"),
      ownerOf: async () => "someone-else",
      archiveSession: async (...args) => { calls.push(args); return true; },
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "archive" }));
    expect(calls).toHaveLength(1);
  });

  it("既不是 owner 也不是建的人 → not_authorized，不落归档（云端没有恢复归档那一半）", async () => {
    const calls: unknown[] = [];
    const { deps, sent } = makeDeps({
      getSession: () => sessionOf("someone-else"),
      ownerOf: async () => "another-one",
      archiveSession: async (...args) => { calls.push(args); return true; },
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "archive" }));

    expect(calls).toEqual([]);
    expect(sent).toEqual([{ cid: "c1", msg: { t: "denied", code: "not_authorized" } }]);
  });

  it("已经归档过了 → 回一条看得见的 error，不假装成功", async () => {
    const { deps, sent } = makeDeps({
      getSession: () => sessionOf("u1"),
      ownerOf: async () => "u1",
      archiveSession: async () => false,
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "archive" }));
    expect(sent.map((s) => s.msg.t)).toEqual(["error"]);
  });

  it("被踢出工作区的人归档不了 —— 在籍复查在权限判断之前", async () => {
    let member = true;
    const calls: unknown[] = [];
    const { deps, sent } = makeDeps({
      isMember: async () => member,
      getSession: () => sessionOf("u1"),
      ownerOf: async () => "u1",
      archiveSession: async (...args) => { calls.push(args); return true; },
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    member = false;
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "archive" }));
    expect(calls).toEqual([]);
    expect(sent).toEqual([{ cid: "c1", msg: { t: "denied", code: "not_authorized" } }]);
  });
});

// issue #844（推翻 ADR-0199 决策⑥）：模型 key 跟着工作区走，由 owner 自己配。
// runtime 这个进程不再持有任何模型 key，也不做 env 兜底——兜底就是"忘了配的
// 工作区默默烧维护者的钱"。
describe("模型配置（issue #844）", () => {
  const ownerDeps = (extra: Parameters<typeof makeDeps>[0] = {}) =>
    makeDeps({ ownerOf: async () => "u1", ...extra });

  it("只发 model 那一组 → 只有那一组进 saveConfig，仓库那格原样不动", async () => {
    const calls: unknown[] = [];
    const { deps } = ownerDeps({ saveConfig: async (w, cfg) => { calls.push([w, cfg]); } });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));

    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({
      t: "config",
      model: { baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-v4-flash", apiKey: "sk-x" },
    }));

    expect(calls).toEqual([[
      "w1",
      { model: { baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-v4-flash", apiKey: "sk-x" } },
    ]]);
  });

  it("服务端自己校验一次：非 https 的模型地址被拒，不落盘", async () => {
    const calls: unknown[] = [];
    const { deps, sent } = ownerDeps({ saveConfig: async (w, cfg) => { calls.push([w, cfg]); } });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;

    // 一个改造过的客户端能直接发内网地址上来，而 runtime 是拿着平台身份在跑的
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({
      t: "config",
      model: { baseUrl: "http://127.0.0.1:11434/v1", modelId: "x", apiKey: "k" },
    }));

    expect(calls).toEqual([]);
    const last = sent.at(-1)!.msg as Extract<CsDown, { t: "config_result" }>;
    expect(last.t).toBe("config_result");
    expect(last.ok).toBe(false);
  });

  it("型号为空也被拒 —— 半个配置比没有配置更危险", async () => {
    const calls: unknown[] = [];
    const { deps, sent } = ownerDeps({ saveConfig: async (w, cfg) => { calls.push([w, cfg]); } });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;

    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({
      t: "config",
      model: { baseUrl: "https://api.deepseek.com/v1", modelId: "  ", apiKey: "k" },
    }));

    expect(calls).toEqual([]);
    expect((sent.at(-1)!.msg as { ok: boolean }).ok).toBe(false);
  });

  it("一格都没给 → 明确说「没有要保存的内容」，不假装存过了", async () => {
    const calls: unknown[] = [];
    const { deps, sent } = ownerDeps({ saveConfig: async (w, cfg) => { calls.push([w, cfg]); } });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;

    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "config" }));

    expect(calls).toEqual([]);
    expect((sent.at(-1)!.msg as { ok: boolean }).ok).toBe(false);
  });

  it("非 owner 改模型同样被拒 —— key 是谁的钱，只有 owner 说了算", async () => {
    const calls: unknown[] = [];
    const { deps, sent } = makeDeps({
      ownerOf: async () => "someone-else",
      saveConfig: async (w, cfg) => { calls.push([w, cfg]); },
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;

    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({
      t: "config",
      model: { baseUrl: "https://api.deepseek.com/v1", modelId: "m", apiKey: "k" },
    }));

    expect(calls).toEqual([]);
    expect(sent).toEqual([{ cid: "c1", msg: { t: "denied", code: "not_authorized" } }]);
  });

  it("welcome 带 model 那一格 —— 任何人一 join 就知道「这个工作区能不能干活」", async () => {
    const { deps, sent } = makeDeps({
      modelState: () => ({ baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-v4-flash", hasKey: true }),
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    const welcome = sent.at(-1)!.msg as Extract<CsDown, { t: "welcome" }>;
    expect(welcome.model).toEqual({
      baseUrl: "https://api.deepseek.com/v1",
      modelId: "deepseek-v4-flash",
      hasKey: true,
    });
  });
});
