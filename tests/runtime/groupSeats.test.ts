// 群聊座位制（#1682，ADR-0376）在 runtime 里的整条链：一个群 + 三家主场的座位，经真的 seatHub 互相送话。
// 钉的是维护者拍板的那几条：人进群管理员自动在场；主人 @ 自己的管理员 = 主人自己的一轮（全套工具、无审批）；
// 别人 @ 它 = 只能聊天、手上只有 ask_owner；点头卡接 / 不接 / 过期；全部放行不弹卡；管理员之间 @ = 以主人身份使唤；
// 群聊镜像进座位（只镜像别家的话）；旧群迁移；群主退群转给最早入群的人。
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { createCloudSession, type CloudSession } from "../../services/runtime/src/sessionService.js";
import { createSeatHub, type GroupRef } from "../../services/runtime/src/seatHub.js";
import { createWikiService, type WikiService } from "../../services/runtime/src/wikiService.js";
import { createMemoryWikiFs } from "../../services/runtime/src/wikiFs.js";
import { createInMemoryWikiJournal } from "../../services/runtime/src/wikiJournal.js";
import { EventStore } from "../../src/session/store.js";
import type { SessionEvent, UserMessageEvent } from "../../src/session/events.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { AgentToolAllow } from "../../src/shared/agentToolAllow.js";
import type { AgentTier } from "../../src/shared/agentTier.js";
import { tempDir } from "../helpers/tempDir.js";
import { createInMemoryAgentWriter } from "../../services/runtime/src/agentRegistry.js";
import { createInMemoryMentionInbox } from "../../services/runtime/src/mentionInbox.js";
import { createWorkspaceLock } from "../../services/runtime/src/workspaceLock.js";
import { createInMemoryCloudSessionMeta } from "../../services/runtime/src/cloudSessionMeta.js";
import { seatAgentId, type GroupSeat } from "../../src/shared/groupSeats.js";
import { AttachmentStore } from "../../src/session/attachments.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001"; // 继爸：建群的人，群存在他的主场 wa
const B = "bbbbbbbb-0000-4000-8000-000000000002"; // Stan
const C = "cccccccc-0000-4000-8000-000000000003"; // Edison
const HOME: Record<string, string> = { [A]: "wa", [B]: "wb", [C]: "wc" };
const NAME: Record<string, string> = { [A]: "继爸", [B]: "Stan Yan", [C]: "Edison Guo" };
const AGENT: Record<string, string> = { [A]: "雨姐", [B]: "峰哥", [C]: "小E" };
const fakeWorld: ExecutionWorld = {
  fs: { read: async (path) => `<content of ${path}>`, write: async () => {} },
  exec: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};
const GROUP: GroupRef = { workspaceId: "wa", sessionId: "g1" };
void GROUP;
/** 每个用例开的 SQLite 都要关掉，不然 Windows 上临时目录删不掉 */
const openStores: EventStore[] = [];
afterEach(() => {
  for (const s of openStores.splice(0)) s.close();
});

function testWiki(): WikiService {
  return createWikiService({ workspaceId: "w", fs: createMemoryWikiFs(), journal: createInMemoryWikiJournal(), legacyMemories: async () => [], agentNames: async () => new Map(), isRunning: async () => true });
}

/** 一次模型调用看到的东西：哪只（主场）、手上有哪些刀、整段上下文 */
interface Call { ws: string; tools: string[]; transcript: string }
type Script = (call: Call) => ModelReply | Promise<ModelReply>;

interface World {
  stores: Map<string, EventStore>;
  rooms: Map<string, CloudSession>;
  calls: Call[];
  alerts: unknown[][];
  timers: (() => void)[];
  deltas: { ws: string; agentId: string; text: string }[];
  group: CloudSession;
  seatOf(uid: string): CloudSession | undefined;
  seatLog(uid: string): SessionEvent[];
  groupLog(): SessionEvent[];
  settleAll(): Promise<void>;
}

/** 出图那一套（#1682）：每个主场一个附件库、传进桶的对象记下来；`ready` = 这一轮亮不亮 generate_image */
interface ImageRig { ready: boolean; uploads: string[] }
/** 1×1 的真 PNG：网关回包里那张 */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const imageWorld: ExecutionWorld = { ...fakeWorld, http: { postJson: async () => ({ data: [{ b64_json: PNG_B64, media_type: "image/png" }] }) } };

