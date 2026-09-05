// services/runtime/checks/smokeAssembly.ts —— 冒烟脚本的真正断言全在这（由
// smoke.mjs 经 `npx tsx` 驱动，见该文件头注释）。不连真 relay/Supabase/Docker：
// 直接 createFrameHandler + 内存 send 收集 + 真 EventStore（tmpdir）+ 脚本化假
// adapter + 假 ExecutionWorld，验的是"这几块真代码接在一起能不能转"，不是每块
// 内部逻辑本身（那是 tests/ 下 vitest 的职责——daemon.ts 自己的注释也这么说：
// 装配本身"靠 T11 的冒烟 check 兜底，不进 vitest"）。
//
// 两个场景：
//   1. 主流程（task-11-brief.md Step 1）：hello → create → say(mention) →
//      event 帧序列含 assistant_message/turn_ended → backlog 返回全量。
//   2. 装配层韧性（T10 审查裁定新增）：喂一个"调用即抛错"的假依赖
//      （sessions.ownerOf）给会走到 daemon.ts 那条 fire-and-forget 路径的地方
//      （transport.onMessage 里的 `frameHandler.onSessionFrame(...).catch(...)`），
//      断言那个 .catch 接得住——一环炸了不该毒死进程，也不该让同一个
//      frameHandler 实例之后就报废。

import { randomUUID, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFrameHandler, type FrameHandlerDeps } from "../src/frameHandler.js";
import { createCloudSession, type CloudSession, type AgentSpec } from "../src/sessionService.js";
import { EventStore } from "../../../src/session/store.js";
import type { SessionEvent } from "../../../src/session/events.js";
import type { ModelAdapter } from "../../../src/model/adapter.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import { CS_PROTOCOL_VERSION, csChannel, encodeCs, type CsDown } from "../../../src/shared/remote/cloudSession.js";

// ── 断言收集（同 services/edge/checks/relay.mjs 的 check() 手法）───────────
const ok: string[] = [];
const bad: string[] = [];
function check(name: string, cond: boolean, extra = ""): void {
  (cond ? ok : bad).push(extra ? `${name} — ${extra}` : name);
}

// ── 自签 HS256 JWT（照 services/edge/checks/relay.mjs 的 token(sub) 写法）──
// secret 是脚本内常量：冒烟测的是装配不是密码学（不接真 Supabase/edge 的
// verifyJwt 实现），但既然反正要手写 HMAC，顺手也验一遍签名——比"不必真验签"
// 再退一步、完全不检查更贴近真实形状，成本几乎为零。
const JWT_SECRET = "otto-runtime-smoke-secret";
function b64json(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}
function signToken(sub: string): string {
  const h = b64json({ alg: "HS256", typ: "JWT" });
  const p = b64json({ sub, exp: Math.floor(Date.now() / 1000) + 120 });
  const sig = createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}
function verifyToken(jwt: string): { userId: string } | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url");
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as { sub?: unknown };
    return typeof payload.sub === "string" ? { userId: payload.sub } : null;
  } catch {
    return null;
  }
}

// ── 全局兜底：任何一处忘了 .catch 的 rejection 都在这落网 ───────────────────
// 呼应 daemon.ts 复审 Critical 那条纪律（unhandled rejection 不该终止进程）：
// 注册这个监听器本身也让 Node 不再对未捕获的 rejection 走默认的进程终止路径，
// 但我们不指望这一点当安全网——场景二会显式给每条调用挂 .catch，这里只是
// "万一漏了"的最后一道网,并把结果计进最终判据。
let unhandledRejectionSeen: unknown = null;
process.on("unhandledRejection", (err) => {
  unhandledRejectionSeen = err;
  console.error("[smoke] 捕获到未处理的 rejection（这本身就是一次装配层失败）：", err);
});

function isEventFrame(msg: CsDown): msg is Extract<CsDown, { t: "event" }> {
  return msg.t === "event";
}

