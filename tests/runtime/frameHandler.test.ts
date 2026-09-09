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
import { BACKLOG_SKIP_MARKER, CS_PROTOCOL_VERSION, encodeCs, csChannel, type CsDown } from "../../src/shared/remote/cloudSession.js";
import { b64encode } from "../../src/shared/remote/b64.js";
import { SayRejectedError, type CloudSession } from "../../services/runtime/src/sessionService.js";
import type { ChatMessageEvent, SessionEvent } from "../../src/session/events.js";
import { TURN_BUCKET, throttleMessage } from "../../services/runtime/src/rateLimit.js";
import { mentionTokens } from "../../src/shared/remote/agentMention.js";

function fakeSession(overrides: Partial<CloudSession> = {}): CloudSession {
  return {
    say: async () => {},
    // #937：say() 不再等 turn 跑完，等待点搬进了 settled()。这一层不消费它
    settled: async () => {},
    approve: () => "ok",
    backlog: () => [],
    isRunning: () => false,
    lastSeq: () => -1,
    initiatorUid: () => null,
    currentAgentId: () => null,
    createdByUid: () => "creator-uid",
    archive: () => true,
    isArchived: () => false,
    // #957 A-2：默认"空闲"——绝大多数用例不关心停止键
    stop: () => "idle",
    // #1163：默认收下——绝大多数用例不关心语音通话
    setVoiceCall: async () => ({ kind: "ok" }),
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
  creatorOf?: FrameHandlerDeps["sessions"]["creatorOf"];
  removeSession?: FrameHandlerDeps["sessions"]["remove"];
  /** issue #945：默认「探不到」（null）——绝大多数用例不关心这一格 */
  modelRoute?: FrameHandlerDeps["modelRoute"];
  gitHosts?: FrameHandlerDeps["gitHosts"];
  putGitCredential?: FrameHandlerDeps["putGitCredential"];
  dropCid?: FrameHandlerDeps["dropCid"];
  /** issue #819：默认全放行（绝大多数用例不关心限流）。要验闸门的用例
      传一个只对某几档说 false 的假货 */
  rateLimit?: FrameHandlerDeps["rateLimit"];
  /** #1056：默认回一个空目录——绝大多数用例不关心工作文件夹 */
  readWork?: FrameHandlerDeps["readWork"];
  /** #1066：默认搜不到东西 */
  searchWork?: FrameHandlerDeps["searchWork"];
} = {}): { deps: FrameHandlerDeps; sent: Sent[]; dropCidCalls: string[]; logs: string[] } {
  const sent: Sent[] = [];
  const dropCidCalls: string[] = [];
  const logs: string[] = [];
  const deps: FrameHandlerDeps = {
    gitHosts: config.gitHosts ?? (() => []),
    putGitCredential: config.putGitCredential ?? (() => {}),
    verifyJwt: config.verifyJwt ?? (async (token) => (token.startsWith("jwt:") ? { userId: token.slice(4) } : null)),
    isMember: config.isMember ?? (async () => true),
    labelOf: config.labelOf ?? (async (uid) => `Label(${uid})`),
    sessions: {
      get: config.getSession ?? (() => fakeSession()),
      create: config.createSession ?? (async () => ({ sessionId: "new-session" })),
      ownerOf: config.ownerOf ?? (async () => "owner-uid"),
      archive: config.archiveSession ?? (async () => true),
      // #1044：默认「这条会话是 owner 建的」——绝大多数用例不关心谁建的
      creatorOf: config.creatorOf ?? (async () => "owner-uid"),
      remove: config.removeSession ?? (async () => true),
    },
    modelRoute: config.modelRoute ?? (async () => null),
    readWork: config.readWork ?? (async () => ({ kind: "dir", entries: [], truncated: false })),
    searchWork: config.searchWork ?? (async () => []),
    rateLimit: config.rateLimit ?? { allow: () => true },
    send: (cid, msg) => sent.push({ cid, msg }),
    dropCid: config.dropCid ?? ((cid) => dropCidCalls.push(cid)),
    log: (m) => logs.push(m),
  };
  return { deps, sent, dropCidCalls, logs };
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

    // version_mismatch：**只有这个码带 v**（复审 C2-I6）——桌面靠它分辨
    // 「我旧了」还是「云端旧了」，两者该做的动作相反
    await handler.onSessionFrame("w-member", "s-exist", "c1", hello(999, "jwt:u1"));
    expect(sent.at(-1)).toEqual({
      cid: "c1",
      msg: { t: "denied", code: "version_mismatch", v: CS_PROTOCOL_VERSION },
    });

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
        modelRoute: null, // 探不到（issue #945：假 deps 默认不探）
      },
    });
  });

  // 协议 8（#991）：config 走控制房（带 workspaceId），不再依赖开着一条会话

  it("③e welcome 带 modelRoute——runtime 用 decideRuntimeRoute 算好下发，客户端不重算（#945）", async () => {
    const { deps, sent } = makeDeps({ modelRoute: async () => ({ kind: "hosted", model: "glm-5" }) });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    expect(sent[0]!.msg).toMatchObject({ t: "welcome", modelRoute: { kind: "hosted", model: "glm-5" } });
  });

  // 每次调用换一个答案的假探针（#945 复审 F1）：常量桩对「什么时候探的」
  // 这个判断完全不敏感——存之前探还是存之后探，回执长得一模一样，而这条
  // 决策的全部内容正是「存完那把 key 之后才算数」。同时数调用次数：改完
  // 签名（探一次、ownerUid 由调用点递进来）之后，一条 config 帧恰好探一次
  const routeSpy = (...answers: (Awaited<ReturnType<FrameHandlerDeps["modelRoute"]>>)[]) => {
    const calls: { workspaceId: string; ownerUid: string }[] = [];
    const modelRoute: FrameHandlerDeps["modelRoute"] = async (workspaceId, ownerUid) => {
      calls.push({ workspaceId, ownerUid });
      return answers[Math.min(calls.length - 1, answers.length - 1)] ?? null;
    };
    return { modelRoute, calls };
  };



  it("③h modelRoute 拿到的是这一层已经查过的 ownerUid，不让实现自己再查一次（#945 复审 F2）", async () => {
    const spy = routeSpy({ kind: "blocked" });
    const { deps } = makeDeps({ ownerOf: async () => "owner-uid", modelRoute: spy.modelRoute });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w-x", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    expect(spy.calls).toEqual([{ workspaceId: "w-x", ownerUid: "owner-uid" }]);
  });

  // ── issue #834：服务端自己校验 + 回执 ────────────────────────────────
  // 校验只在渲染层是不够的：那份的定位是"提交前的早期 UX 提示"（文件头
  // 写着），一个改造过的客户端能直接发 `ext::sh -c ...` 上来，那是 git 的
  // 一种传输，会以 root 在容器里跑起来。

  it("③d welcome 不再带 repo —— 团队不绑仓库了（#1102），但 modelRoute 那一格照旧", async () => {
    const { deps, sent } = makeDeps({
      ownerOf: async () => "owner-uid",
      modelRoute: async () => ({ kind: "hosted", model: "glm-5" }),
    });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "cMember", hello(CS_PROTOCOL_VERSION, "jwt:member-uid"));

    const msg = sent.at(-1)!.msg as Record<string, unknown>;
    expect(msg).toMatchObject({ t: "welcome", modelRoute: { kind: "hosted", model: "glm-5" } });
    // 键本身要没了，不是「值是 null」——后者会让下一个人以为它还在被谁读
    expect("repo" in msg).toBe(false);
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

  it("say 帧的 mentions 原样递给 session.say（#928）", async () => {
    const said: unknown[] = [];
    const session = fakeSession({
      say: async (...args: Parameters<CloudSession["say"]>) => {
        said.push(args);
      },
    });
    const { deps } = makeDeps({ getSession: () => session, labelOf: async () => "alice" });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    await handler.onSessionFrame(
      "w1",
      "s1",
      "c1",
      encodeCs({ t: "say", text: "@运营 看下销量", mention: true, mentions: ["ops"] })
    );

    // 第 6 个参数是限速下沉之后的 budget 回调（#957 B2-C1）：这条断言只管
    // 帧字段有没有原样递进去，价钱那一格另有它自己的用例
    expect((said[0] as unknown[]).slice(0, 5)).toEqual(["u1", "alice", "@运营 看下销量", true, ["ops"]]);
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
    member = false; // 被踢出团队，但 60s 缓存窗口 / 连接本身都还没体现出来
    sent.length = 0;

    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "还能说话吗", mention: false }));
    // #964：回执排在 denied **之前**——deny 顺手 dropCid，之后再 send 什么都是
    // 静默丢帧（daemon 的 globalSend 第一行就查不到这个 cid 的 transport）
    expect(sent).toEqual([
      { cid: "c1", msg: { t: "say_result", ok: false, message: expect.stringContaining("不在这个团队") } },
      { cid: "c1", msg: { t: "denied", code: "not_authorized" } },
    ]);
    expect(sayCalls).toHaveLength(0); // 没有落到 CloudSession.say
    expect(dropCidCalls).toEqual(["c1"]); // 复审补漏：同时摘掉广播席位（daemon.ts 的 roomRosters）

    // cid 已经被清出验籍表：同一个 cid 再发 say，走的是「未过 hello」分支
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "再试一次", mention: false }));
    // 这一条走的是「未过 hello」分支：没有 entry 就没有会话语境，只有 denied
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
    member = false; // 被踢出团队，读路径（backlog）原本完全不受影响——这正是要堵的口子
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

  it("approve：CloudSession.approve 回 ok 时回 approve_result{ok:true}（#964）", async () => {
    const approveCalls: unknown[] = [];
    const sessionOk = fakeSession({
      approve: (...args) => {
        approveCalls.push(args);
        return "ok";
      },
    });
    const { deps, sent, logs } = makeDeps({ getSession: () => sessionOk });
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
    // #964：成功也回执（原来是静默）——没有它，卡上那颗按钮的 submitting
    // 只能等 15 s 超时自己醒来。callId 带上，群聊里两张卡才分得开
    expect(sent).toEqual([{ cid: "c1", msg: { t: "approve_result", callId: "call-1", ok: true } }]);
    expect(logs).toHaveLength(0);
  });

  it("approve：no_pending / not_allowed 各回一条带 callId 的 approve_result{ok:false} + log（#957 A-11/#927，载体 #964 换成回执）", async () => {
    const outcomes: ("ok" | "no_pending" | "not_allowed")[] = ["no_pending", "not_allowed"];
    let i = 0;
    const session = fakeSession({ approve: () => outcomes[i++]! });
    const { deps, sent, logs } = makeDeps({ getSession: () => session });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;

    await handler.onSessionFrame(
      "w1", "s1", "c1",
      encodeCs({ t: "approve", callId: "call-1", decision: "approved" })
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg).toEqual({
      t: "approve_result", callId: "call-1", ok: false,
      message: expect.stringContaining("这条审批已经处理过或已过期"),
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("call-1");
    expect(logs[0]).toContain("u1");

    sent.length = 0;
    await handler.onSessionFrame(
      "w1", "s1", "c1",
      encodeCs({ t: "approve", callId: "call-2", decision: "approved" })
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg).toEqual({
      t: "approve_result", callId: "call-2", ok: false,
      message: expect.stringContaining("只有发起人或 owner 能批这条"),
    });
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain("call-2");
    expect(logs[1]).toContain("u1");
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
    // 判据是**共用的那个常量**（终审 I2）：客户端靠 `msg.includes(BACKLOG_SKIP_MARKER)`
    // 认出这一类 error 帧并据此挂历史缺口横幅。两端各写一份字面量的话，这边改一个字
    // 那边就静默失效——而这条修的正是「失败无声」
    expect(frames.find((f) => f.t === "error")).toMatchObject({
      msg: expect.stringContaining(BACKLOG_SKIP_MARKER),
    });
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
describe("限流接线（issue #819 / 第二轮复审 B2-C1）", () => {
  const denying = (deniedKinds: string[]): FrameHandlerDeps["rateLimit"] => ({
    allow: (kind) => !deniedKinds.includes(kind),
  });

  /** 限速下沉到 say() 里 resolveTargets 之后（#957 B2-C1）之后，frameHandler
      这一侧只递一个 budget 回调进去 —— 假 session 得把 say() 里那一段「解出
      真实 targets 再问价」照抄一遍（数量口径同 resolveTargets：客户端给了
      mentions 以它为准，缺席就数正文里的 @，都没有再看 mention 布尔），
      否则限速接线在这一层根本执行不到。record 只在放行之后调 = 真 say() 里
      「拒绝时一个字节都不落盘」那条 */
  function budgetedSession(record: (args: unknown[]) => void): CloudSession {
    return fakeSession({
      say: async (fromUid, label, text, mention, mentions, budget) => {
        const targets = mentions !== undefined ? [...new Set(mentions)] : mentionTokens(text);
        const n = targets.length > 0 ? targets.length : mention ? 1 : 0;
        const veto = budget?.(n) ?? null;
        if (veto !== null) throw new SayRejectedError(veto);
        record([fromUid, label, text, mention, mentions]);
      },
    });
  }

  it("say 超速 → 回一条看得见的 say_result{ok:false}，且这句话一个字节都没落盘", async () => {
    const sayCalls: unknown[] = [];
    const { deps, sent, logs } = makeDeps({
      getSession: () => budgetedSession((a) => sayCalls.push(a)),
      rateLimit: denying(["say"]),
    });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    logs.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "刷屏", mention: false }));

    expect(sayCalls).toHaveLength(0);
    expect(sent).toHaveLength(1);
    // #964：文案一字不改，载体从无主的 error 帧换成这一句话自己的回执
    expect(sent[0]!.msg).toMatchObject({ t: "say_result", ok: false, message: throttleMessage("say") });
    // 限速是业务拒绝不是内部异常：不该记进「say 失败」那条维护者告警
    expect(logs).toEqual([]);
  });

  it("会话房里限速回 say_result 不回 denied —— 客户端把 denied 当终态会直接断连接", async () => {
    const { deps, sent } = makeDeps({
      getSession: () => budgetedSession(() => {}),
      rateLimit: denying(["say", "turn"]),
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "@Agent", mention: true }));
    // 关键仍然是"不是 denied"（客户端把 denied 当终态会直接断连接）；
    // 载体 #964 之后是 say_result{ok:false}
    expect(sent.map((s) => s.msg.t)).toEqual(["say_result"]);
    expect(sent[0]!.msg).toMatchObject({ ok: false });
  });

  it("点了名的走 turn 桶、闲聊走 say 桶 —— 一帧只记一个桶", async () => {
    const sayCalls: unknown[] = [];
    // turn 桶空了，say 桶还有：普通发言照常放行，@Agent 被拦
    const { deps, sent } = makeDeps({
      getSession: () => budgetedSession((a) => sayCalls.push(a)),
      rateLimit: denying(["turn"]),
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;

    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "闲聊", mention: false }));
    expect(sayCalls).toHaveLength(1);
    expect(sent.map((s) => s.msg)).toEqual([{ t: "say_result", ok: true }]);
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "@Agent 干活", mention: true }));
    expect(sayCalls).toHaveLength(1); // 没再涨
    expect(sent.map((s) => s.msg.t)).toEqual(["say_result"]);
    expect(sent[0]!.msg).toMatchObject({ ok: false });
  });

  it("mentions 非空但 mention=false 也走 turn 桶（#932 坑 ④）—— chip 输入那条帧会真起 turn", async () => {
    const sayCalls: unknown[] = [];
    // 记下每一帧记的是哪个桶：只断言"被拦住了"分不清它是被 turn 档拦的还是
    // say 档 —— 而这条 issue 修的正是"记错桶"。#968 之后 say 桶先在粗闸
    // 那一次不可省的照过一遍（每个 say 帧都要照），所以这里是 ["say","turn"]
    // 而不是单独一个 "turn"
    const buckets: string[] = [];
    const { deps, sent } = makeDeps({
      getSession: () => budgetedSession((a) => sayCalls.push(a)),
      rateLimit: { allow: (kind) => { buckets.push(kind); return kind !== "turn"; } },
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    buckets.length = 0;

    await handler.onSessionFrame(
      "w1", "s1", "c1",
      encodeCs({ t: "say", text: "看下销量", mention: false, mentions: ["ops"] })
    );

    expect(buckets).toEqual(["say", "turn"]);
    expect(sayCalls).toHaveLength(0);
    expect(sent.map((s) => s.msg.t)).toEqual(["say_result"]);
    expect(sent[0]!.msg).toMatchObject({ ok: false });
  });

  it("mentions 长度 3 的帧扣 3 个 turn 令牌（限速按点名数扣，#957 B-I5）", async () => {
    const sayCalls: unknown[] = [];
    const allowCalls: unknown[] = [];
    const { deps, sent } = makeDeps({
      getSession: () => budgetedSession((a) => sayCalls.push(a)),
      rateLimit: { allow: (...args) => { allowCalls.push(args); return true; } },
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    allowCalls.length = 0;

    await handler.onSessionFrame(
      "w1", "s1", "c1",
      encodeCs({ t: "say", text: "@三个人", mention: true, mentions: ["a", "b", "c"] })
    );

    // #968：say 桶的粗闸在 requireStillMember 之前先付一次（每个 say 帧
    // 都付，不管点没点名），turn 桶仍然按真实 targets 数在 budget 里另付
    expect(allowCalls).toEqual([["say", "u1"], ["turn", "u1", 3]]);
    expect(sayCalls).toHaveLength(1);
  });

  // 第二轮复审 B2-C1（Critical）：**省掉 mentions 字段的客户端**。价钱原来在
  // 这一层按 `msg.mentions?.length ?? 1` 算，于是一句正文里 @ 了 N 个人、
  // 字段却缺席的话按 1 个令牌收，而 say() 那边照样起 N 条真花钱的模型调用。
  // 现在价钱由 say() 里 resolveTargets 之后的真实 targets 决定
  it("mentions 缺席、正文 @ 了两只 → 按 2 扣 turn 令牌（B2-C1）", async () => {
    const allowCalls: unknown[] = [];
    const { deps } = makeDeps({
      getSession: () => budgetedSession(() => {}),
      rateLimit: { allow: (...args) => { allowCalls.push(args); return true; } },
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    allowCalls.length = 0;

    await handler.onSessionFrame(
      "w1", "s1", "c1",
      encodeCs({ t: "say", text: "@运营 @广告 看下", mention: false })
    );

    // #968：粗闸的 say 令牌先付一次，turn 令牌再按正文里数出的 2 个另付
    expect(allowCalls).toEqual([["say", "u1"], ["turn", "u1", 2]]);
  });

  it("闲聊只扣一次 say 令牌（#968）—— 没点名时 budget 的 n===0 直接放行，钱已经在粗闸付过了", async () => {
    const allowCalls: unknown[] = [];
    const { deps } = makeDeps({
      getSession: () => budgetedSession(() => {}),
      rateLimit: { allow: (...args) => { allowCalls.push(args); return true; } },
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    allowCalls.length = 0;

    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "你好", mention: false }));

    // 只有 requireStillMember 之前那一次粗闸调用——budget(0) 不再额外问价
    expect(allowCalls).toEqual([["say", "u1"]]);
  });

  // 第二轮复审 B2-C1 的后半：上一版把超容量的帧**夹到桶容量**（按 10 计一次）
  // 再放行 —— 第十一只往后每一只都免费，而它们各起一条真花钱的 turn。
  // 拒绝，并且把上限说出口：这不是"等一会儿"能解决的事
  it("超过 turn 桶容量 → 拒绝而不是夹价，turn 桶一次都不问、话一个字节都没落", async () => {
    const sayCalls: unknown[] = [];
    const allowCalls: unknown[] = [];
    const { deps, sent, logs } = makeDeps({
      getSession: () => budgetedSession((a) => sayCalls.push(a)),
      rateLimit: { allow: (...args) => { allowCalls.push(args); return true; } },
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    allowCalls.length = 0;
    logs.length = 0;

    const many = Array.from({ length: TURN_BUCKET.capacity + 1 }, (_, i) => `a${i}`);
    await handler.onSessionFrame(
      "w1", "s1", "c1",
      encodeCs({ t: "say", text: many.map((m) => `@${m}`).join(" "), mention: true })
    );

    // #968：粗闸的 say 令牌仍然照付一次（先于 requireStillMember、先于知道
    // 点了几个名），超容量的判断在 budget 内部、turn 桶一次都没问
    expect(allowCalls).toEqual([["say", "u1"]]);
    expect(sayCalls).toHaveLength(0);
    expect(logs).toEqual([]);
    expect(sent).toHaveLength(1);
    const msg = sent[0]!.msg as { t: string; ok: boolean; message: string };
    expect(msg.t).toBe("say_result");
    expect(msg.ok).toBe(false);
    expect(msg.message).toContain(`最多 @ ${TURN_BUCKET.capacity} 只`);
    expect(msg.message).toContain(String(TURN_BUCKET.capacity + 1)); // 这条 @ 了几只也说出来
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

  // #968：say 的粗闸挪到 requireStillMember 之前——一个被限速的成员不该
  // 白打一次 Supabase 的 workspace_agents 查询（isMember 那 60s TTL 缓存
  // 是有代价的一次网络往返，粗闸只是内存里的令牌桶，比它更便宜也该更早）。
  // 这与「被踢的人拿到的是『你不在这了』不是『慢一点』」那条旧纪律不冲突：
  // 那条纪律管的是"两种拒绝理由都命中时该说哪一句"，而这里限速在先，
  // 会员资格从头到尾没被问起——不是"两句话选一句"，是"压根没问第二句"
  it("say 先过限速粗闸再查名单（#968）—— allow 全假时不落盘、不再多打一次 isMember", async () => {
    const sayCalls: unknown[] = [];
    let isMemberCallsAfterHello = 0;
    let helloSettled = false;
    const { deps, sent } = makeDeps({
      isMember: async () => {
        if (helloSettled) isMemberCallsAfterHello += 1;
        return true;
      },
      getSession: () => budgetedSession((a) => sayCalls.push(a)),
      rateLimit: { allow: () => false }, // say 桶也拒——粗闸这一步就该拦住
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    helloSettled = true; // hello 本身那次 isMember 不算数，只数它之后的
    sent.length = 0;

    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "x", mention: false }));

    expect(sayCalls).toHaveLength(0);
    expect(isMemberCallsAfterHello).toBe(0); // requireStillMember 根本没被走到
    expect(sent).toEqual([{ cid: "c1", msg: { t: "say_result", ok: false, message: throttleMessage("say") } }]);
  });

  it("say 粗闸放行、但会员资格没了 → 仍然回「你不在这了」，不是限速话术", async () => {
    let member = true;
    const { deps, sent } = makeDeps({
      isMember: async () => member,
      rateLimit: { allow: () => true }, // 粗闸放行，走到 requireStillMember
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    member = false; // hello 之后被踢出团队
    sent.length = 0;

    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "x", mention: false }));
    // 说的是"你不在这了"（回执 + denied 两条都在讲同一件事），不是"慢一点"
    expect(sent.map((s) => s.msg.t)).toEqual(["say_result", "denied"]);
    expect(sent[0]!.msg).toMatchObject({ ok: false, message: expect.stringContaining("不在这个团队") });
    expect(sent[1]!.msg).toEqual({ t: "denied", code: "not_authorized" });
  });
});

// issue #822 的判据（owner 或建这条会话的人）原样；协议 9（#993）把 archive
// 搬进**控制房**——归档一条会话不该以「你此刻正开着它」为前提，界面上那颗钮
// 因此才能待在侧栏那条会话行的 ⋮ 里。控制房没有会话房那条 session_archived
// 广播可当回执，所以成功也回一条 archive_result。
describe("归档（issue #822 / 协议 9 #993）", () => {
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
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onCtlFrame("c1", encodeCs({ t: "archive", workspaceId: "w1", sessionId: "s1" }));

    expect(calls).toEqual([["w1", "s1", "Label(u1)"]]);
    // 控制房没有房间可广播（房里的人照旧收得到 session_archived，那是**他们**的
    // 回执）——按钮这一侧得单独有一条
    expect(sent).toEqual([{ cid: "c1", msg: { t: "archive_result", workspaceId: "w1", sessionId: "s1", ok: true } }]);
  });

  it("建这条会话的人也可以归档（不是只有 owner）", async () => {
    const calls: unknown[] = [];
    const { deps } = makeDeps({
      getSession: () => sessionOf("u1"),
      ownerOf: async () => "someone-else",
      archiveSession: async (...args) => { calls.push(args); return true; },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    await handler.onCtlFrame("c1", encodeCs({ t: "archive", workspaceId: "w1", sessionId: "s1" }));
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
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onCtlFrame("c1", encodeCs({ t: "archive", workspaceId: "w1", sessionId: "s1" }));

    expect(calls).toEqual([]);
    expect(sent).toEqual([{ cid: "c1", msg: { t: "denied", code: "not_authorized" } }]);
  });

  it("已经归档过了 → archive_result ok:false 带人话，不假装成功", async () => {
    const { deps, sent } = makeDeps({
      getSession: () => sessionOf("u1"),
      ownerOf: async () => "u1",
      archiveSession: async () => false,
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onCtlFrame("c1", encodeCs({ t: "archive", workspaceId: "w1", sessionId: "s1" }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg).toMatchObject({ t: "archive_result", ok: false });
  });

  it("被踢出团队的人归档不了 —— 在籍判断在权限判断之前（控制房的 isMember 那道闸）", async () => {
    let member = true;
    const calls: unknown[] = [];
    const { deps, sent } = makeDeps({
      isMember: async () => member,
      getSession: () => sessionOf("u1"),
      ownerOf: async () => "u1",
      archiveSession: async (...args) => { calls.push(args); return true; },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    member = false;
    sent.length = 0;
    await handler.onCtlFrame("c1", encodeCs({ t: "archive", workspaceId: "w1", sessionId: "s1" }));
    expect(calls).toEqual([]);
    expect(sent).toEqual([{ cid: "c1", msg: { t: "denied", code: "not_member" } }]);
  });
});


// 协议 9（#993）：会话房里出现 archive 视为越权（同 create / config / workspace）
describe("会话房拒 archive（协议 9）", () => {
  it("会话房里发 archive → denied not_authorized，一个字都没归档", async () => {
    const calls: unknown[] = [];
    const { deps, sent } = makeDeps({
      getSession: () => fakeSession({ createdByUid: () => "u1" }),
      ownerOf: async () => "u1",
      archiveSession: async (...args) => { calls.push(args); return true; },
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "archive", workspaceId: "w1", sessionId: "s1" }));
    expect(calls).toEqual([]);
    expect(sent).toEqual([{ cid: "c1", msg: { t: "denied", code: "not_authorized" } }]);
  });

  it("会话不存在（已归档过 / 房间没开）→ archive_result ok:false，不是 denied", async () => {
    const { deps, sent } = makeDeps({ getSession: () => null, ownerOf: async () => "u1" });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onCtlFrame("c1", encodeCs({ t: "archive", workspaceId: "w1", sessionId: "gone" }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg).toMatchObject({ t: "archive_result", ok: false });
  });
});

// 协议 10（#1044）：彻底删除一条云会话。判据与归档逐字相同（owner 或建的人），
// 但它答得出**归档掉的会话**——`get()` 只认活着的房间，而归档的那批恰恰是最常
// 被删的。三种失败分开说：不存在 / 这一刻读不到 / 删库没成，尤其是第二种不许
// 说成第一种（ADR-0243 那条纪律：读不到 ≠ 没有）。
describe("删除（协议 10，#1044）", () => {
  it("owner 可以删 → 调到 sessions.remove，回 delete_result ok:true", async () => {
    const calls: unknown[] = [];
    const { deps, sent } = makeDeps({
      creatorOf: async () => "someone-else",
      ownerOf: async () => "u1",
      removeSession: async (...args) => { calls.push(args); return true; },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onCtlFrame("c1", encodeCs({ t: "delete", workspaceId: "w1", sessionId: "s1" }));

    expect(calls).toEqual([["w1", "s1", "Label(u1)"]]);
    expect(sent).toEqual([{ cid: "c1", msg: { t: "delete_result", workspaceId: "w1", sessionId: "s1", ok: true } }]);
  });

  it("建这条会话的人也可以删（不是只有 owner）", async () => {
    const calls: unknown[] = [];
    const { deps } = makeDeps({
      creatorOf: async () => "u1",
      ownerOf: async () => "someone-else",
      removeSession: async (...args) => { calls.push(args); return true; },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    await handler.onCtlFrame("c1", encodeCs({ t: "delete", workspaceId: "w1", sessionId: "s1" }));
    expect(calls).toHaveLength(1);
  });

  it("既不是 owner 也不是建的人 → not_authorized，一个字都没删", async () => {
    const calls: unknown[] = [];
    const { deps, sent } = makeDeps({
      creatorOf: async () => "someone-else",
      ownerOf: async () => "another-one",
      removeSession: async (...args) => { calls.push(args); return true; },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onCtlFrame("c1", encodeCs({ t: "delete", workspaceId: "w1", sessionId: "s1" }));

    expect(calls).toEqual([]);
    expect(sent).toEqual([{ cid: "c1", msg: { t: "denied", code: "not_authorized" } }]);
  });

  // 这条是这次修改的**要点**：归档掉的会话没有房间，`sessions.get()` 一律回 null，
  // 但它照样删得动——判据取的是台账那行的 publisher_uid，不是活着的房间
  it("归档掉的会话（房间早收了）照样删得动", async () => {
    const calls: unknown[] = [];
    const { deps, sent } = makeDeps({
      getSession: () => null,
      creatorOf: async () => "u1",
      ownerOf: async () => "u1",
      removeSession: async (...args) => { calls.push(args); return true; },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onCtlFrame("c1", encodeCs({ t: "delete", workspaceId: "w1", sessionId: "s-archived" }));

    expect(calls).toEqual([["w1", "s-archived", "Label(u1)"]]);
    expect(sent[0]!.msg).toMatchObject({ t: "delete_result", ok: true });
  });

  it("这个团队里没有这条会话 → delete_result ok:false，不是 denied，也不调 remove", async () => {
    const calls: unknown[] = [];
    const { deps, sent } = makeDeps({
      creatorOf: async () => null,
      ownerOf: async () => "u1",
      removeSession: async (...args) => { calls.push(args); return true; },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onCtlFrame("c1", encodeCs({ t: "delete", workspaceId: "w1", sessionId: "gone" }));

    expect(calls).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg).toMatchObject({ t: "delete_result", ok: false });
  });

  // ADR-0243 那条纪律的又一处：查询挂了 ≠ 这条会话不存在。说成后者的话，人会
  // 以为已经删掉了，转头去别处找它——而它还好好地在那儿
  it("查 owner 这一步挂了也一样有回执（两次查询一起收错，不让人白等 ACK 超时）", async () => {
    const calls: unknown[] = [];
    const { deps, sent } = makeDeps({
      creatorOf: async () => "u1",
      ownerOf: async () => { throw new Error("supabase 挂了"); },
      removeSession: async (...args) => { calls.push(args); return true; },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onCtlFrame("c1", encodeCs({ t: "delete", workspaceId: "w1", sessionId: "s1" }));

    expect(calls).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg).toMatchObject({ t: "delete_result", ok: false });
  });

  it("查会话这一步挂了 → 说「读不到」，绝不说「不存在」，也不删", async () => {
    const calls: unknown[] = [];
    const { deps, sent, logs } = makeDeps({
      creatorOf: async () => { throw new Error("supabase 挂了"); },
      ownerOf: async () => "u1",
      removeSession: async (...args) => { calls.push(args); return true; },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onCtlFrame("c1", encodeCs({ t: "delete", workspaceId: "w1", sessionId: "s1" }));

    expect(calls).toEqual([]);
    expect(sent).toHaveLength(1);
    const msg = sent[0]!.msg as { t: string; ok: boolean; message: string };
    expect(msg.t).toBe("delete_result");
    expect(msg.ok).toBe(false);
    expect(msg.message).toContain("读不到");
    expect(msg.message).not.toContain("不存在");
    expect(logs.join("\n")).toContain("delete 查会话失败");
  });

  it("删库那一步没成 → delete_result ok:false 带人话，不假装删掉了", async () => {
    const { deps, sent } = makeDeps({
      creatorOf: async () => "u1",
      ownerOf: async () => "u1",
      removeSession: async () => false,
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onCtlFrame("c1", encodeCs({ t: "delete", workspaceId: "w1", sessionId: "s1" }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg).toMatchObject({ t: "delete_result", ok: false });
  });

  it("被踢出团队的人删不了 —— 在籍判断在权限判断之前", async () => {
    let member = true;
    const calls: unknown[] = [];
    const { deps, sent } = makeDeps({
      isMember: async () => member,
      creatorOf: async () => "u1",
      ownerOf: async () => "u1",
      removeSession: async (...args) => { calls.push(args); return true; },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    member = false;
    sent.length = 0;
    await handler.onCtlFrame("c1", encodeCs({ t: "delete", workspaceId: "w1", sessionId: "s1" }));
    expect(calls).toEqual([]);
    expect(sent).toEqual([{ cid: "c1", msg: { t: "denied", code: "not_member" } }]);
  });

  it("会话房里发 delete → denied not_authorized，一个字都没删（同 create/config/archive）", async () => {
    const calls: unknown[] = [];
    const { deps, sent } = makeDeps({
      creatorOf: async () => "u1",
      ownerOf: async () => "u1",
      removeSession: async (...args) => { calls.push(args); return true; },
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "delete", workspaceId: "w1", sessionId: "s1" }));
    expect(calls).toEqual([]);
    expect(sent).toEqual([{ cid: "c1", msg: { t: "denied", code: "not_authorized" } }]);
  });
});

// 协议 14（#1102）：config 帧整条走了。会话房那条越权用例改盯别的控制房专用帧
// ——判据没变（控制房专用帧出现在会话房 = not_authorized），只是 config 不再是
// 其中之一。create / workspace / archive / delete / files 这几条各自的用例都在上面

// issue #915：真机上「新建云会话」一律回 not_authorized，而发起者是团队所有者。
//
// 病因是**顺序**不是权限：桌面的 create() 在同一个 tick 里连发 hello + create，
// 而 daemon 的接线是「来一帧起一个 promise」。hello 那条要 await 验签**再** await
// labelOf（真机上是一次 Supabase 往返），create 在这个窗口里被处理时 cids 还是空的，
// 于是落进「第一帧不是 hello」那条分支。
//
// 这些用例**必须不 await 第一条**——await 了就把竞态本身抹掉了，测的就成了另一件事。
describe("按 cid 串行（#915）", () => {
  /** 让 labelOf 慢下来并且可控：真机上它是网络调用，这里用一个手动放行的 promise
      精确复现「hello 还卡在 labelOf 里，create 就到了」那一刻 */
  function slowLabel() {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    return { gate, release, labelOf: async (uid: string) => { await gate; return `Label(${uid})`; } };
  }

  it("hello 还没登记完，create 就到了：不许回 not_authorized", async () => {
    const slow = slowLabel();
    const { deps, sent } = makeDeps({ labelOf: slow.labelOf });
    const handler = createFrameHandler(deps);

    // 关键：两条都不 await，就像桌面同一个 tick 连发那样
    const p1 = handler.onCtlFrame("cid-1", encodeCs({ t: "hello", v: CS_PROTOCOL_VERSION, jwt: "jwt:u1" }));
    const p2 = handler.onCtlFrame("cid-1", encodeCs({ t: "create", workspaceId: "ws-1" }));

    slow.release();
    await Promise.all([p1, p2]);

    expect(sent.map((x) => x.msg.t)).not.toContain("denied");
    expect(sent.map((x) => x.msg.t)).toContain("created");
  });

  it("同一条 cid 上的帧按到达顺序处理", async () => {
    const order: string[] = [];
    const slow = slowLabel();
    const { deps } = makeDeps({
      labelOf: async (uid) => { order.push("hello:labelOf"); return slow.labelOf(uid); },
      createSession: async () => { order.push("create"); return { sessionId: "s1" }; },
    });
    const handler = createFrameHandler(deps);

    const p1 = handler.onCtlFrame("cid-1", encodeCs({ t: "hello", v: CS_PROTOCOL_VERSION, jwt: "jwt:u1" }));
    const p2 = handler.onCtlFrame("cid-1", encodeCs({ t: "create", workspaceId: "ws-1" }));
    slow.release();
    await Promise.all([p1, p2]);

    expect(order).toEqual(["hello:labelOf", "create"]);
  });

  it("前一条抛了，后面的帧照样处理（一次抖动不该把这条连接永久卡死）", async () => {
    let first = true;
    const { deps, sent } = makeDeps({
      labelOf: async (uid) => {
        if (first) { first = false; throw new Error("Supabase 抖了一下"); }
        return `Label(${uid})`;
      },
    });
    const handler = createFrameHandler(deps);

    await handler.onCtlFrame("cid-1", encodeCs({ t: "hello", v: CS_PROTOCOL_VERSION, jwt: "jwt:u1" }))
      .catch(() => { /* 这一条本来就该抛 */ });
    // 同一条 cid 再来一轮，应该照常走通
    await handler.onCtlFrame("cid-1", encodeCs({ t: "hello", v: CS_PROTOCOL_VERSION, jwt: "jwt:u1" }));
    await handler.onCtlFrame("cid-1", encodeCs({ t: "create", workspaceId: "ws-1" }));

    expect(sent.map((x) => x.msg.t)).toContain("created");
  });

  it("不同 cid 之间不互相阻塞（串行粒度是 cid，不是全局）", async () => {
    const slow = slowLabel();
    const { deps, sent } = makeDeps({
      labelOf: async (uid) => (uid === "slow" ? slow.labelOf(uid) : `Label(${uid})`),
    });
    const handler = createFrameHandler(deps);

    // cid-slow 卡在 labelOf 里
    const stuck = handler.onCtlFrame("cid-slow", encodeCs({ t: "hello", v: CS_PROTOCOL_VERSION, jwt: "jwt:slow" }));
    // cid-fast 不该被它拖住
    await handler.onCtlFrame("cid-fast", encodeCs({ t: "hello", v: CS_PROTOCOL_VERSION, jwt: "jwt:fast" }));
    await handler.onCtlFrame("cid-fast", encodeCs({ t: "create", workspaceId: "ws-1" }));
    expect(sent.some((x) => x.cid === "cid-fast" && x.msg.t === "created")).toBe(true);

    slow.release();
    await stuck;
  });

  it("拒绝会记一笔（#915：真机那次拒绝，日志里一个字都没有）", async () => {
    const { deps, logs } = makeDeps({});
    const handler = createFrameHandler(deps);
    // 第一帧不是 hello = 未验籍
    await handler.onCtlFrame("cid-1", encodeCs({ t: "create", workspaceId: "ws-1" }));
    expect(logs.join("\n")).toContain("not_authorized");
    expect(logs.join("\n")).toContain("cid-1");
  });
});

// #957 A-2：停止一轮 turn 的帧接线。这一层不判"谁能停"（那条判据在
// CloudSession.stop 里，与审批共用 router.canDecide）——它只负责把三态翻成
// 三条 stop_result，并把两种失败各记一笔。
describe("停止一轮 turn（#957 A-2）", () => {
  const stopFrame = encodeCs({ t: "stop" });

  it("三种结果各一条 stop_result：ok 静默成功、idle 与 not_allowed 带文案且各记一笔日志", async () => {
    const outcomes: ("ok" | "idle" | "not_allowed")[] = ["ok", "idle", "not_allowed"];
    let i = 0;
    const stopCalls: unknown[] = [];
    const session = fakeSession({
      stop: (...args) => {
        stopCalls.push(args);
        return outcomes[i++]!;
      },
    });
    const { deps, sent, logs } = makeDeps({ getSession: () => session });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;

    await handler.onSessionFrame("w1", "s1", "c1", stopFrame);
    expect(sent.map((s) => s.msg)).toEqual([{ t: "stop_result", ok: true }]);
    expect(logs).toHaveLength(0); // 成功不记：日志是失败出口
    // uid/label 原样递下去：群里那句「谁停的」用的是这个 label。
    // 第三格是 seq：这一帧没带，透传 undefined = 旧语义（停当前那一轮）
    expect(stopCalls).toEqual([["u1", "Label(u1)", undefined]]);

    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", stopFrame);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg).toEqual({ t: "stop_result", ok: false, message: "此刻没有正在跑的 turn" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("idle");
    expect(logs[0]).toContain("u1");

    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", stopFrame);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg).toEqual({ t: "stop_result", ok: false, message: "只有发起人或 owner 能停" });
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain("not_allowed");
  });

  // 复审 C2-I3：桌面按**行**画停止按钮，帧里那个 seq 就是"我按的是哪一行"。
  // 这一层不判它——判据（与采样边界比）在 CloudSession.stop 里，这里只保证
  // 它一路透传下去；丢了的话服务端拿不到任何 turn 标识，又退回"停当前那轮"
  it("stop 帧带的 seq 原样透传到 CloudSession.stop 第三格", async () => {
    const stopCalls: unknown[] = [];
    const session = fakeSession({ stop: (...args) => { stopCalls.push(args); return "ok"; } });
    const { deps, sent } = makeDeps({ getSession: () => session });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "stop", seq: 12 }));

    expect(stopCalls).toEqual([["u1", "Label(u1)", 12]]);
    expect(sent.map((s) => s.msg)).toEqual([{ t: "stop_result", ok: true }]);
  });

  // 三种失败要分开说：这一条不是"没权限"也不是"没得停"，而是"你点的那一行
  // 还没轮到"——说成前两句里的任何一句，人都会以为按钮坏了然后按住不放
  it("not_current → 单独一句文案（不是 idle 也不是 not_allowed）且记一笔", async () => {
    const session = fakeSession({ stop: () => "not_current" });
    const { deps, sent, logs } = makeDeps({ getSession: () => session });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "stop", seq: 99 }));

    expect(sent[0]!.msg).toEqual({
      t: "stop_result",
      ok: false,
      message: "这一行的那句话还在排队，此刻在跑的是更早那一轮",
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("not_current");
  });

  it("被踢的人按停止：回执排在 denied 之前（deny 顺手 dropCid，之后 send 全是静默丢帧）", async () => {
    let member = true;
    const stopCalls: unknown[] = [];
    const session = fakeSession({ stop: (...args) => { stopCalls.push(args); return "ok"; } });
    const { deps, sent, dropCidCalls } = makeDeps({ isMember: async () => member, getSession: () => session });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    member = false;
    sent.length = 0;

    await handler.onSessionFrame("w1", "s1", "c1", stopFrame);
    expect(sent.map((s) => s.msg.t)).toEqual(["stop_result", "denied"]);
    expect(sent[0]!.msg).toMatchObject({ ok: false });
    expect(stopCalls).toHaveLength(0); // 没落到 CloudSession.stop
    expect(dropCidCalls).toEqual(["c1"]);
  });

  it("stop 也过令牌桶（复审 Minor）：超速回 stop_result{ok:false} 且不落到 CloudSession.stop", async () => {
    const stopCalls: unknown[] = [];
    const session = fakeSession({ stop: (...args) => { stopCalls.push(args); return "ok"; } });
    const buckets: string[] = [];
    const { deps, sent } = makeDeps({
      getSession: () => session,
      rateLimit: { allow: (kind) => { buckets.push(kind); return kind !== "stop"; } },
    });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    buckets.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", stopFrame);

    // 记的是 stop 桶不是 say 桶（记错桶 = 停止键跟着发言一起被限）
    expect(buckets).toEqual(["stop"]);
    expect(stopCalls).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg).toMatchObject({ t: "stop_result", ok: false });
    // 说的是"按得太快"不是"停不下来"——后者会让人以为那一轮还在跑
    expect((sent[0]!.msg as { message: string }).message).toBe(throttleMessage("stop"));
  });

  it("被踢的人按停止：在籍复查排在限流之前 —— 拿到的是「你不在这了」不是「慢一点」", async () => {
    let member = true;
    const { deps, sent } = makeDeps({
      isMember: async () => member,
      rateLimit: { allow: () => false }, // 四档全空，但它不该是第一个说话的
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    member = false;
    sent.length = 0;

    await handler.onSessionFrame("w1", "s1", "c1", stopFrame);
    expect(sent.map((s) => s.msg.t)).toEqual(["stop_result", "denied"]);
    expect((sent[0]!.msg as { message: string }).message).toContain("不在这个团队");
  });

  it("未过 hello 就发 stop → denied not_authorized，不落到 CloudSession.stop", async () => {
    const stopCalls: unknown[] = [];
    const session = fakeSession({ stop: (...args) => { stopCalls.push(args); return "ok"; } });
    const { deps, sent } = makeDeps({ getSession: () => session });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "cX", stopFrame);

    expect(sent).toEqual([{ cid: "cX", msg: { t: "denied", code: "not_authorized" } }]);
    expect(stopCalls).toHaveLength(0);
  });
});

// #964：say 的回执。桌面 composer 的「草稿在发送成功之后才清」此前等的是一个
// 不存在的信号——服务端对 say 从来不回话，成功与失败在客户端看来完全一样。
describe("say 回执（#964）", () => {
  it("say() resolve → say_result{ok:true}（ok = 收下了，不是跑完了）", async () => {
    const session = fakeSession({ say: async () => {} });
    const { deps, sent } = makeDeps({ getSession: () => session });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "干活", mention: true }));

    expect(sent.map((s) => s.msg)).toEqual([{ t: "say_result", ok: true }]);
  });

  it("say() 抛错 → say_result{ok:false, 固定人话} + 原文只进日志（原来只冒到 daemon 的 .catch，发言人那侧彻底沉默）", async () => {
    const session = fakeSession({
      say: async () => {
        throw new Error("workspace_agents 查询失败");
      },
    });
    const { deps, sent, logs } = makeDeps({ getSession: () => session });
    const handler = createFrameHandler(deps);

    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "say", text: "干活", mention: true }));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg).toMatchObject({ t: "say_result", ok: false });
    // **原文不出门**（#957 终审 M4）：这条 catch 罩着的是内部异常，措辞是说给
    // 维护者听的（表名、uid、栈信息），照搬给用户既看不懂也没有下一步动作。
    // 客户端拿固定的一句人话，原文只在 deps.log 里
    expect((sent[0]!.msg as { message: string }).message).toBe("发送失败，请重试");
    expect((sent[0]!.msg as { message: string }).message).not.toContain("workspace_agents");
    expect(logs.join("\n")).toContain("workspace_agents 查询失败");
  });
});

describe("files 读帧（协议 11，#1056）", () => {
  it("任何在籍成员都读得到；不在籍 → denied not_member", async () => {
    const calls: [string, string][] = [];
    const { deps, sent } = makeDeps({
      isMember: async (w) => w === "w-ok",
      readWork: async (w, path) => {
        calls.push([w, path]);
        return { kind: "dir", entries: [{ name: "菜单.md", kind: "file", size: 12, mtimeMs: 1 }], truncated: false };
      },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));

    await handler.onCtlFrame("c1", encodeCs({ t: "files", workspaceId: "w-bad", path: "" }));
    expect(sent.at(-1)).toEqual({ cid: "c1", msg: { t: "denied", code: "not_member" } });
    expect(calls).toEqual([]);

    await handler.onCtlFrame("c1", encodeCs({ t: "files", workspaceId: "w-ok", path: "src" }));
    expect(calls).toEqual([["w-ok", "src"]]);
    expect(sent.at(-1)).toEqual({
      cid: "c1",
      msg: {
        t: "files_result",
        workspaceId: "w-ok",
        path: "src",
        ok: true,
        node: { kind: "dir", entries: [{ name: "菜单.md", kind: "file", size: 12, mtimeMs: 1 }], truncated: false },
      },
    });
  });

  it("服务端自己再归一化一次——客户端那次只是省往返，不是安全边界", async () => {
    const calls: string[] = [];
    const { deps, sent } = makeDeps({
      readWork: async (_w, path) => {
        calls.push(path);
        return { kind: "missing" };
      },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));

    // `..` 手工发过来（渲染层永远不会发，主进程也拦过一次）——这一层照样拦
    await handler.onCtlFrame("c1", encodeCs({ t: "files", workspaceId: "w1", path: "../../etc" }));
    expect(calls).toEqual([]);
    expect(sent.at(-1)!.msg).toEqual({ t: "files_result", workspaceId: "w1", path: "../../etc", ok: false, message: "这条路径不合法。" });

    // 合法但写法脏的照过，且**回执带的是归一化之后那条**（客户端拿它当当前位置）
    await handler.onCtlFrame("c1", encodeCs({ t: "files", workspaceId: "w1", path: "a//b/./" }));
    expect(calls).toEqual(["a/b"]);
    expect(sent.at(-1)!.msg).toMatchObject({ t: "files_result", path: "a/b", ok: true });
  });

  it("读挂了 → 说「读不到」，绝不回一个空目录", async () => {
    // 「这一刻读不到」说成「里面是空的」会让人以为水獭什么都没做出来（同 ADR-0243）
    const { deps, sent, logs } = makeDeps({
      readWork: async () => {
        throw new Error("docker exec 失败：容器不见了");
      },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;

    await handler.onCtlFrame("c1", encodeCs({ t: "files", workspaceId: "w1", path: "" }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg).toEqual({ t: "files_result", workspaceId: "w1", path: "", ok: false, message: "这一刻读不到工作文件夹。稍后再试。" });
    // 原文只进日志（同 say 那条的纪律）
    expect((sent[0]!.msg as { message: string }).message).not.toContain("docker");
    expect(logs.join("\n")).toContain("docker exec 失败");
  });

  it("超速 → denied rate_limited，且不下到容器", async () => {
    // 这是唯一一条会 docker exec 进容器的读帧，没有闸就是「点得够快就能一直起 exec」
    const calls: string[] = [];
    const { deps, sent } = makeDeps({
      rateLimit: { allow: (kind) => kind !== "files" },
      readWork: async (_w, path) => {
        calls.push(path);
        return { kind: "absent" };
      },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));

    await handler.onCtlFrame("c1", encodeCs({ t: "files", workspaceId: "w1", path: "" }));
    expect(sent.at(-1)).toEqual({ cid: "c1", msg: { t: "denied", code: "rate_limited" } });
    expect(calls).toEqual([]);
  });

  it("会话房里发 files → denied not_authorized（控制房专用帧，同 create/workspace）", async () => {
    const calls: string[] = [];
    const { deps, sent } = makeDeps({
      readWork: async (_w, path) => {
        calls.push(path);
        return { kind: "absent" };
      },
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;

    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "files", workspaceId: "w1", path: "" }));
    expect(sent.at(-1)!.msg).toEqual({ t: "denied", code: "not_authorized" });
    expect(calls).toEqual([]);
  });
});

describe("files_search 读帧（协议 12，#1066）", () => {
  it("查询被 trim 之后递给 searchWork；回执带原样的 query", async () => {
    const calls: [string, string, boolean][] = [];
    const { deps, sent } = makeDeps({
      searchWork: async (w, q, c) => {
        calls.push([w, q, c]);
        return [{ rel: "a.md", line: 3, text: "hello" }];
      },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));

    await handler.onCtlFrame("c1", encodeCs({ t: "files_search", workspaceId: "w1", query: " hello ", content: true }));
    expect(calls).toEqual([["w1", "hello", true]]);
    expect(sent.at(-1)!.msg).toEqual({
      t: "files_search_result", workspaceId: "w1", query: " hello ", ok: true,
      hits: [{ rel: "a.md", line: 3, text: "hello" }],
    });
  });

  it("空查询不下到容器——`rg --files` 会把整个仓库跑一遍，而调用方要的是「回到树」", async () => {
    const calls: string[] = [];
    const { deps, sent } = makeDeps({
      searchWork: async (_w, q) => {
        calls.push(q);
        return [];
      },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));

    await handler.onCtlFrame("c1", encodeCs({ t: "files_search", workspaceId: "w1", query: "   ", content: false }));
    expect(calls).toEqual([]);
    expect(sent.at(-1)!.msg).toMatchObject({ t: "files_search_result", ok: true, hits: [] });
  });

  it("搜挂了 → ok:false，**绝不回一个空 hits**", async () => {
    // 「搜不成」说成「没有匹配」会让人以为仓里真的没有这个东西
    const { deps, sent, logs } = makeDeps({
      searchWork: async () => {
        throw new Error("云端沙箱里没有 ripgrep，搜不了。");
      },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;

    await handler.onCtlFrame("c1", encodeCs({ t: "files_search", workspaceId: "w1", query: "x", content: false }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg).toMatchObject({ t: "files_search_result", ok: false });
    expect((sent[0]!.msg as { hits?: unknown }).hits).toBeUndefined();
    expect(logs.join("\n")).toContain("ripgrep");
  });

  it("与 files 共用同一只桶（同一个动作的两半，花的也是同一样东西）", async () => {
    const calls: string[] = [];
    const { deps, sent } = makeDeps({
      rateLimit: { allow: (kind) => kind !== "files" },
      searchWork: async (_w, q) => {
        calls.push(q);
        return [];
      },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));

    await handler.onCtlFrame("c1", encodeCs({ t: "files_search", workspaceId: "w1", query: "x", content: false }));
    expect(sent.at(-1)).toEqual({ cid: "c1", msg: { t: "denied", code: "rate_limited" } });
    expect(calls).toEqual([]);
  });

  it("会话房里发 files_search → denied not_authorized", async () => {
    const { deps, sent } = makeDeps();
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;

    await handler.onSessionFrame("w1", "s1", "c1", encodeCs({ t: "files_search", workspaceId: "w1", query: "x", content: false }));
    expect(sent.at(-1)!.msg).toEqual({ t: "denied", code: "not_authorized" });
  });
});

// ── Git 凭据（协议 15，#1103）──────────────────────────────────────────────
// 三条判据各盯一处：**谁能写**（owner，服务端判，不信客户端）、**写什么**（主机名
// 服务端自己再校验一次——渲染层不是安全边界）、**回执带清单**（省掉「我存完了但
// 列表还是旧的」那种自相矛盾的中间态）。
describe("git_credential（协议 15，#1103）", () => {
  const OWNER = "owner-uid";
  const put = (workspaceId: string, host: string, token: string) =>
    encodeCs({ t: "git_credential", workspaceId, host, token });

  it("非 owner → denied not_authorized，一个字都没落盘", async () => {
    const writes: unknown[] = [];
    const { deps, sent } = makeDeps({
      ownerOf: async () => OWNER,
      putGitCredential: (w, h, t, by) => { writes.push([w, h, t, by]); },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("cMember", hello(CS_PROTOCOL_VERSION, "jwt:member-uid"));
    sent.length = 0;

    await handler.onCtlFrame("cMember", put("w1", "github.com", "ghp_x"));

    expect(sent.at(-1)).toEqual({ cid: "cMember", msg: { t: "denied", code: "not_authorized" } });
    expect(writes).toEqual([]);
  });

  it("owner 存一把 → 落盘且回执带服务端此刻的清单；token 不在回执里", async () => {
    const writes: [string, string, string, string][] = [];
    const { deps, sent } = makeDeps({
      ownerOf: async () => OWNER,
      putGitCredential: (w, h, t, by) => { writes.push([w, h, t, by]); },
      gitHosts: () => [{ host: "github.com", addedBy: OWNER, addedAt: 111 }],
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, `jwt:${OWNER}`));
    sent.length = 0;

    await handler.onCtlFrame("c1", put("w1", "  GitHub.COM ", "ghp_secret"));

    // 主机名归一化之后才落盘——大小写/空白不该产生两条记录
    expect(writes).toEqual([["w1", "github.com", "ghp_secret", OWNER]]);
    const msg = sent.at(-1)!.msg as Record<string, unknown>;
    expect(msg).toMatchObject({ t: "git_credential_result", workspaceId: "w1", ok: true });
    expect(msg["gitHosts"]).toEqual([{ host: "github.com", addedBy: OWNER, addedAt: 111 }]);
    expect(JSON.stringify(msg)).not.toContain("ghp_secret");
  });

  it("token 为空串 = 删掉那台主机 —— 照样落到写入口，由它分派", async () => {
    const writes: [string, string, string, string][] = [];
    const { deps } = makeDeps({
      ownerOf: async () => OWNER,
      putGitCredential: (w, h, t, by) => { writes.push([w, h, t, by]); },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, `jwt:${OWNER}`));

    await handler.onCtlFrame("c1", put("w1", "github.com", ""));

    expect(writes).toEqual([["w1", "github.com", "", OWNER]]);
  });

  it("主机名服务端自己再校验一次 → 回 ok:false，一个字都没落盘", async () => {
    const writes: unknown[] = [];
    const { deps, sent } = makeDeps({
      ownerOf: async () => OWNER,
      putGitCredential: (w, h, t, by) => { writes.push([w, h, t, by]); },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, `jwt:${OWNER}`));
    sent.length = 0;

    // 渲染层拦得住这一条，但渲染层不是安全边界（同 validateRepoUrl 的理由）
    await handler.onCtlFrame("c1", put("w1", "https://x:ghp_leak@github.com/", "ghp_x"));

    expect(writes).toEqual([]);
    const msg = sent.at(-1)!.msg as Record<string, unknown>;
    expect(msg).toMatchObject({ t: "git_credential_result", ok: false });
    expect(JSON.stringify(msg)).not.toContain("ghp_leak");
  });

  it("落盘抛异常 → 回 ok:false 带原因，不假装存过了", async () => {
    const { deps, sent } = makeDeps({
      ownerOf: async () => OWNER,
      putGitCredential: () => { throw new Error("磁盘满了"); },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, `jwt:${OWNER}`));
    sent.length = 0;

    await handler.onCtlFrame("c1", put("w1", "github.com", "ghp_x"));

    expect(sent.at(-1)!.msg).toMatchObject({ t: "git_credential_result", ok: false, message: "保存失败：磁盘满了" });
  });

  it("读清单抛异常 → gitHosts 回 null（读不到），不是空数组（一台都没配）", async () => {
    const { deps, sent } = makeDeps({
      ownerOf: async () => OWNER,
      gitHosts: () => { throw new Error("文件读不了"); },
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("c1", hello(CS_PROTOCOL_VERSION, `jwt:${OWNER}`));
    sent.length = 0;

    await handler.onCtlFrame("c1", encodeCs({ t: "workspace", workspaceId: "w1" }));

    expect(sent.at(-1)!.msg).toMatchObject({ t: "workspace_state", gitHosts: null });
  });

  it("workspace 读帧对任何在籍成员都带清单 —— 有哪几台主机不是秘密，那把钥匙才是", async () => {
    const { deps, sent } = makeDeps({
      ownerOf: async () => OWNER,
      gitHosts: () => [{ host: "github.com", addedBy: OWNER, addedAt: 1 }],
    });
    const handler = createFrameHandler(deps);
    await handler.onCtlFrame("cMember", hello(CS_PROTOCOL_VERSION, "jwt:member-uid"));
    sent.length = 0;

    await handler.onCtlFrame("cMember", encodeCs({ t: "workspace", workspaceId: "w1" }));

    expect(sent.at(-1)!.msg).toMatchObject({
      t: "workspace_state",
      gitHosts: [{ host: "github.com", addedBy: OWNER, addedAt: 1 }],
    });
  });

  it("会话房里发 git_credential → denied not_authorized（控制房专用帧）", async () => {
    const writes: unknown[] = [];
    const { deps, sent } = makeDeps({
      ownerOf: async () => OWNER,
      putGitCredential: (w, h, t, by) => { writes.push([w, h, t, by]); },
    });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, `jwt:${OWNER}`));
    sent.length = 0;

    await handler.onSessionFrame("w1", "s1", "c1", put("w1", "github.com", "ghp_x"));

    expect(sent.at(-1)).toEqual({ cid: "c1", msg: { t: "denied", code: "not_authorized" } });
    expect(writes).toEqual([]);
  });
});

// #1163：语音通话名单的帧接线。这一层不判名单合不合法（那条判据在
// CloudSession.setVoiceCall 里，要现取 roster）——它只负责在籍复查、令牌桶、
// 把三态翻成 call_result，并把拒绝记一笔。
describe("语音通话名单（#1163）", () => {
  const callFrame = (participants: string[]) => encodeCs({ t: "call", participants });

  it("ok → call_result{ok:true}，uid/label/名单原样递下去，不记日志", async () => {
    const calls: unknown[] = [];
    const session = fakeSession({ setVoiceCall: async (...args) => { calls.push(args); return { kind: "ok" }; } });
    const { deps, sent, logs } = makeDeps({ getSession: () => session });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", callFrame(["admin", "a_1"]));
    expect(sent.map((s) => s.msg)).toEqual([{ t: "call_result", ok: true }]);
    expect(calls).toEqual([["u1", "Label(u1)", ["admin", "a_1"]]]);
    expect(logs).toHaveLength(0);
  });

  it("unknown_agent / archived → call_result{ok:false} 带服务端那句话，各记一笔", async () => {
    const outcomes = [
      { kind: "unknown_agent" as const, message: "有 1 个智能体不在名单里" },
      { kind: "archived" as const, message: "这条会话已经归档" },
    ];
    let i = 0;
    const session = fakeSession({ setVoiceCall: async () => outcomes[i++]! });
    const { deps, sent, logs } = makeDeps({ getSession: () => session });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", callFrame(["x"]));
    await handler.onSessionFrame("w1", "s1", "c1", callFrame(["x"]));
    expect(sent.map((s) => s.msg)).toEqual([
      { t: "call_result", ok: false, message: "有 1 个智能体不在名单里" },
      { t: "call_result", ok: false, message: "这条会话已经归档" },
    ]);
    expect(logs).toHaveLength(2);
  });

  it("不在籍了 → call_result 带那句「已不在这个团队」，不落到 setVoiceCall", async () => {
    let member = true;
    const calls: unknown[] = [];
    const session = fakeSession({ setVoiceCall: async (...args) => { calls.push(args); return { kind: "ok" }; } });
    const { deps, sent } = makeDeps({ getSession: () => session, isMember: async () => member });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    member = false;
    await handler.onSessionFrame("w1", "s1", "c1", callFrame(["admin"]));
    expect(calls).toHaveLength(0);
    expect(sent[0]!.msg).toMatchObject({ t: "call_result", ok: false });
  });

  it("桶：改名单太快 → call_result 带限速文案，不落到 setVoiceCall", async () => {
    const calls: unknown[] = [];
    const session = fakeSession({ setVoiceCall: async (...args) => { calls.push(args); return { kind: "ok" }; } });
    const { deps, sent } = makeDeps({ getSession: () => session, rateLimit: { allow: (kind) => kind !== "call" } });
    const handler = createFrameHandler(deps);
    await handler.onSessionFrame("w1", "s1", "c1", hello(CS_PROTOCOL_VERSION, "jwt:u1"));
    sent.length = 0;
    await handler.onSessionFrame("w1", "s1", "c1", callFrame(["admin"]));
    expect(calls).toHaveLength(0);
    expect(sent.map((s) => s.msg)).toEqual([{ t: "call_result", ok: false, message: throttleMessage("call") }]);
  });
});