function setup(o: { script: Script; seats?: GroupSeat[]; legacyHumans?: { uid: string; name: string }[]; images?: ImageRig }): World {
  const attachmentStores = new Map<string, AttachmentStore>();
  const attachmentsOf = (ws: string): AttachmentStore => {
    let a = attachmentStores.get(ws);
    if (a === undefined) {
      a = new AttachmentStore(tempDir(`mrotto-seats-att-${ws}-`));
      attachmentStores.set(ws, a);
    }
    return a;
  };
  const stores = new Map<string, EventStore>();
  const storeOf = (ws: string): EventStore => {
    let s = stores.get(ws);
    if (s === undefined) {
      s = new EventStore(join(tempDir(`mrotto-seats-${ws}-`), "s.db"));
      stores.set(ws, s);
      openStores.push(s);
    }
    return s;
  };
  const rooms = new Map<string, CloudSession>();
  const calls: Call[] = [];
  const alerts: unknown[][] = [];
  const timers: (() => void)[] = [];
  const deltas: { ws: string; agentId: string; text: string }[] = [];
  const seatIds = new Map<string, string>();

  const hub = createSeatHub({
    group: async (ref) => rooms.get(`${ref.workspaceId}/${ref.sessionId}`) ?? null,
    seat: async (uid, ref) => {
      const ws = HOME[uid]!;
      let sid = seatIds.get(uid);
      if (sid === undefined) {
        sid = `seat-${uid.slice(0, 4)}`;
        seatIds.set(uid, sid);
        const st = storeOf(ws);
        st.append({ sessionId: sid, ts: 1, type: "session_created", workspace: "/work", cloud: { workspaceId: ws, chat: { kind: "seat" }, seat: { groupWorkspaceId: ref.workspaceId, groupSessionId: ref.sessionId, ownerName: NAME[uid]!, groupTitle: "三人行" }, home: true } });
        st.append({ sessionId: sid, ts: 2, type: "chat_roster_changed", ignorable: true, agents: [{ agentId: "admin", name: AGENT[uid]! }] });
        rooms.set(`${ws}/${sid}`, open(ws, sid, uid));
      }
      return rooms.get(`${ws}/${sid}`)!;
    },
    log: () => {},
  });

  function open(ws: string, sid: string, owner: string): CloudSession {
    const admin = { agentId: "admin", name: AGENT[owner]!, description: "", instructions: "", models: ["m"], tools: [] as AgentToolAllow[], tier: 0 as AgentTier, domain: "admin" };
    return createCloudSession({
      diskUsage: () => null, routines: null, onOutreachEnded: null, signSpeechTicket: async () => "t", pairMessages: null, outreach: null, callback: null,
      approveAll: true, sessionMeta: createInMemoryCloudSessionMeta(),
      workspaceId: ws, sessionId: sid, ownerUid: owner, createdByUid: owner,
      store: storeOf(ws), world: o.images !== undefined ? imageWorld : fakeWorld, px: { edgeBase: "https://edge.example", runtimeSecret: "sek" }, hostUids: async () => [owner],
      agents: async () => [admin],
      adapterFor: (): ModelAdapter => ({
        model: "m",
        async chat(messages, tools): Promise<ModelReply> {
          const call = { ws, tools: (tools ?? []).map((t) => t.name), transcript: JSON.stringify(messages) };
          calls.push(call);
          return await o.script(call);
        },
      }),
      onEvent: () => {}, onUsage: () => {}, wiki: testWiki(), mentionInbox: createInMemoryMentionInbox(), agentWriter: createInMemoryAgentWriter(),
      isMember: async () => true, contextWindowOf: () => undefined, sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
      seatHub: hub,
      ...(o.images !== undefined
        ? {
            imageGen: { ready: async () => o.images!.ready, resolve: async () => ({ url: "https://edge.example/llm/v1/images", headers: {}, model: "seedream-5-0-lite" }) },
            toolImages: { store: attachmentsOf(ws), upload: async (bucket: string, path: string) => void o.images!.uploads.push(`${bucket}:${path}`) },
          }
        : {}),
      onDelta: (agentId, kind, text) => { if (kind === "content") deltas.push({ ws, agentId, text }); },
      alert: (...a: unknown[]) => void alerts.push(a),
      ringTimers: { setTimer: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimer: () => {} },
    });
  }

  const gs = storeOf("wa");
  gs.append({ sessionId: "g1", ts: 1, type: "session_created", workspace: "/work", cloud: { workspaceId: "wa", chat: { kind: "group" }, home: true } });
  if (o.legacyHumans !== undefined) {
    gs.append({ sessionId: "g1", ts: 2, type: "chat_roster_changed", ignorable: true, agents: [{ agentId: "admin", name: "雨姐" }], humans: o.legacyHumans });
  } else {
    const seats = o.seats ?? [A, B, C].map((u) => ({ uid: u, name: NAME[u]!, agentName: AGENT[u]! }));
    gs.append({ sessionId: "g1", ts: 2, type: "chat_roster_changed", ignorable: true, agents: [], humans: seats.filter((x) => x.uid !== A).map((x) => ({ uid: x.uid, name: x.name })), seats, groupOwnerUid: A });
  }
  const group = open("wa", "g1", A);
  rooms.set("wa/g1", group);

  const seatOf = (uid: string): CloudSession | undefined => {
    const sid = seatIds.get(uid);
    return sid === undefined ? undefined : rooms.get(`${HOME[uid]}/${sid}`);
  };
  return {
    stores, rooms, calls, alerts, timers, deltas, group, seatOf,
    seatLog: (uid) => (seatIds.has(uid) ? storeOf(HOME[uid]!).load(seatIds.get(uid)!) : []),
    groupLog: () => gs.load("g1"),
    // 桥是 fire-and-forget：反复等到所有房间都停下来、群日志不再长
    async settleAll() {
      for (let i = 0; i < 30; i++) {
        const before = gs.load("g1").length + [...seatIds.keys()].reduce((n, u) => n + storeOf(HOME[u]!).load(seatIds.get(u)!).length, 0);
        await new Promise((r) => setTimeout(r, 5));
        for (const r of rooms.values()) await r.settled();
        await new Promise((r) => setTimeout(r, 5));
        const after = gs.load("g1").length + [...seatIds.keys()].reduce((n, u) => n + storeOf(HOME[u]!).load(seatIds.get(u)!).length, 0);
        if (after === before) return;
      }
    },
  };
}

