// 群聊与人际模拟（#1682）：一座「城」——每个模拟用户一个主场（真沙箱容器、自己的管理员、自己建的专员、一份 wiki、
// 和管理员的私聊、和每位朋友的私密 / 公开车道、管理员车道），群与座位、车道桥、管理员车道的桥跑线上同一份代码
// （sessionService / seatHub / laneBridge / AdminsBridge 的同形实现）。朋友之间的私聊消息（线上的 messages 表）这里是一张内存表。
// 人说的话、点头卡 / 协作卡的决定由另一个模型按人设生成。模型一律走线上网关（真钱，记在 OTTO_LIVE_OWNER 名下）。只给 *.live.test.ts 用。
import { join } from "node:path";
import { createCloudSession, type AdminsBridge, type AgentSpec, type CloudSession } from "../../../services/runtime/src/sessionService.js";
import { createSeatHub } from "../../../services/runtime/src/seatHub.js";
import { createLaneBridge } from "../../../services/runtime/src/laneBridge.js";
import { runRoutineInRoom } from "../../../services/runtime/src/routineRun.js";
import { createHostedProbe, createHostedRuntimeAdapter, createRouteMemo, type HostedProbe } from "../../../services/runtime/src/hostedRoute.js";
import { createWikiService, type WikiService } from "../../../services/runtime/src/wikiService.js";
import { createMemoryWikiFs } from "../../../services/runtime/src/wikiFs.js";
import { createInMemoryWikiJournal } from "../../../services/runtime/src/wikiJournal.js";
import { createInMemoryRoutineStore } from "../../../services/runtime/src/routineStore.js";
import { createInMemoryAgentWriter } from "../../../services/runtime/src/agentRegistry.js";
import { createInMemoryMentionInbox } from "../../../services/runtime/src/mentionInbox.js";
import { createWorkspaceLock } from "../../../services/runtime/src/workspaceLock.js";
import { createInMemoryCloudSessionMeta } from "../../../services/runtime/src/cloudSessionMeta.js";
import { BUILTIN_ANYSEARCH_KEY } from "../../../src/tools/anysearch.js";
import { AttachmentStore } from "../../../src/session/attachments.js";
import { decideRuntimeImageRoute, type ToolImagesPort } from "../../../services/runtime/src/toolImages.js";
import { EventStore } from "../../../src/session/store.js";
import type { SessionEvent } from "../../../src/session/events.js";
import type { ModelAdapter } from "../../../src/model/adapter.js";
import type { AgentTier } from "../../../src/shared/agentTier.js";
import type { AgentToolAllow } from "../../../src/shared/agentToolAllow.js";
import type { FriendTier } from "../../../src/shared/friendTier.js";
import type { PairMessageRow } from "../../../src/shared/pairChat.js";
import { groupSeatsOf, seatAgentId, seatCardsOf, seatHandles, seatLabel, seatUidOf, type GroupSeat } from "../../../src/shared/groupSeats.js";
import { tempDir } from "../../helpers/tempDir.js";
import { createSimBox, type SimBox } from "./simWorld.js";
import { createHash } from "node:crypto";
import { formatFromBytes, toMarkdownBytes } from "@firecrawl/anydoc";
import { createChatMediaIntake } from "../../../services/runtime/src/chatMediaIntake.js";
import { createSystemFonts } from "../../../services/runtime/src/systemFonts.js";
import { renderCsv, renderDocx, renderPptx, renderXlsx } from "../../../services/runtime/src/documents/office.js";
import { renderPdf } from "../../../services/runtime/src/documents/pdf.js";
import { parseMarkdownLite } from "../../../services/runtime/src/documents/markdownLite.js";
import { CHAT_MEDIA_BUCKET, chatMediaPath, docMimeForName, type ChatMediaRef, type DocMime } from "../../../src/shared/chatMedia.js";

/** 人在聊天里发的一份文件（#1683）：模拟现做出来（同 create_document 的渲染器），传进假的 Storage 再带进 say */
export interface SimFile {
  name: string;
  /** pdf / docx / md / txt 的正文（小号 Markdown） */
  text?: string;
  /** xlsx / csv */
  rows?: (string | number | null)[][];
  /** pptx */
  slides?: { title: string; bullets?: string[] }[];
}

/** 这一场里出现过的文件：人发的、智能体做出来交给人的。text = 读回来的文字（anydoc），报告与检查用 */
export interface ProducedFile {
  where: string;
  by: string;
  name: string;
  mediaType: string;
  bytes: number;
  fromHuman: boolean;
  text: string;
  ts: number;
}

export interface PersonaDef {
  id: string;
  uid: string;
  name: string;
  tz: string;
  adminName: string;
  /** 这个人是谁、怎么说话（给扮演他的模型读） */
  bio: string;
  /** 他对「别人使唤我的管理员」的态度（点头卡 / 协作卡由它决定） */
  privacy: string;
  /** 他主场 /work 里有什么（真文件） */
  files: Record<string, string>;
  /** 他会让自己的管理员建哪些专员（他自己的话的要点） */
  wantsAgents?: string[];
  /** 他给每位朋友开的好友档位（缺席 = 可带智能体） */
  tiers?: Record<string, FriendTier>;
  /** 他说什么话（检查「回话 / 文件有没有用他的语言」用）：en / zh / ja / ko / hi / th / vi / id / tl。缺席 = en */
  lang?: string;
}

export type Beat =
  /** 群里说一句 */
  | { kind: "say"; who: string; goal: string; at?: string[]; cards?: "persona" | "ignore"; file?: SimFile }
  | { kind: "policy"; who: string; policy: "ask" | "open" }
  | { kind: "leave"; who: string }
  | { kind: "invite"; who: string; add: string[] }
  | { kind: "fire_timers" }
  /** 和自己的管理员一对一（私聊） */
  | { kind: "dm_admin"; who: string; goal: string; file?: SimFile }
  /** 两个人之间直接发私聊（不经智能体；线上的 messages 表） */
  | { kind: "friend_dm"; who: string; to: string; goal: string }
  /** 在 owner 和 peer 那条私聊旁边的车道里说话：speaker 是 owner（自己的车道）或 peer（公开车道里的客人） */
  | { kind: "lane"; owner: string; peer: string; speaker: string; facing: "self" | "both"; goal: string; file?: SimFile }
  /** 让到点的定时任务（这些人的；缺席 = 全部）现在就跑——不等真钟 */
  | { kind: "fire_routines"; who?: string[] };