async function scenarioMainFlow(): Promise<void> {
  const dbDir = mkdtempSync(join(tmpdir(), "otto-runtime-smoke-"));
  const store = new EventStore(join(dbDir, "smoke.db"));

  try {
    const operatorUid = randomUUID();
    const workspaceId = randomUUID();

    const sent: { cid: string; msg: CsDown }[] = [];
    // 已 welcome 的 cid——同 daemon.ts 的 roomRosters，简化成单会话一份
    // （daemon.ts 按 transport 实例索引是因为一个 runtime 要管多个会话房，
    // 这里只开一个会话，两者行为等价）
    const roster = new Set<string>();
    const activeSessions = new Map<string, { session: CloudSession; workspaceId: string }>();

    function send(cid: string, msg: CsDown): void {
      sent.push({ cid, msg });
      if (msg.t === "welcome") roster.add(cid);
    }

    const fakeAdapter: ModelAdapter = {
      model: "smoke-fake-model",
      async chat() {
        // 不返回 toolCalls：一步收口，loop() 立刻返回，runTurn 落 turn_ended
        return { content: "smoke ack：收到，已阅" };
      },
    };

    // 冒烟脚本只验装配转不转，不验多 agent 路由（那是 tests/runtime/
    // sessionService.test.ts 的职责）——单只占位 agent，adapterFor 原样
    // 回落 fakeAdapter，与这个场景改动前的单 adapter 行为等价（#928 task-9）
    const smokeAgent: AgentSpec = {
      agentId: "smoke", name: "smoke", description: "", instructions: "", models: [], tools: [],
    };

    const fakeWorld: ExecutionWorld = {
      fs: {
        async read() {
          throw new Error("smoke：不应被调用（本场景没有工具调用）");
        },
        async write() {
          throw new Error("smoke：不应被调用（本场景没有工具调用）");
        },
      },
      async exec() {
        throw new Error("smoke：不应被调用（本场景没有工具调用）");
      },
      http: {
        async postJson() {
          throw new Error("smoke：不应被调用（本场景没有工具调用）");
        },
      },
    };

    const deps: FrameHandlerDeps = {
      log: (m) => console.log(`[smoke] 帧：${m}`),
      verifyJwt: async (jwt) => verifyToken(jwt),
      isMember: async () => true,
      labelOf: async (uid) => `smoke-${uid.slice(0, 8)}`,
      sessions: {
        get(ws, sessionId) {
          const active = activeSessions.get(sessionId);
          return active && active.workspaceId === ws ? active.session : null;
        },
        async create(ws, byUid) {
          const sessionId = randomUUID();
          const session = createCloudSession({
            workspaceId: ws,
            sessionId,
            ownerUid: byUid,
            createdByUid: byUid,
            store,
            world: fakeWorld,
            agents: async () => [smokeAgent],
            adapterFor: () => fakeAdapter,
            px: { edgeBase: "http://127.0.0.1:0", runtimeSecret: "smoke-runtime-secret" },
            hostUids: async () => [], // 没有好友代理候选：fetchGrantedTools 空跑，零网络调用
            onEvent: (e) => {
              for (const cid of roster) send(cid, { t: "event", event: e });
            },
            onUsage: () => {},
          });
          activeSessions.set(sessionId, { session, workspaceId: ws });
          return { sessionId };
        },
        async archive() {
          return false;
        },
        async ownerOf() {
          return operatorUid;
        },
      },
      saveConfig: async () => {},
      repoState: () => null,
      modelState: () => null,
      rateLimit: { allow: () => true },
      send,
      dropCid: (cid) => {
        roster.delete(cid);
      },
    };

    const frameHandler = createFrameHandler(deps);

    // ── hello（控制房）────────────────────────────────────────────────
    const ctlCid = `ctl-${randomUUID()}`;
    await frameHandler.onCtlFrame(
      ctlCid,
      encodeCs({ t: "hello", v: CS_PROTOCOL_VERSION, jwt: signToken(operatorUid) })
    );
    check("控制房 hello 成功后静默（没有 welcome 概念），不发任何帧", sent.length === 0, `sent=${sent.length}`);

    // ── create ──────────────────────────────────────────────────────
    await frameHandler.onCtlFrame(ctlCid, encodeCs({ t: "create", workspaceId }));
    const createdEntry = sent.find((s) => s.msg.t === "created");
    check("create 收到 created 帧", createdEntry !== undefined);
    if (!createdEntry || createdEntry.msg.t !== "created") {
      throw new Error("装配失败：没收到 created 帧，无法继续后续场景");
    }
    const { sessionId, channel } = createdEntry.msg;
    check("created 帧 workspaceId 对得上", createdEntry.msg.workspaceId === workspaceId);
    check("created 帧 channel 与 csChannel() 一致", channel === csChannel(workspaceId, sessionId));

    // ── hello（会话房——另一条连接，因此是另一个 cid）───────────────────
    const sessionCid = `sess-${randomUUID()}`;
    sent.length = 0;
    await frameHandler.onSessionFrame(
      workspaceId,
      sessionId,
      sessionCid,
      encodeCs({ t: "hello", v: CS_PROTOCOL_VERSION, jwt: signToken(operatorUid) })
    );
    const welcomeEntry = sent.find((s) => s.msg.t === "welcome");
    check("会话房 hello 收到 welcome 帧", welcomeEntry !== undefined);
    if (welcomeEntry && welcomeEntry.msg.t === "welcome") {
      check("welcome.sessionId 对得上", welcomeEntry.msg.sessionId === sessionId);
      check("welcome.lastSeq 是全新会话的 -1", welcomeEntry.msg.lastSeq === -1, `lastSeq=${welcomeEntry.msg.lastSeq}`);
      check("welcome.initiatorUid 尚无人发言 = null", welcomeEntry.msg.initiatorUid === null);
      check("welcome.ownerUid 对得上", welcomeEntry.msg.ownerUid === operatorUid);
    }
    check("welcome 帧发出后，cid 进了广播名单（roster）", roster.has(sessionCid));

    // ── say（mention: true，点火一个 turn）─────────────────────────────
    sent.length = 0;
    await frameHandler.onSessionFrame(
      workspaceId,
      sessionId,
      sessionCid,
      encodeCs({ t: "say", text: "smoke says hi", mention: true })
    );
    // #937：say() 在开场白落盘 + 入队那一刻就 resolve，不等 turn 跑完（等就是
    // 死锁：frameHandler 按 cid 串行，发起人自己的 approve 帧排在 say 后面）。
    // 断言"turn 跑完了"的等待点因此改成 CloudSession.settled()——从
    // activeSessions 里拿到真会话本体（deps.sessions.get 只在 cid 世界里用）
    const liveSession = activeSessions.get(sessionId)?.session;
    if (!liveSession) throw new Error("装配失败：say 之后拿不到会话本体，无法等排空");
    await liveSession.settled();

    const eventFrames: SessionEvent[] = sent
      .map((s) => s.msg)
      .filter(isEventFrame)
      .map((m) => m.event);
    check(
      "say(mention) 触发一个 turn：event 帧序列以 user_message 开头（say() 收下就落的那一条，#932 坑 ②）",
      eventFrames[0]?.type === "user_message",
      `types=${eventFrames.map((e) => e.type).join(",")}`
    );
    check(
      "event 帧序列含 assistant_message",
      eventFrames.some((e) => e.type === "assistant_message"),
      `types=${eventFrames.map((e) => e.type).join(",")}`
    );
    check(
      "event 帧序列含 turn_ended（outcome: completed）",
      eventFrames.some((e) => e.type === "turn_ended" && e.outcome === "completed"),
      `types=${eventFrames.map((e) => e.type).join(",")}`
    );

    // ── backlog：afterSeq=-1 是"全量"游标 ───────────────────────────────
    // EventStore 的 seq 从 0 开始（store.ts 的 `COALESCE(MAX(seq)+1, 0)`），
    // loadRaw 的过滤条件是 `seq > afterSeq`——afterSeq 传 0 会漏掉 seq=0 那条
    // （off-by-one）。-1 才是"什么都没见过"的正确游标，与 CloudSession 自己
    // 给 lastSeqSeen 播种时用的哨兵值一致（sessionService.ts 的
    // `store.load(sessionId).at(-1)?.seq ?? -1`）。
    sent.length = 0;
    await frameHandler.onSessionFrame(
      workspaceId,
      sessionId,
      sessionCid,
      encodeCs({ t: "backlog", afterSeq: -1 })
    );
    const backlogEntry = sent.find((s) => s.msg.t === "backlog");
    check("backlog 帧返回", backlogEntry !== undefined);
    if (backlogEntry && backlogEntry.msg.t === "backlog") {
      const backlogEvents = backlogEntry.msg.events;
      check("backlog(全量游标) done=true", backlogEntry.msg.done === true);
      // "返回全量"的判据：与已经通过 event 帧实时收到的那一份逐条对齐——
      // 不硬编码一个事件条数（那会在 engine.ts 将来新增/减少某类审计事件时
      // 变成一次假阳性），而是断言"backlog 读到的就是刚刚实时广播过的那些"，
      // 这才是"全量"这个词真正要担保的事情。
      check(
        "backlog(全量游标) 与实时 event 帧完全一致（返回的是全量，不是子集）",
        backlogEvents.length === eventFrames.length &&
          backlogEvents.every((e, i) => e.type === eventFrames[i]?.type && e.seq === eventFrames[i]?.seq),
        `backlog=${backlogEvents.map((e) => `${e.seq}:${e.type}`).join(",")} live=${eventFrames.map((e) => `${e.seq}:${e.type}`).join(",")}`
      );
      check("backlog(全量游标) 至少含 user_message/assistant_message/turn_ended 三条", backlogEvents.length >= 3);
    }
  } finally {
    store.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
}

async function scenarioAssemblyResilience(): Promise<void> {
  const resilientSent: { cid: string; msg: CsDown }[] = [];
  const resilientOwnerUid = randomUUID();
  let ownerOfShouldFail = true;

  // sessions.get() 只需要在类型上满足 CloudSession——ownerOf 会先炸，
  // 这几个方法在两次调用里都不会真的被摸到
  const stubSession: CloudSession = {
    async say() {
      /* 不会被调用 */
    },
    async settled() {
      /* 不会被调用 */
    },
    approve() {
      return false;
    },
    backlog() {
      return [];
    },
    isRunning() {
      return false;
    },
    lastSeq() {
      return -1;
    },
    initiatorUid() {
      return null;
    },
    createdByUid() {
      return "";
    },
    archive() {
      return false;
    },
    isArchived() {
      return false;
    },
  };

  const resilientDeps: FrameHandlerDeps = {
    log: (m) => console.log(`[smoke] 帧：${m}`),
    verifyJwt: async (jwt) => verifyToken(jwt),
    isMember: async () => true,
    labelOf: async (uid) => uid,
    sessions: {
      get: () => stubSession,
      async create() {
        throw new Error("smoke：韧性场景不使用 create");
      },
      async archive() {
        return false;
      },
      async ownerOf() {
        // 模拟"调用即抛错的假 Supabase"：onSessionFrame 的 hello 分支里
        // `await deps.sessions.ownerOf(workspaceId)` 是唯一没被更早的判断
        // 短路掉、又确实会被这条冒烟路径摸到的一环
        if (ownerOfShouldFail) {
          throw new Error("boom：模拟 Supabase ownerOf 查询抛错（装配层韧性场景）");
        }
        return resilientOwnerUid;
      },
    },
    saveConfig: async () => {},
    repoState: () => null,
    modelState: () => null,
    rateLimit: { allow: () => true },
    send: (cid, msg) => resilientSent.push({ cid, msg }),
    dropCid: () => {},
  };

  const resilientHandler = createFrameHandler(resilientDeps);
  const wsId = randomUUID();
  const sessId = randomUUID();
  const helloRaw = encodeCs({ t: "hello", v: CS_PROTOCOL_VERSION, jwt: signToken(randomUUID()) });

  // daemon.ts 的真实调用形状是 fire-and-forget（transport.onMessage 的回调不是
  // async，onSessionFrame 的 promise 没被上层 await，只挂了 .catch）：
  //   frameHandler.onSessionFrame(...).catch((err) => console.error(...));
  // 这里原样复刻这个 .catch，而不是让 rejection 冒出去——断言的正是
  // "这个 .catch 接得住"这条纪律（T10 审查裁定）。用 await 接住这条 promise
  // 链只是为了让脚本知道它什么时候完事，不改变被测的性质：真正的保护来自
  // 这里显式挂的 .catch，不是外层的 await。
  let caught = false;
  let caughtMessage = "";
  await resilientHandler.onSessionFrame(wsId, sessId, `resil-${randomUUID()}`, helloRaw).catch((err: unknown) => {
    caught = true;
    caughtMessage = err instanceof Error ? err.message : String(err);
  });
  check(
    "装配韧性：sessions.ownerOf 抛错时，onSessionFrame 的 rejection 被 daemon 风格的 .catch 接住（不冒成 unhandledRejection）",
    caught && /boom/.test(caughtMessage),
    `caught=${caught} message=${caughtMessage}`
  );

  // 证明没有把 frameHandler 拖垮：同一个实例、依赖恢复正常后，
  // 后续帧照常处理——不是"抛一次以后这个会话就废了"
  ownerOfShouldFail = false;
  resilientSent.length = 0;
  await resilientHandler.onSessionFrame(wsId, sessId, `resil-${randomUUID()}`, helloRaw);
  const recovered = resilientSent.find((s) => s.msg.t === "welcome");
  check(
    "装配韧性：依赖恢复后，同一个 frameHandler 实例仍能正常处理下一帧（收到 welcome，进程和内部状态都没被那次 reject 拖垮）",
    recovered !== undefined,
    `sent=${JSON.stringify(resilientSent.map((s) => s.msg.t))}`
  );
}

async function main(): Promise<void> {
  await scenarioMainFlow();
  await scenarioAssemblyResilience();

  check(
    "全程没有出现未处理的 rejection（process.on('unhandledRejection') 兜底）",
    unhandledRejectionSeen === null,
    String(unhandledRejectionSeen)
  );

  console.log(`\n通过 ${ok.length} 条：`);
  for (const o of ok) console.log(`  ✓ ${o}`);
  if (bad.length) {
    console.log(`\n失败 ${bad.length} 条：`);
    for (const b of bad) console.log(`  ✗ ${b}`);
  }
  process.exit(bad.length ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error("[smoke] 装配脚本自身抛错：", err);
  process.exit(1);
});