const said = (log: SessionEvent[], uid: string): string[] =>
  log.filter((e) => e.type === "assistant_message" && e.agentId === seatAgentId(uid)).map((e) => (e as { content: string }).content);

describe("群座位制：主人 @ 自己的管理员", () => {
  it("座位建在他自己的主场；那一轮是主人轮（全套工具、没有 ask_owner）；回话回到群里、署名是那个座位", async () => {
    const w = setup({ script: (c) => ({ content: c.ws === "wa" ? "在呢，继爸。" : "?" }) });
    await w.group.say(A, "继爸", "@雨姐 出来打个招呼", true, [seatAgentId(A)]);
    await w.settleAll();
    expect(w.seatOf(A)).toBeDefined();
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.ws).toBe("wa");
    expect(w.calls[0]!.tools).toContain("bash");
    expect(w.calls[0]!.tools).not.toContain("ask_owner");
    // 连接卡在座位里没人看得到：不亮
    expect(w.calls[0]!.tools).not.toContain("request_app_connect");
    // 管理员能把自家专员拉进座位（bring_agent 落名单），同管理员私聊
    expect(await w.seatOf(A)!.updateChatRoster("", { agentIds: ["admin"] }, "雨姐")).toMatchObject({ kind: "ok" });
    expect(said(w.groupLog(), A)).toEqual(["在呢，继爸。"]);
    // 群里不起 turn：人话落 chat_message、带 seatMentions；群日志里没有 user_message
    expect(w.groupLog().some((e) => e.type === "user_message")).toBe(false);
    expect(w.groupLog().find((e) => e.type === "chat_message")).toMatchObject({ fromUid: A, seatMentions: [seatAgentId(A)] });
  });

  it("没 @ 智能体的话谁都不接；@ 了人只推送", async () => {
    const w = setup({ script: () => ({ content: "x" }) });
    await w.group.say(B, "Stan Yan", "今晚吃啥", false, [], undefined, [A]);
    await w.settleAll();
    expect(w.calls).toHaveLength(0);
    expect(w.alerts.some((a) => a[0] === A && a[1] === "mention")).toBe(true);
  });

  it("正文里写 @峰哥（客户端没给 mentions）也认得出", async () => {
    const w = setup({ script: (c) => ({ content: c.ws === "wb" ? "到。" : "?" }) });
    await w.group.say(B, "Stan Yan", "@峰哥 在吗", true);
    await w.settleAll();
    expect(said(w.groupLog(), B)).toEqual(["到。"]);
  });

  it("不在群里的人说不了话", async () => {
    const w = setup({ script: () => ({ content: "x" }) });
    await expect(w.group.say("dddddddd-0000-4000-8000-000000000004", "路人", "@雨姐 你好", true)).rejects.toThrow("不在这个群里");
  });
});