export interface Scenario {
  id: string;
  title: string;
  /** 这场想验证什么（报告里写） */
  aim: string;
  /** 群场景才有；纯一对一 / 人与人的场景不建群 */
  groupTitle?: string;
  owner?: string;
  members?: string[];
  /** 这场里不该出现在 owner 自己私下以外地方的字串（比如私聊里交代保密的 wifi 密码） */
  leaks?: { owner: string; text: string; okWhere?: string[] }[];
  /** 剧本里没说话、但得在场的人（比如被代发消息的那位朋友：不在场就「好友里没有这个人」） */
  extras?: string[];
  beats: Beat[];
}

export interface Call {
  home: string;
  sessionId: string;
  agentId: string;
  ms: number;
  promptTokens: number;
  completionTokens: number;
  tools: string[];
  toolCalls: { name: string; args: unknown }[];
}

interface Home {
  p: PersonaDef;
  ws: string;
  store: EventStore;
  writer: ReturnType<typeof createInMemoryAgentWriter>;
  wiki: WikiService;
  box: SimBox;
  dm: CloudSession | null;
  seats: Map<string, CloudSession>;
  /** 朋友 persona id → 那条车道 */
  lanes: Map<string, { sid: string; room: CloudSession; facing: "self" | "both" }>;
  /** 朋友 uid → 管理员车道 */
  admins: Map<string, { sid: string; room: CloudSession }>;
}

const DM_SID = (id: string): string => `dm-${id}`;

export interface TranscriptLine {
  kind: "human" | "agent" | "system" | "card" | "decision";
  /** 哪一条对话（群 / 私聊 / 车道 / 管理员车道 / 朋友私聊） */
  where: string;
  who: string;
  text: string;
  ts: number;
}

export interface City {
  homes: Map<string, Home>;
  calls: Call[];
  alerts: unknown[][];
  timers: (() => void)[];
  routines: ReturnType<typeof createInMemoryRoutineStore>;
  friendDM: PairMessageRow[];
  personaCalls: number;
  log: string[];
  setupAgents(p: PersonaDef): Promise<void>;
  runScenario(s: Scenario): Promise<ScenarioResult>;
  destroy(): Promise<void>;
}

export interface ScenarioResult {
  scenario: Scenario;
  /** 群（有的话）的那一份——群检查用 */
  transcript: TranscriptLine[];
  /** 这一场碰过的每条对话（含群）的全部新增，按时间排 */
  everywhere: TranscriptLine[];
  /** 每条对话这一场新增的事件（检查用）：key = 标签 */
  logs: Record<string, { home: string; kind: string; events: SessionEvent[] }>;
  groupLog: SessionEvent[];
  seats: GroupSeat[];
  /** 这一场里出现过的文件（#1683） */
  files: ProducedFile[];
  startedAt: number;
  endedAt: number;
}