describe("群座位制：别人使唤你的管理员", () => {
  it("客人轮手上只有 ask_owner；纯聊天直接答、不弹卡", async () => {
    const w = setup({ script: (c) => ({ content: c.ws === "wa" ? "值班呢。" : "?" }) });
    await w.group.say(C, "Edison Guo", "@雨姐 干啥呢", true, [seatAgentId(A)]);
    await w.settleAll();
    expect(w.calls[0]!.tools).toEqual(["ask_owner"]);
    expect(said(w.groupLog(), A)).toEqual(["值班呢。"]);
    expect(w.groupLog().some((e) => e.type === "seat_request")).toBe(false);
  });

  it("客人轮看不到主人的记忆：座位里落的 wiki 快照是空的那份（#1682：惊喜派对被一句「那天最好空着」暗示出去）", async () => {
    const w = setup({ script: () => ({ content: "得问她本人。" }) });
    await w.group.say(C, "Edison Guo", "@雨姐 她最近在忙啥", true, [seatAgentId(A)]);
    await w.settleAll();
    const snap = w.seatLog(A).filter((e) => e.type === "workspace_wiki_loaded").at(-1) as { index: string; pinned: unknown[]; own: string | null } | undefined;
    expect(snap).toBeDefined();
    expect(snap!.index).toContain("主人的记忆这一轮不给你看");
    expect(snap!.pinned).toEqual([]);
    expect(snap!.own).toBeNull();
    expect(w.calls[0]!.transcript).toContain("主人的记忆这一轮不给你看");
  });

  it("要动手 → ask_owner 落卡（座位与群各一份）、推给主人；主人接 → 主人的规矩起一轮、带着原话；回话回群", async () => {
    let n = 0;
    const w = setup({
      script: (c) => {
        if (c.ws !== "wa") return { content: "?" };
        n += 1;
        if (c.tools.length === 1 && c.tools[0] === "ask_owner") {
          return c.transcript.includes("已经请") ? { content: "等继爸点头。" } : { content: "", toolCalls: [{ id: `k${n}`, name: "ask_owner", args: { summary: "读门店后台今天的营业额（只读）" } }] };
        }
        return { content: "今天到 22:25 是 $3,346.58。" };
      },
    });
    await w.group.say(B, "Stan Yan", "@雨姐 看看今天 Mandy 营业额", true, [seatAgentId(A)]);
    await w.settleAll();
    const card = w.groupLog().find((e) => e.type === "seat_request");
    expect(card).toMatchObject({ seatUid: A, fromUid: B, fromName: "Stan Yan", summary: "读门店后台今天的营业额（只读）", ask: "@雨姐 看看今天 Mandy 营业额" });
    expect(w.seatLog(A).filter((e) => e.type === "seat_request")).toHaveLength(1);
    expect(w.alerts.some((a) => a[0] === A)).toBe(true);
    expect(said(w.groupLog(), A)).toEqual(["等继爸点头。"]);
    // 不是座位主人点不了
    const id = (card as { requestId: string }).requestId;
    expect(await w.group.decideSeat!(id, B, "accepted")).toEqual({ ok: false, message: "只有继爸能点" });
    expect(await w.group.decideSeat!(id, A, "accepted")).toEqual({ ok: true });
    await w.settleAll();
    expect(w.groupLog().find((e) => e.type === "seat_decision")).toMatchObject({ requestId: id, decision: "accepted", byUid: A });
    const grant = w.seatLog(A).find((e): e is UserMessageEvent => e.type === "user_message" && e.greeting === "seat_grant")!;
    expect(grant.fromUid).toBe(A);
    expect(grant.content).toContain("继爸 点了头");
    expect(grant.content).toContain("看看今天 Mandy 营业额");
    // 授权轮是主人轮：手上有动手的刀
    expect(w.calls.at(-1)!.tools).toContain("bash");
    expect(said(w.groupLog(), A).at(-1)).toBe("今天到 22:25 是 $3,346.58。");
    // 那一轮的回话推给提要求的 Stan，不推给点头的继爸
    expect(w.alerts.some((a) => a[0] === B && a[1] === "agent_reply" && JSON.stringify(a[2]).includes("3,346.58"))).toBe(true);
    // 答过的不能再答
    expect(await w.group.decideSeat!(id, A, "declined")).toMatchObject({ ok: false });
  });

  it("主人不接 → 管理员在群里说一句、不起动手的一轮", async () => {
    const w = setup({
      script: (c) =>
        c.tools.includes("ask_owner") && !c.transcript.includes("已经请")
          ? { content: "", toolCalls: [{ id: "k", name: "ask_owner", args: { summary: "给 Edison 打电话" } }] }
          : { content: "等继爸点头。" },
    });
    await w.group.say(C, "Edison Guo", "@雨姐 给我打个电话", true, [seatAgentId(A)]);
    await w.settleAll();
    const id = (w.groupLog().find((e) => e.type === "seat_request") as { requestId: string }).requestId;
    const before = w.calls.length;
    expect(await w.group.decideSeat!(id, A, "declined")).toEqual({ ok: true });
    await w.settleAll();
    expect(w.calls.length).toBe(before);
    expect(said(w.groupLog(), A).at(-1)).toBe("继爸没同意，这件就不办了。");
  });

  it("10 分钟没人点 → 过期、群里一句「没回」；之后点不了", async () => {
    const w = setup({
      script: (c) =>
        c.tools.includes("ask_owner") && !c.transcript.includes("已经请")
          ? { content: "", toolCalls: [{ id: "k", name: "ask_owner", args: { summary: "查库存" } }] }
          : { content: "等继爸点头。" },
    });
    await w.group.say(C, "Edison Guo", "@雨姐 查下库存", true, [seatAgentId(A)]);
    await w.settleAll();
    expect(w.timers.length).toBeGreaterThan(0);
    for (const t of w.timers.splice(0)) t();
    await w.settleAll();
    expect(w.groupLog().find((e) => e.type === "seat_decision")).toMatchObject({ decision: "expired", byUid: null });
    expect(said(w.groupLog(), A).at(-1)).toBe("继爸没回，这件先放着。");
    const id = (w.groupLog().find((e) => e.type === "seat_request") as { requestId: string }).requestId;
    expect(await w.group.decideSeat!(id, A, "accepted")).toMatchObject({ ok: false });
  });

  it("座位设了全部放行：不弹卡、直接按主人的规矩办；只有自己能改自己的策略", async () => {
    const w = setup({ script: (c) => ({ content: c.tools.includes("bash") ? "办好了。" : "?" }) });
    expect(w.group.setSeatPolicy!(A, "继爸", "open")).toEqual({ ok: true, changed: true });
    expect(w.group.seats!()!.find((s) => s.uid === A)!.policy).toBe("open");
    expect(w.group.chat()!.seats!.find((s) => s.uid === A)!.policy).toBe("open");
    await w.group.say(B, "Stan Yan", "@雨姐 看看营业额", true, [seatAgentId(A)]);
    await w.settleAll();
    expect(w.groupLog().some((e) => e.type === "seat_request")).toBe(false);
    expect(w.seatLog(A).find((e): e is UserMessageEvent => e.type === "user_message" && e.greeting === "seat_grant")!.content).toContain("放行");
    expect(said(w.groupLog(), A)).toEqual(["办好了。"]);
    expect(w.group.setSeatPolicy!(A, "继爸", "ask")).toEqual({ ok: true, changed: true });
    expect(w.group.seats!()!.find((s) => s.uid === A)!.policy).toBeUndefined();
  });
});

describe("群座位制：管理员之间", () => {
  it("雨姐的回话里 @峰哥 = 以继爸的身份使唤峰哥：送进 Stan 的座位、深度 +1、峰哥那一轮是客人轮", async () => {
    const w = setup({
      script: (c) => {
        if (c.ws === "wa") return { content: "@峰哥 你那边这周进货多少？" };
        if (c.ws === "wb") return { content: "这个得问 Stan。" };
        return { content: "?" };
      },
    });
    await w.group.say(A, "继爸", "@雨姐 跟峰哥对一下进货", true, [seatAgentId(A)]);
    await w.settleAll();
    const opening = w.seatLog(B).find((e): e is UserMessageEvent => e.type === "user_message" && e.relay !== undefined)!;
    expect(opening.fromUid).toBe(A);
    expect(opening.relay).toEqual({ fromAgentId: seatAgentId(A), depth: 1 });
    expect(opening.content).toMatch(/雨姐[（(]继爸的管理员[）)]/);
    expect(w.calls.find((c) => c.ws === "wb")!.tools).toEqual(["ask_owner"]);
    expect(said(w.groupLog(), B)).toEqual(["这个得问 Stan。"]);
  });

  it("互相 @ 打转到深度上限就停、群里说一句", async () => {
    const w = setup({
      script: (c) => (c.ws === "wa" ? { content: "@峰哥 你说呢" } : c.ws === "wb" ? { content: "@雨姐 你说呢" } : { content: "?" }),
    });
    await w.group.say(A, "继爸", "@雨姐 开始", true, [seatAgentId(A)]);
    await w.settleAll();
    expect(w.groupLog().some((e) => e.type === "chat_message" && e.fromUid === "system" && e.content.includes("来回 6 棒"))).toBe(true);
    expect(w.calls.length).toBeLessThanOrEqual(7);
  });
});