export async function createCity(o: { edgeBase: string; runtimeSecret: string; payer: string; payerWs: string; personas: PersonaDef[] }): Promise<City> {
  const probe: HostedProbe = createHostedProbe({ edgeBase: o.edgeBase, runtimeSecret: o.runtimeSecret });
  const homes = new Map<string, Home>();
  const byUid = new Map<string, Home>();
  const calls: Call[] = [];
  const alerts: unknown[][] = [];
  const timers: (() => void)[] = [];
  const routines = createInMemoryRoutineStore();
  const friendDM: PairMessageRow[] = [];
  const groups = new Map<string, CloudSession>();
  const groupStores = new Map<string, EventStore>();
  const groupTitles = new Map<string, string>();
  /** 所有开着的对话：sid → 房、store、标签、哪家、哪种 */
  const rooms = new Map<string, { room: CloudSession; store: EventStore; label: string; home: string; kind: string }>();
  const log: string[] = [];
  /** 假的 Storage（#1683）：bucket/path → 字节。出图、交文件往里传，人发的文件从这里取 */
  const storage = new Map<string, Uint8Array>();
  /** 出图（#1682）：附件库按团队一份；上传进假的 Storage，记一行「传到哪、多大」 */
  const attachments = new Map<string, AttachmentStore>();
  const attachmentsOf = (ws: string): AttachmentStore => {
    let st = attachments.get(ws);
    if (st === undefined) { st = new AttachmentStore(tempDir(`otto-sim-att-`)); attachments.set(ws, st); }
    return st;
  };
  const imagesFor = (ws: string): ToolImagesPort => ({
    store: attachmentsOf(ws),
    upload: async (bucket, path, bytes) => { storage.set(`${bucket}/${path}`, bytes); log.push(`[上传] ${bucket}/${path} ${bytes.length}B`); },
  });
  const toText = async (data: Uint8Array): Promise<string> => {
    const f = formatFromBytes(data);
    if (f === null) throw Object.assign(new Error("认不出"), { code: "unsupported" });
    return toMarkdownBytes(data, f);
  };
  const fonts = createSystemFonts();
  // 人发来的文件：同 daemon 的 chatMedia（下载、复算哈希、存进那一家的沙箱 inbox/、转字）
  const intake = createChatMediaIntake({
    download: async (bucket, path) => { const d = storage.get(`${bucket}/${path}`); if (d === undefined) throw new Error("Object not found"); return d; },
    storeFor: attachmentsOf,
    saveFile: async (ws, path, data) => { const h = [...homes.values()].find((x) => x.ws === ws); if (h === undefined) throw new Error("没有这一家"); await h.box.world.fs.writeBytes!(path, data); },
    toText,
  });
  /** 模拟里的人「发一份文件」：现做出字节、传进假的 Storage，回 say 帧里那一格 */
  async function humanFile(ws: string, sid: string, f: SimFile): Promise<ChatMediaRef> {
    const mime = docMimeForName(f.name);
    if (mime === null) throw new Error(`模拟文件格式不认：${f.name}`);
    const ext = f.name.split(".").pop()!.toLowerCase();
    const data: Uint8Array =
      ext === "xlsx" ? (await renderXlsx([{ name: "Sheet1", rows: f.rows ?? [] }])).data
        : ext === "csv" ? renderCsv({ name: "Sheet1", rows: f.rows ?? [] })
          : ext === "pptx" ? await renderPptx({ slides: f.slides ?? [] })
            : ext === "docx" ? await renderDocx({ blocks: parseMarkdownLite(f.text ?? "") })
              : ext === "pdf" ? await renderPdf({ blocks: parseMarkdownLite(f.text ?? ""), fonts })
                : new TextEncoder().encode(f.text ?? "");
    const sha = createHash("sha256").update(data).digest("hex");
    storage.set(`${CHAT_MEDIA_BUCKET}/${chatMediaPath(ws, sid, sha, mime)}`, data);
    return { kind: "file", sha256: sha, mediaType: mime as DocMime, bytes: data.byteLength, width: 0, height: 0, name: f.name };
  }
  const fileHint = (f: SimFile | undefined): string =>
    f === undefined ? "" : `\nYou are attaching a file called "${f.name}" to this message (the app attaches it for you) — write only the message text that goes with it, don't paste the file contents.`;
  let personaCalls = 0;
  const nameOf = (uid: string): string => byUid.get(uid)?.p.name ?? uid.slice(0, 8);

  for (const p of o.personas) {
    const box = await createSimBox(`otto-sim-${process.env["OTTO_SIM_TAG"] ?? "x"}-${p.id}`);
    await box.seed(p.files);
    const writer = createInMemoryAgentWriter();
    const ws = `w-${p.id}`;
    const h: Home = {
      p, ws, store: new EventStore(join(tempDir(`otto-sim-${p.id}-`), "s.db")), writer, box, dm: null, seats: new Map(), lanes: new Map(), admins: new Map(),
      // 一家一份 wiki（同线上 wikiFor(workspaceId)）：私聊里记下的事群里、车道里都读得到
      wiki: createWikiService({ workspaceId: ws, fs: createMemoryWikiFs(), journal: createInMemoryWikiJournal(), legacyMemories: async () => [], agentNames: async () => new Map(), isRunning: async () => true }),
    };
    homes.set(p.id, h);
    byUid.set(p.uid, h);
    routines.setTimezone(p.uid, p.tz);
  }

  const teamOf = (h: Home): AgentSpec[] => [
    { agentId: "admin", name: h.p.adminName, description: "管理员", instructions: "", models: [], tools: [] as AgentToolAllow[], tier: 0 as AgentTier, domain: "admin" },
    ...h.writer.specs(h.ws).map((a) => ({ ...a, tier: (a.tier ?? 1) as AgentTier, ...(a.domain !== undefined ? { domain: a.domain } : {}) })),
  ];

  const adapterFor = (h: Home, sessionId: string, agentId: string): ModelAdapter => {
    const inner = createHostedRuntimeAdapter({ edgeBase: o.edgeBase, runtimeSecret: o.runtimeSecret, probe, routeMemo: createRouteMemo(), ownerUid: o.payer, workspaceId: o.payerWs, sessionId, agentId, preferredModels: () => [] });
    return {
      get model() { return inner.model; },
      ...(inner.prepare ? { prepare: () => inner.prepare!() } : {}),
      async chat(messages, tools, onDelta, signal, onRestart) {
        const t0 = Date.now();
        const r = await inner.chat(messages, tools, onDelta, signal, onRestart);
        calls.push({
          home: h.p.id, sessionId, agentId, ms: Date.now() - t0, promptTokens: r.usage?.promptTokens ?? 0, completionTokens: r.usage?.completionTokens ?? 0,
          tools: (tools ?? []).map((t) => t.name), toolCalls: (r.toolCalls ?? []).map((c) => ({ name: c.name, args: c.args })),
        });
        return r;
      },
    };
  };

  const hub = createSeatHub({
    group: async (ref) => groups.get(ref.sessionId) ?? null,
    seat: async (uid, ref) => {
      const h = byUid.get(uid);
      if (h === undefined) return "TA 还没有主场";
      const hit = h.seats.get(ref.sessionId);
      if (hit !== undefined) return hit;
      const sid = `seat-${h.p.id}-${ref.sessionId}`;
      const title = groupTitles.get(ref.sessionId) ?? "";
      h.store.append({ sessionId: sid, ts: Date.now(), type: "session_created", workspace: "/work", cloud: { workspaceId: h.ws, chat: { kind: "seat" }, seat: { groupWorkspaceId: ref.workspaceId, groupSessionId: ref.sessionId, ownerName: h.p.name, groupTitle: title }, home: true } });
      h.store.append({ sessionId: sid, ts: Date.now(), type: "chat_roster_changed", ignorable: true, agents: [{ agentId: "admin", name: h.p.adminName }] });
      const s = open(h, sid, `${h.p.name} 的群座位`, "seat");
      h.seats.set(ref.sessionId, s);
      return s;
    },
    log: (m) => log.push(m),
  });

  // 车道桥（ADR-0358）：A 的智能体 → B 主场里公开给 A 的那条车道
  const laneBridge = createLaneBridge({
    findPeerLane: async (peerUid, ownerUid) => {
      const ph = byUid.get(peerUid);
      const owner = byUid.get(ownerUid);
      const lane = ph !== undefined && owner !== undefined ? ph.lanes.get(owner.p.id) : undefined;
      return lane !== undefined && lane.facing === "both" ? { workspaceId: ph!.ws, sessionId: lane.sid } : null;
    },
    openLane: async (_ws, sid) => {
      const r = rooms.get(sid);
      if (r === undefined) return null;
      const h = homes.get(r.home)!;
      return {
        isGuest: (u) => r.room.isGuest(u),
        roster: async () => (r.room.chat()?.agentIds ?? []).map((id) => ({ agentId: id, name: teamOf(h).find((a) => a.agentId === id)?.name ?? id })),
        say: (fromUid, label, text, mentions, relay) => r.room.say(fromUid, label, text, true, mentions, undefined, undefined, undefined, undefined, relay),
      };
    },
    labelOf: async (uid) => nameOf(uid),
    now: () => Date.now(),
    log: (m) => log.push(m),
  });

  // 管理员车道的桥（#1605）：同 daemon 的 adminsBridge
  const adminsBridge: AdminsBridge = {
    async deliverRequest({ ownerUid, peerUid, event, origin }) {
      const ph = byUid.get(peerUid);
      if (ph === undefined) return "对方还没有主场，送不过去";
      const room = ensureAdmins(ph, ownerUid);
      room.receiveCollabRequest({ ...event, origin });
      return null;
    },
    async deliverBack({ origin, fromUid, event, reply }) {
      const r = rooms.get(origin.sessionId);
      if (r === undefined) { log.push(`协作的回话送不回去：${origin.sessionId}`); return; }
      if (event !== undefined) r.room.receiveCollabDecision(event);
      if (reply !== undefined) r.room.receiveCollabReply({ fromUid, ...reply });
    },
  };
  function ensureAdmins(h: Home, peerUid: string): CloudSession {
    const hit = h.admins.get(peerUid);
    if (hit !== undefined) return hit.room;
    const peer = byUid.get(peerUid)!;
    const sid = `admins-${h.p.id}-${peer.p.id}`;
    h.store.append({ sessionId: sid, ts: Date.now(), type: "session_created", workspace: "/work", cloud: { workspaceId: h.ws, chat: { kind: "admins" }, admins: { ownerName: h.p.name, peerUid, peerName: peer.p.name }, home: true } });
    h.store.append({ sessionId: sid, ts: Date.now(), type: "chat_roster_changed", ignorable: true, agents: [{ agentId: "admin", name: h.p.adminName }], humans: [{ uid: peerUid, name: peer.p.name }] });
    const room = open(h, sid, `${h.p.name} 家的管理员车道（对 ${peer.p.name}）`, "admins");
    h.admins.set(peerUid, { sid, room });
    return room;
  }
  function ensureLane(h: Home, peer: Home, facing: "self" | "both"): CloudSession {
    const hit = h.lanes.get(peer.p.id);
    if (hit !== undefined) {
      if (hit.facing !== facing) {
        hit.facing = facing;
        void hit.room.updateChatRoster(h.p.uid, { humans: facing === "both" ? [{ uid: peer.p.uid, name: peer.p.name }] : [] }, h.p.name);
      }
      return hit.room;
    }
    const sid = `lane-${h.p.id}-${peer.p.id}`;
    h.store.append({ sessionId: sid, ts: Date.now(), type: "session_created", workspace: "/work", cloud: { workspaceId: h.ws, chat: { kind: "pair" }, pair: { ownerName: h.p.name, peerUid: peer.p.uid, peerName: peer.p.name, facing }, home: true } });
    h.store.append({ sessionId: sid, ts: Date.now(), type: "chat_roster_changed", ignorable: true, agents: [{ agentId: "admin", name: h.p.adminName }], humans: facing === "both" ? [{ uid: peer.p.uid, name: peer.p.name }] : [] });
    const room = open(h, sid, `${h.p.name} 和 ${peer.p.name} 私聊旁的车道`, "pair");
    h.lanes.set(peer.p.id, { sid, room, facing });
    return room;
  }
  function ensureDm(h: Home): CloudSession {
    if (h.dm !== null) return h.dm;
    h.store.append({ sessionId: DM_SID(h.p.id), ts: Date.now(), type: "session_created", workspace: "/work", cloud: { workspaceId: h.ws, chat: { kind: "dm" }, home: true } });
    h.store.append({ sessionId: DM_SID(h.p.id), ts: Date.now(), type: "chat_roster_changed", ignorable: true, agents: [{ agentId: "admin", name: h.p.adminName }] });
    h.dm = open(h, DM_SID(h.p.id), `${h.p.name} ↔ ${h.p.adminName}（私聊）`, "dm");
    return h.dm;
  }

  function open(h: Home, sessionId: string, label: string, kind: string, store: EventStore = h.store): CloudSession {
    const room = createCloudSession({
      diskUsage: () => null, routines, onOutreachEnded: null, signSpeechTicket: async () => "t", outreach: null, callback: null,
      approveAll: true, sessionMeta: createInMemoryCloudSessionMeta(),
      workspaceId: h.ws, sessionId, ownerUid: h.p.uid, createdByUid: h.p.uid,
      store, world: h.box.world, px: { edgeBase: o.edgeBase, runtimeSecret: o.runtimeSecret }, hostUids: async () => [h.p.uid],
      agents: async () => teamOf(h),
      adapterFor: (a) => adapterFor(h, sessionId, a.agentId),
      onEvent: () => {}, onUsage: () => {},
      wiki: h.wiki,
      mentionInbox: createInMemoryMentionInbox(), agentWriter: h.writer,
      isMember: async () => true, contextWindowOf: () => 128_000, sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
      seatHub: hub,
      laneBridge,
      adminsBridge,
      webSearchKey: () => process.env["ANYSEARCH_API_KEY"] ?? BUILTIN_ANYSEARCH_KEY,
      // 出图：同 daemon，钱记在付款账号头上（模拟里所有人共用一个真账号）
      imageGen: (() => {
        const route = async (agentId?: string) => decideRuntimeImageRoute({
          me: await probe.me(o.payer), edgeBase: o.edgeBase, runtimeSecret: o.runtimeSecret, ownerUid: o.payer, workspaceId: o.payerWs, sessionId,
          ...(agentId !== undefined ? { agentId } : {}),
        });
        return { ready: async () => !("blocked" in (await route())), resolve: (agentId: string) => route(agentId) };
      })(),
      toolImages: imagesFor(h.ws),
      // 文件（#1683）：同 daemon——做文件 / 读文件 / 发文件三把刀，人发来的文件收下转字
      documents: { fonts, toText },
      media: (refs) => intake.intake(h.ws, sessionId, refs),
      // 好友名单（#1683：私聊里按名字找朋友的管理员）：模拟里人人互为好友
      friendsOf: async (uid) => [...homes.values()].filter((x) => x.p.uid !== uid).map((x) => ({ uid: x.p.uid, name: x.p.name })),
      peerTier: async (peerUid) => h.p.tiers?.[byUid.get(peerUid)?.p.id ?? ""] ?? "agents",
      // 朋友私聊的信封（ADR-0346）：同 daemon，最新的在前
      pairMessages: async ({ ownerUid, peerUid }) =>
        friendDM.filter((m) => (m.sender === ownerUid && m.recipient === peerUid) || (m.sender === peerUid && m.recipient === ownerUid)).slice(-40).reverse(),
      alert: (...a: unknown[]) => void alerts.push(a),
      ringTimers: { setTimer: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimer: () => {} },
      // message_friend：写进两人之间的私聊（线上就是 messages 表，带「代发」前缀）
      friendMessage: {
        send: async ({ agentName, friend, text }) => {
          const target = [...homes.values()].find((x) => x.p.name.toLowerCase() === friend.toLowerCase() || x.p.name.split(" ")[0]!.toLowerCase() === friend.trim().toLowerCase());
          if (target === undefined || target.p.uid === h.p.uid) return `好友里没有叫「${friend}」的，发不出去。`;
          friendDM.push({ sender: h.p.uid, recipient: target.p.uid, body: `[${agentName} 代发] ${text}`, createdAt: new Date().toISOString() });
          return `已经发给 ${target.p.name} 了，对方手机会收到通知。`;
        },
      },
    });
    rooms.set(sessionId, { room, store, label, home: h.p.id, kind });
    return room;
  }

  async function chatModel(sessionTag: string, sys: string, user: string): Promise<string> {
    personaCalls += 1;
    const adapter = createHostedRuntimeAdapter({ edgeBase: o.edgeBase, runtimeSecret: o.runtimeSecret, probe, routeMemo: createRouteMemo(), ownerUid: o.payer, workspaceId: o.payerWs, sessionId: sessionTag, agentId: "persona", preferredModels: () => [] });
    const r = await adapter.chat([{ role: "system", content: sys }, { role: "user", content: user }], []);
    return r.content;
  }

  /** 扮演一个人：读最近几句 + 这一步要干什么，回他会发的那一句 */
  async function personaLine(p: PersonaDef, context: string[], goal: string, hint: string): Promise<string> {
    const sys =
      `You are role-playing a real person in a messaging app. Stay fully in character.\n${p.bio}\n` +
      `Write like a real person texting: casual, short (usually 1-2 sentences), your own slang/abbreviations, occasional typos, emojis only if it fits you. ` +
      `Never sound like a customer-service bot. Never explain that you are role-playing. Output ONLY the message text, nothing else.\n` +
      // #1683 亚洲用户：bio 是母语写的、目标有时是母语有时是英文（公司群），说哪种语言照这一句判
      `Write in the language this person would naturally use in this chat (your bio says what you speak; a goal written in your own language means write in it; work group chats with foreign colleagues are in English).\n${hint}`;
    const user = `Recent chat (oldest first):\n${context.slice(-25).join("\n") || "(nothing yet)"}\n\nWhat you want to do in your next message: ${goal}`;
    return (await chatModel(`persona-${p.id}`, sys, user)).replace(/^["'“]|["'”]$/g, "").trim();
  }

  async function personaDecides(p: PersonaDef, card: string, context: string[]): Promise<{ accept: boolean; why: string; note: string }> {
    const sys = `You are ${p.name}. ${p.bio}\nYour attitude about other people using your AI assistant: ${p.privacy}\nAnswer with JSON only: {"accept": true|false, "why": "<short reason in your voice>", "note": "<optional short instruction to your assistant, or empty>"}`;
    const user = `Recent chat:\n${context.slice(-15).join("\n")}\n\nYour phone shows a request card: ${card}. Accept or decline?`;
    const raw = await chatModel(`persona-${p.id}`, sys, user);
    try {
      const j = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? "{}") as { accept?: unknown; why?: unknown; note?: unknown };
      return { accept: j.accept === true, why: typeof j.why === "string" ? j.why : "", note: typeof j.note === "string" ? j.note.slice(0, 200) : "" };
    } catch {
      return { accept: false, why: "(没读懂回答，按不接)", note: "" };
    }
  }

  const totalEvents = (): number => {
    let n = 0;
    for (const [sid, r] of rooms) n += r.store.load(sid).length;
    return n;
  };
  async function settle(capMs = 8 * 60_000): Promise<void> {
    const t0 = Date.now();
    let quiet = 0;
    while (Date.now() - t0 < capMs) {
      const before = totalEvents();
      await new Promise((r) => setTimeout(r, 1200));
      for (const r of rooms.values()) await r.room.settled();
      quiet = totalEvents() === before ? quiet + 1 : 0;
      if (quiet >= 2) return;
    }
    log.push(`settle 超时（${capMs}ms）`);
  }

  /** 一条对话里的事件 → 人看得懂的一行 */
  function lineOf(e: SessionEvent, where: string, roomHome: string): TranscriptLine | null {
    const h = homes.get(roomHome);
    const att = (fs: readonly { name: string }[] | undefined): string => (fs !== undefined && fs.length > 0 ? `\n📎 ${fs.map((f) => f.name).join("、")}` : "");
    if (e.type === "chat_message") {
      if (e.mirror !== undefined) return null;
      return { kind: e.fromUid === "system" ? "system" : "human", where, who: e.fromUid === "system" ? "system" : e.label, text: e.content + att(e.files), ts: e.ts };
    }
    if (e.type === "user_message") {
      if (e.mirror !== undefined || e.relay !== undefined && where.includes("座位")) return null;
      // 接力的系统话、对面管理员的回话（带 relay）不是人说的：系统话算 system，对面管理员按它的名字算智能体（#1683：
      // 原来算成人话，英文私聊里一串中文系统话把「这是英文对话」的判断冲掉了，专员冒中文没被查出来）
      if (e.relay !== undefined || /^\[系统\]/.test(e.content)) {
        const p = /^\[([^\]]+)\]:\s*/.exec(e.content);
        return p !== null && p[1] !== "系统"
          ? { kind: "agent", where, who: p[1]!, text: e.content.slice(p[0].length), ts: e.ts }
          : { kind: "system", where, who: "system", text: e.content.slice(0, 200), ts: e.ts };
      }
      if (e.greeting !== undefined) return { kind: "system", where, who: `[${e.greeting}]`, text: e.content.slice(0, 400), ts: e.ts };
      return { kind: "human", where, who: nameOf(e.fromUid ?? ""), text: e.content.replace(/^\[[^\]]*\]:\s*/, "") + att(e.files), ts: e.ts };
    }
    if (e.type === "tool_result" && e.status === "ok" && e.files !== undefined && e.files.length > 0 && !where.includes("座位")) {
      return { kind: "agent", where, who: "📎", text: `file: ${e.files.map((f) => f.name).join(", ")}`, ts: e.ts };
    }
    if (e.type === "assistant_message" && e.files !== undefined && e.files.length > 0 && e.content.trim() === "") {
      return { kind: "agent", where, who: "📎", text: `file: ${e.files.map((f) => f.name).join(", ")}`, ts: e.ts };
    }
    if (e.type === "assistant_message" && e.content.trim() !== "" && e.ack === undefined) {
      if (e.agentId !== undefined && seatUidOf(e.agentId) !== null) {
        const sh = byUid.get(seatUidOf(e.agentId)!);
        const who = e.worker !== undefined ? `${e.worker.name}（${sh?.p.name ?? "?"}的专员）` : sh !== undefined ? seatLabel({ name: sh.p.name, agentName: sh.p.adminName }) : e.agentId;
        return { kind: "agent", where, who, text: e.content + att(e.files), ts: e.ts };
      }
      const name = teamOf(h!).find((a) => a.agentId === e.agentId)?.name ?? e.agentId ?? "?";
      return { kind: "agent", where, who: `${name}（${h?.p.name ?? "?"}的${e.agentId === "admin" ? "管理员" : "专员"}）`, text: e.content + att(e.files), ts: e.ts };
    }
    if (e.type === "seat_request") return { kind: "card", where, who: e.agentName, text: `${e.fromName} → ${e.agentName}：${e.summary}`, ts: e.ts };
    if (e.type === "seat_decision") return { kind: "decision", where, who: "", text: e.decision + (e.note ? `（附言：${e.note}）` : ""), ts: e.ts };
    if (e.type === "collab_request") return { kind: "card", where, who: e.fromAgentName, text: `协作请求「${e.title}」：${e.quote.note}`, ts: e.ts };
    if (e.type === "collab_decision") return { kind: "decision", where, who: "", text: `协作：${e.decision}${e.via ? `（${e.via}）` : ""}`, ts: e.ts };
    if (e.type === "approval_request") return { kind: "system", where, who: "[审批卡]", text: `${e.toolName} 等 ${nameOf(e.initiatorUid)} 那边的主人批`, ts: e.ts };
    return null;
  }

  const ctxOf = (sid: string): string[] => {
    const r = rooms.get(sid);
    if (r === undefined) return [];
    return r.store.load(sid).flatMap((e) => { const l = lineOf(e, r.label, r.home); return l !== null ? [`${l.who}: ${l.text}`] : []; });
  };
  const dmCtx = (a: string, b: string): string[] =>
    friendDM.filter((m) => (m.sender === a && m.recipient === b) || (m.sender === b && m.recipient === a)).map((m) => `${nameOf(m.sender)}: ${m.body}`);

  /** 管理员车道里还没答的协作请求：那一家的主人按人设决定 */
  async function handleCollab(): Promise<void> {
    for (let round = 0; round < 3; round++) {
      let any = false;
      for (const h of homes.values()) {
        for (const { sid, room } of h.admins.values()) {
          const log0 = rooms.get(sid)!.store.load(sid);
          const done = new Set(log0.filter((e) => e.type === "collab_decision").map((e) => (e as { requestId: string }).requestId));
          for (const e of log0) {
            if (e.type !== "collab_request" || done.has(e.requestId)) continue;
            any = true;
            const d = await personaDecides(h.p, `"${e.quote.ownerName}'s assistant ${e.fromAgentName} asks your assistant to help with: ${e.title} — ${e.quote.note}"`, ctxOf(sid));
            log.push(`[协作卡] ${h.p.name} ${d.accept ? "接" : "不接"}「${e.title}」——${d.why}`);
            await room.decideCollab(e.requestId, h.p.uid, d.accept ? "accepted" : "declined");
          }
        }
      }
      if (!any) return;
      await settle();
    }
  }

  return {
    homes, calls, alerts, timers, routines, friendDM, log,
    get personaCalls() { return personaCalls; },
    async setupAgents(p) {
      const h = homes.get(p.id)!;
      const dm = ensureDm(h);
      for (const want of p.wantsAgents ?? []) {
        const before = h.writer.specs(h.ws).length;
        for (let round = 0; round < 3 && h.writer.specs(h.ws).length === before; round++) {
          const goal = round === 0 ? want : `Answer your assistant's questions briefly with realistic details from your life, and tell it to go ahead and create the agent now. (Your original ask: ${want})`;
          const text = await personaLine(p, ctxOf(DM_SID(p.id)), goal, `You're in a private 1:1 chat with your own AI assistant "${p.adminName}" (it can set up specialist AI agents for you).`);
          await dm.say(p.uid, p.name, text, true, ["admin"], undefined, undefined, undefined, undefined, undefined, p.tz);
          await settle();
        }
      }
    },
    async runScenario(sc) {
      const startedAt = Date.now();
      const startSeq = new Map<string, number>();
      for (const [sid, r] of rooms) startSeq.set(sid, r.store.load(sid).at(-1)?.seq ?? -1);
      const dmStart = friendDM.length;
      /** 这一场之前就有的定时任务（建专员那一段定的）不在这一场里触发 */
      const routinesBefore = new Set(routines.rows().map((r) => r.id));
      let gid: string | null = null;
      let gstore: EventStore | null = null;
      let group: CloudSession | null = null;
      if (sc.groupTitle !== undefined && sc.owner !== undefined) {
        gid = `g-${sc.id}`;
        gstore = new EventStore(join(tempDir(`otto-sim-g-${sc.id}-`), "g.db"));
        groupStores.set(gid, gstore);
        groupTitles.set(gid, sc.groupTitle);
        const owner = homes.get(sc.owner)!;
        const people = [sc.owner, ...(sc.members ?? []).filter((m) => m !== sc.owner)].map((id) => homes.get(id)!.p);
        const seats0: GroupSeat[] = people.map((p) => ({ uid: p.uid, name: p.name, agentName: p.adminName }));
        gstore.append({ sessionId: gid, ts: Date.now(), type: "session_created", workspace: "/work", cloud: { workspaceId: owner.ws, chat: { kind: "group" }, home: true } });
        gstore.append({ sessionId: gid, ts: Date.now(), type: "chat_roster_changed", ignorable: true, agents: [], humans: seats0.slice(1).map((x) => ({ uid: x.uid, name: x.name })), seats: seats0, groupOwnerUid: owner.p.uid });
        group = open(owner, gid, `群「${sc.groupTitle}」`, "group", gstore);
        groups.set(gid, group);
        startSeq.set(gid, -1);
      }
      const seatsNow = (): GroupSeat[] => (gstore !== null && gid !== null ? groupSeatsOf(gstore.load(gid)) ?? [] : []);
      const decided = new Set<string>();

      const handleCards = async (): Promise<void> => {
        if (gstore === null || gid === null || group === null) return;
        for (let round = 0; round < 4; round++) {
          const pending = [...seatCardsOf(gstore.load(gid)).values()].filter((c) => c.state === "pending" && !decided.has(c.requestId));
          if (pending.length === 0) return;
          for (const c of pending) {
            decided.add(c.requestId);
            const h = byUid.get(c.seatUid)!;
            const d = await personaDecides(h.p, `"${c.fromName} wants your assistant ${c.agentName} to do something: ${c.summary}" (their original message: "${c.ask}")`, ctxOf(gid));
            log.push(`[卡] ${h.p.name} ${d.accept ? "接" : "不接"}「${c.summary.slice(0, 60)}」——${d.why}${d.note ? `（附言：${d.note}）` : ""}`);
            await group.decideSeat!(c.requestId, h.p.uid, d.accept ? "accepted" : "declined", d.note !== "" ? d.note : undefined);
          }
          await settle();
        }
      };

      for (const b of sc.beats) {
        if (b.kind === "say" && group !== null && gid !== null) {
          const p = homes.get(b.who)!.p;
          const seats = seatsNow();
          const handles = seatHandles(seats);
          const mine = seats.find((s) => s.uid === p.uid);
          const others = seats.filter((s) => s.uid !== p.uid);
          const hint =
            `Group chat "${sc.groupTitle}". Members: ${seats.map((s) => s.name).join(", ")}. Everyone has their own AI assistant in the group. ` +
            `Your own assistant is "${mine?.agentName}" (tag it as @${handles.get(p.uid)}). Other people's assistants: ${others.map((s) => `@${handles.get(s.uid)} (${s.name}'s)`).join(", ")}. ` +
            (b.at !== undefined && b.at.length > 0
              ? `In this message you MUST tag: ${b.at.map((id) => `@${handles.get(homes.get(id)!.p.uid) ?? homes.get(id)!.p.adminName}`).join(" ")}.`
              : `Do NOT tag any assistant in this message, you're just talking to the humans.`);
          const text = await personaLine(p, ctxOf(gid), b.goal, hint + fileHint(b.file));
          const at = (b.at ?? []).map((id) => seatAgentId(homes.get(id)!.p.uid));
          try {
            const media = b.file !== undefined ? [await humanFile(homes.get(sc.owner!)!.ws, gid, b.file)] : undefined;
            await group.say(p.uid, p.name, text, at.length > 0, at, undefined, undefined, undefined, media, undefined, p.tz);
          } catch (err) {
            log.push(`[发不出去] ${sc.id} ${p.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
          await settle();
          if (b.cards !== "ignore") await handleCards();
          await handleCollab();
        } else if (b.kind === "policy" && group !== null) {
          const p = homes.get(b.who)!.p;
          group.setSeatPolicy!(p.uid, p.name, b.policy);
        } else if (b.kind === "leave" && group !== null) {
          const p = homes.get(b.who)!.p;
          group.leaveGroup!(p.uid, p.name);
        } else if (b.kind === "invite" && group !== null) {
          const p = homes.get(b.who)!.p;
          const cur = seatsNow();
          const add = b.add.map((id) => homes.get(id)!.p);
          await group.updateChatRoster(p.uid, { seatPeople: [...cur.map((s) => ({ uid: s.uid, name: s.name, agentName: s.agentName })), ...add.map((x) => ({ uid: x.uid, name: x.name, agentName: x.adminName }))] }, p.name);
        } else if (b.kind === "fire_timers") {
          for (const t of timers.splice(0)) t();
          await settle();
        } else if (b.kind === "dm_admin") {
          const h = homes.get(b.who)!;
          const dm = ensureDm(h);
          const text = await personaLine(h.p, ctxOf(DM_SID(h.p.id)), b.goal, `You're in your private 1:1 chat with your own AI assistant "${h.p.adminName}". It can look things up online, set reminders, keep lists and notes, make documents (PDF, Word, Excel, slides), message your friends, and remember what you told it.` + fileHint(b.file));
          const media = b.file !== undefined ? [await humanFile(h.ws, DM_SID(h.p.id), b.file)] : undefined;
          await dm.say(h.p.uid, h.p.name, text, true, ["admin"], undefined, undefined, undefined, media, undefined, h.p.tz);
          await settle();
          await handleCollab();
        } else if (b.kind === "friend_dm") {
          const a = homes.get(b.who)!;
          const z = homes.get(b.to)!;
          const text = await personaLine(a.p, dmCtx(a.p.uid, z.p.uid), b.goal, `You're texting ${z.p.name} directly (a normal 1:1 chat between two humans, no assistants involved).`);
          friendDM.push({ sender: a.p.uid, recipient: z.p.uid, body: text, createdAt: new Date().toISOString() });
        } else if (b.kind === "lane") {
          const owner = homes.get(b.owner)!;
          const peer = homes.get(b.peer)!;
          const speaker = homes.get(b.speaker)!;
          const lane = ensureLane(owner, peer, b.facing);
          const sid = owner.lanes.get(peer.p.id)!.sid;
          const own = speaker.p.id === owner.p.id;
          const hint = own
            ? `You're chatting 1:1 with your friend ${peer.p.name}; your own AI assistant "${owner.p.adminName}" sits beside that chat (${b.facing === "both" ? `${peer.p.name} can see it too` : "only you can see it"}). It can read your recent messages with ${peer.p.name}. Tag it as @${owner.p.adminName}. Recent DMs with ${peer.p.name}:\n${dmCtx(owner.p.uid, peer.p.uid).slice(-8).join("\n")}`
            : `${owner.p.name} made their AI assistant "${owner.p.adminName}" visible in your 1:1 chat with them. Tag it as @${owner.p.adminName}. Recent DMs:\n${dmCtx(owner.p.uid, speaker.p.uid).slice(-8).join("\n")}`;
          const text = await personaLine(speaker.p, ctxOf(sid), b.goal, hint + fileHint(b.file));
          try {
            const media = b.file !== undefined ? [await humanFile(owner.ws, sid, b.file)] : undefined;
            await lane.say(speaker.p.uid, speaker.p.name, text, true, ["admin"], undefined, undefined, undefined, media, undefined, speaker.p.tz);
          } catch (err) {
            log.push(`[发不出去] ${sc.id} ${speaker.p.name}（车道）: ${err instanceof Error ? err.message : String(err)}`);
          }
          await settle();
          await handleCollab();
        } else if (b.kind === "fire_routines") {
          const who = new Set((b.who ?? []).map((id) => homes.get(id)!.p.uid));
          // 只触发这一场里定的、接下来 8 天内该响的，按时刻先后、一条一条跑完再下一条：
          // 把下周的提醒「现在」就触发，模型看见「此刻」与开场白的时刻对不上，会说「提醒响早了」（模拟自己造的假象）
          const now = Date.now();
          const due = routines.rows()
            .filter((r) => r.enabled && !routinesBefore.has(r.id) && (who.size === 0 || who.has(r.ownerUid)) && r.nextRunAt !== null && r.nextRunAt - now < 8 * 86_400_000)
            .sort((x, y) => (x.nextRunAt ?? 0) - (y.nextRunAt ?? 0));
          for (const r of routines.rows()) {
            if (r.enabled && !routinesBefore.has(r.id) && !due.includes(r) && (who.size === 0 || who.has(r.ownerUid))) log.push(`[已定、未到点] ${nameOf(r.ownerUid)}「${r.title}」${JSON.stringify(r.schedule)} ${r.tz}`);
          }
          for (const r of due) {
            const res = await runRoutineInRoom({
              homeOwnerOf: async (w) => [...homes.values()].find((x) => x.ws === w)?.p.uid ?? null,
              findDm: async (w) => { const x = [...homes.values()].find((y) => y.ws === w); return x?.dm !== null && x !== undefined ? DM_SID(x.p.id) : null; },
              room: async (_w, sid) => rooms.get(sid)?.room ?? null,
            }, r, r.nextRunAt ?? Date.now());
            log.push(`[到点] ${nameOf(r.ownerUid)}「${r.title}」→ ${res}（${r.sessionId ? "座位" : "私聊"}）`);
            await routines.setStatus(r.id, "done", r.schedule.kind === "once" ? false : true);
            await settle();
          }
          await settle();
        }
      }
      await settle();

      // 收账：这一场每条对话的新增
      const logs: ScenarioResult["logs"] = {};
      const everywhere: TranscriptLine[] = [];
      for (const [sid, r] of rooms) {
        const from = startSeq.get(sid) ?? -1;
        const events = r.store.load(sid).filter((e) => e.seq > from);
        if (events.length === 0) continue;
        logs[r.label] = { home: r.home, kind: r.kind, events };
        for (const e of events) { const l = lineOf(e, r.label, r.home); if (l !== null) everywhere.push(l); }
      }
      // 这一场出现过的文件（#1683）：人发的（带着收下时转好的字）、智能体交出来的（从假的 Storage 取回来读一遍）
      const files: ProducedFile[] = [];
      for (const [sid, r] of rooms) {
        const from = startSeq.get(sid) ?? -1;
        const ws = homes.get(r.home)!.ws;
        let lastAgent = "";
        for (const e of r.store.load(sid)) {
          if (e.seq <= from) continue;
          if (e.type === "assistant_message" && (e.toolCalls ?? []).length > 0) {
            lastAgent = teamOf(homes.get(r.home)!).find((a) => a.agentId === e.agentId)?.name ?? e.agentId ?? "?";
          }
          if ((e.type === "user_message" || e.type === "chat_message") && e.files !== undefined && e.mirror === undefined) {
            for (const f of e.files) files.push({ where: r.label, by: nameOf(e.fromUid ?? ""), name: f.name, mediaType: f.mediaType, bytes: f.bytes, fromHuman: true, text: (f.text ?? f.textError ?? "").slice(0, 3000), ts: e.ts });
          }
          if (e.type === "tool_result" && e.files !== undefined) {
            for (const f of e.files) {
              const data = storage.get(`${CHAT_MEDIA_BUCKET}/${chatMediaPath(ws, sid, f.id.slice(7), f.mediaType)}`);
              let text = "";
              if (data !== undefined) {
                try {
                  text = f.mediaType.startsWith("text/") ? new TextDecoder().decode(data) : await toText(data);
                } catch (err) {
                  text = `（读不回来：${err instanceof Error ? err.message : String(err)}）`;
                }
              } else text = "（Storage 里没有这份）";
              files.push({ where: r.label, by: `${lastAgent}（${homes.get(r.home)!.p.name}家）`, name: f.name, mediaType: f.mediaType, bytes: f.bytes, fromHuman: false, text: text.slice(0, 4000), ts: e.ts });
            }
          }
        }
      }
      for (const m of friendDM.slice(dmStart)) {
        everywhere.push({ kind: "human", where: `${nameOf(m.sender)} ↔ ${nameOf(m.recipient)}（朋友私聊）`, who: nameOf(m.sender), text: m.body, ts: Date.parse(m.createdAt) });
      }
      everywhere.sort((a, b) => a.ts - b.ts);
      const groupLog = gstore !== null && gid !== null ? gstore.load(gid) : [];
      const transcript = everywhere.filter((l) => gid !== null && l.where === rooms.get(gid)?.label);
      return { scenario: sc, transcript, everywhere, logs, groupLog, seats: knownSeatsOf(groupLog), files, startedAt, endedAt: Date.now() };
    },
    async destroy() {
      for (const h of homes.values()) {
        await h.box.destroy();
        h.store.close();
      }
      for (const st of groupStores.values()) st.close();
    },
  };
}

/** 日志里出现过的每个座位（含已经走了的） */
function knownSeatsOf(events: readonly SessionEvent[]): GroupSeat[] {
  const m = new Map<string, GroupSeat>();
  for (const e of events) if (e.type === "chat_roster_changed" && e.seats) for (const s of e.seats) m.set(s.uid, s);
  return [...m.values()];
}