describe("群座位制：镜像进座位", () => {
  it("第一次被 @ 带上前面的群聊；之后只带增量；自家管理员的回话不镜像；镜像行不起 turn", async () => {
    const w = setup({ script: (c) => ({ content: c.ws === "wb" ? "收到。" : "好的。" }) });
    await w.group.say(A, "继爸", "今天店里很忙", false, []);
    await w.group.say(C, "Edison Guo", "辛苦", false, []);
    await w.group.say(B, "Stan Yan", "@峰哥 记一下", true, [seatAgentId(B)]);
    await w.settleAll();
    const mirrors = w.seatLog(B).filter((e) => e.type === "chat_message" && e.mirror !== undefined).map((e) => (e as { content: string }).content);
    expect(mirrors).toEqual(["今天店里很忙", "辛苦"]);
    await w.group.say(A, "继爸", "@雨姐 你也记一下", true, [seatAgentId(A)]);
    await w.settleAll();
    await w.group.say(B, "Stan Yan", "@峰哥 还有一件", true, [seatAgentId(B)]);
    await w.settleAll();
    const later = w.seatLog(B).filter((e) => e.type === "chat_message" && e.mirror !== undefined).map((e) => (e as { content: string }).content);
    // 增量：雨姐那句 @ 与她的回话（别家的）进来了；峰哥自己的「收到。」没有被镜像
    expect(later.slice(2)).toEqual(["@雨姐 你也记一下", "好的。"]);
    expect(later).not.toContain("收到。");
    expect(w.calls.filter((c) => c.ws === "wb")).toHaveLength(2);
  });
});

describe("群座位制：名单", () => {
  it("旧群迁移：有客人的主场群转成座位制（群主 + 客人），落一句系统话；再迁一次是空操作", () => {
    const w = setup({ script: () => ({ content: "x" }), legacyHumans: [{ uid: B, name: "Stan Yan" }] });
    expect(w.group.seats!()).toBeNull();
    const people = [A, B].map((u) => ({ uid: u, name: NAME[u]!, agentName: AGENT[u]! }));
    expect(w.group.upgradeToSeats!(people)).toBe(true);
    expect(w.group.seats!()!.map((s) => s.uid)).toEqual([A, B]);
    expect(w.group.chat()!.agentIds).toEqual([]);
    expect(w.groupLog().some((e) => e.type === "chat_message" && e.content.includes("群聊升级了"))).toBe(true);
    expect(w.group.upgradeToSeats!(people)).toBe(false);
  });

  it("群主退群转给最早入群的人；退了的人不在籍、说不了话；他的卡一并过期", async () => {
    const w = setup({ script: () => ({ content: "x" }) });
    const r = w.group.leaveGroup!(A, "继爸");
    expect(r).toMatchObject({ ok: true, groupOwnerUid: B });
    expect(w.group.groupOwner!()).toBe(B);
    expect(w.group.seatMember!(A)).toBe(false);
    expect(w.group.isGuest(A)).toBe(false);
    await expect(w.group.say(A, "继爸", "我还在吗", false, [])).rejects.toThrow("不在这个群里");
    // 打字 @ 了已经退群的人的管理员：群里说一句，不是石沉大海
    await w.group.say(B, "Stan Yan", "@雨姐 继爸还来吗", false);
    expect(w.groupLog().some((e) => e.type === "chat_message" && e.fromUid === "system" && e.content.includes("雨姐已经跟着继爸退群了"))).toBe(true);
    expect(w.group.chat()!.humans.map((h) => h.uid)).toEqual([C]);
  });

  it("拉人 / 移人：座位跟着人走，保留顺序与策略；不能往座位制的群里拉智能体", async () => {
    const w = setup({ script: () => ({ content: "x" }), seats: [A, B].map((u) => ({ uid: u, name: NAME[u]!, agentName: AGENT[u]! })) });
    w.group.setSeatPolicy!(B, "Stan Yan", "open");
    const people = [A, B, C].map((u) => ({ uid: u, name: NAME[u]!, agentName: AGENT[u]! }));
    expect(await w.group.updateChatRoster(B, { seatPeople: people }, "Stan Yan")).toMatchObject({ kind: "ok", changed: true });
    expect(w.group.seats!()!.map((s) => [s.uid, s.policy])).toEqual([[A, undefined], [B, "open"], [C, undefined]]);
    expect(await w.group.updateChatRoster(A, { agentIds: ["admin"] }, "继爸")).toMatchObject({ kind: "not_group" });
  });
});

describe("座位那一侧", () => {
  it("座位里人说不了话；同一个人一次只有一张卡在等", async () => {
    const w = setup({
      script: (c) =>
        c.tools.includes("ask_owner") && !c.transcript.includes("已经请") && !c.transcript.includes("已经在等") ? { content: "", toolCalls: [{ id: `k${c.transcript.length}`, name: "ask_owner", args: { summary: "查东西" } }] } : { content: "等。" },
    });
    await w.group.say(C, "Edison Guo", "@雨姐 查一下", true, [seatAgentId(A)]);
    await w.settleAll();
    await expect(w.seatOf(A)!.say(A, "继爸", "hi", true)).rejects.toThrow("群座位");
    await w.group.say(C, "Edison Guo", "@雨姐 再查一下", true, [seatAgentId(A)]);
    await w.settleAll();
    expect(w.seatLog(A).filter((e) => e.type === "seat_request")).toHaveLength(1);
  });
});

describe("群座位制：更刁的几种", () => {
  it("主人那一轮还在跑时别人 @ 它：别人的话另排一轮（只有 ask_owner），主人那一轮的刀不被收紧", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const w = setup({
      script: async (c) => {
        if (c.ws !== "wa") return { content: "?" };
        if (first) { first = false; await gate; return { content: "主人那件办好了。" }; }
        return { content: c.tools.includes("ask_owner") ? "你好呀。" : "又一件。" };
      },
    });
    await w.group.say(A, "继爸", "@雨姐 整理下库存", true, [seatAgentId(A)]);
    await new Promise((r) => setTimeout(r, 20));
    await w.group.say(C, "Edison Guo", "@雨姐 在忙啥", true, [seatAgentId(A)]);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await w.settleAll();
    const wa = w.calls.filter((c) => c.ws === "wa");
    expect(wa[0]!.tools).toContain("bash");
    expect(wa.some((c) => c.tools.length === 1 && c.tools[0] === "ask_owner")).toBe(true);
    expect(said(w.groupLog(), A)).toEqual(["主人那件办好了。", "你好呀。"]);
  });

  it("流式半句话转进群里、署名是那个座位", async () => {
    const w = setup({ script: () => ({ content: "x" }) });
    w.group.receiveSeatDelta!(A, "在呢…");
    w.group.receiveSeatDelta!("dddddddd-0000-4000-8000-000000000004", "不在群里的不转");
    expect(w.deltas).toEqual([{ ws: "wa", agentId: seatAgentId(A), text: "在呢…" }]);
  });

  it("座位的提示词说清：谁的座位、主人 @ 没审批、别人 @ 只能聊天要用 ask_owner", async () => {
    const w = setup({ script: () => ({ content: "好" }) });
    await w.group.say(B, "Stan Yan", "@雨姐 你是谁", true, [seatAgentId(A)]);
    await w.settleAll();
    const t = w.calls[0]!.transcript;
    expect(t).toContain("属于 继爸 的座位");
    expect(t).toContain("ask_owner");
    expect(t).not.toContain("这里没有审批：你做的每一步直接生效");
  });
});

describe("群座位制：三件遗留（#1682）", () => {
  it("授权轮硬拦私人文件夹：读 / 命令里点名 private 都被拒；主人自己的轮不拦", async () => {
    const results: string[] = [];
    let step = 0;
    const w = setup({
      script: (c) => {
        if (c.tools.includes("ask_owner")) return c.transcript.includes("已经请") ? { content: "Waiting on 继爸." } : { content: "", toolCalls: [{ id: "k1", name: "ask_owner", args: { summary: "看排班" } }] };
        step += 1;
        if (step === 1) return { content: "", toolCalls: [{ id: "b1", name: "bash", args: { cmd: "cat /work/private/notes.md" } }, { id: "r1", name: "read_file", args: { path: "/work/private/notes.md" } }] };
        if (step === 2) { results.push(c.transcript); return { content: "done" }; }
        return { content: "ok" };
      },
    });
    await w.group.say(B, "Stan Yan", "@雨姐 看下继爸排班", true, [seatAgentId(A)]);
    await w.settleAll();
    const id = (w.groupLog().find((e) => e.type === "seat_request") as { requestId: string }).requestId;
    await w.group.decideSeat!(id, A, "accepted", "只告诉他周五");
    await w.settleAll();
    const seat = w.seatLog(A);
    const out = seat.filter((e) => e.type === "tool_result").map((e) => JSON.stringify(e));
    expect(out.filter((o) => o.includes("私人文件夹")).length).toBe(2);
    // 附言进了授权开场白、也记在结局上
    expect(seat.find((e): e is UserMessageEvent => e.type === "user_message" && e.greeting === "seat_grant")!.content).toContain("只告诉他周五");
    expect(w.groupLog().find((e) => e.type === "seat_decision")).toMatchObject({ note: "只告诉他周五" });
  });

  it("不接也能附一句：管理员在群里转述", async () => {
    const w = setup({
      script: (c) => (c.tools.includes("ask_owner") && !c.transcript.includes("已经请") ? { content: "", toolCalls: [{ id: "k", name: "ask_owner", args: { summary: "x" } }] } : { content: "等。" }),
    });
    await w.group.say(C, "Edison Guo", "@雨姐 查下库存", true, [seatAgentId(A)]);
    await w.settleAll();
    const id = (w.groupLog().find((e) => e.type === "seat_request") as { requestId: string }).requestId;
    await w.group.decideSeat!(id, A, "declined", "下周再说");
    await w.settleAll();
    expect(said(w.groupLog(), A).at(-1)).toBe("继爸没同意：「下周再说」");
  });

  it("专员的话折叠进群（带 worker），不推送、不当成去使唤别家", () => {
    const w = setup({ script: () => ({ content: "x" }) });
    w.group.receiveSeatReply!({ seatUid: A, text: "@峰哥 预算做好了", model: "m", toUid: B, depth: 0, worker: { agentId: "a_000000000001", name: "Nomad" } });
    const e = w.groupLog().at(-1)!;
    expect(e).toMatchObject({ type: "assistant_message", agentId: seatAgentId(A), worker: { name: "Nomad" } });
    expect(w.alerts).toHaveLength(0);
    expect(w.seatOf(B)).toBeUndefined();
  });
});

describe("群座位制：出图（#1682）", () => {
  const draw = (c: Call): ModelReply =>
    c.tools.includes("generate_image") && !c.transcript.includes("已生成")
      ? { content: "", toolCalls: [{ id: "g1", name: "generate_image", args: { prompt: "给妈妈的生日贺卡" } }] }
      : { content: "做好了，生日快乐！" };

  it("主人 @ 自己的管理员：手上有 generate_image；画出来的图落座位的日志、跟着回话进群，群里那份传在群的目录下", async () => {
    const rig: ImageRig = { ready: true, uploads: [] };
    const w = setup({ script: draw, images: rig });
    await w.group.say(A, "继爸", "@雨姐 给我妈做张生日贺卡", true, [seatAgentId(A)]);
    await w.settleAll();
    expect(w.calls[0]!.tools).toContain("generate_image");
    const result = w.seatLog(A).find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ type: "tool_result", status: "ok", images: [{ mediaType: "image/png", width: 1, height: 1 }] });
    const id = (result as { images: { id: string }[] }).images[0]!.id;
    const hex = id.slice("sha256:".length);
    const seatSid = w.seatLog(A)[0]!.sessionId;
    // 座位那份 + 群那份：同一个对象名，两个目录（群里的人读不到座位的目录）
    expect(rig.uploads).toEqual([`chat-media:wa/${seatSid}/${hex}.png`, `chat-media:wa/g1/${hex}.png`]);
    const reply = w.groupLog().find((e) => e.type === "assistant_message" && e.agentId === seatAgentId(A));
    expect(reply).toMatchObject({ content: "做好了，生日快乐！", attachments: [{ id, mediaType: "image/png" }] });
  });

  it("别人使唤你的管理员：那一轮只有 ask_owner，没有 generate_image（替别人花主人的钱要主人点头）", async () => {
    const rig: ImageRig = { ready: true, uploads: [] };
    const w = setup({ script: () => ({ content: "等继爸点头。" }), images: rig });
    await w.group.say(B, "Stan Yan", "@雨姐 帮我画张海报", true, [seatAgentId(A)]);
    await w.settleAll();
    expect(w.calls.find((c) => c.ws === "wa")!.tools).toEqual(["ask_owner"]);
    expect(rig.uploads).toEqual([]);
  });

  it("这一轮出图走不通（ready = false）：工具表里根本没有它", async () => {
    const w = setup({ script: () => ({ content: "好。" }), images: { ready: false, uploads: [] } });
    await w.group.say(A, "继爸", "@雨姐 在吗", true, [seatAgentId(A)]);
    await w.settleAll();
    expect(w.calls[0]!.tools).toContain("bash");
    expect(w.calls[0]!.tools).not.toContain("generate_image");
  });
});
