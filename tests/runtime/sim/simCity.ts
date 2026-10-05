// 群聊模拟（#1682）：一座「城」——每个模拟用户一个主场（真沙箱容器、自己的管理员、自己建的专员、和管理员的私聊），
// 群与座位跑线上同一份 sessionService / seatHub。人说的话由另一个模型按人设生成；点头卡也由那个人的人设来决定。
// 模型一律走线上网关（真钱，记在 OTTO_LIVE_OWNER 名下）。只给 *.live.test.ts 用。
import { join } from "node:path";
import { createCloudSession, type AgentSpec, type CloudSession } from "../../../services/runtime/src/sessionService.js";
import { createSeatHub } from "../../../services/runtime/src/seatHub.js";
import { createHostedProbe, createHostedRuntimeAdapter, createRouteMemo, type HostedProbe } from "../../../services/runtime/src/hostedRoute.js";
import { createWikiService } from "../../../services/runtime/src/wikiService.js";
import { createMemoryWikiFs } from "../../../services/runtime/src/wikiFs.js";
import { createInMemoryWikiJournal } from "../../../services/runtime/src/wikiJournal.js";
import { createInMemoryRoutineStore } from "../../../services/runtime/src/routineStore.js";
import { createInMemoryAgentWriter } from "../../../services/runtime/src/agentRegistry.js";
import { createInMemoryMentionInbox } from "../../../services/runtime/src/mentionInbox.js";
import { createWorkspaceLock } from "../../../services/runtime/src/workspaceLock.js";
import { createInMemoryCloudSessionMeta } from "../../../services/runtime/src/cloudSessionMeta.js";
import { EventStore } from "../../../src/session/store.js";
import type { SessionEvent } from "../../../src/session/events.js";
import type { ModelAdapter } from "../../../src/model/adapter.js";
import type { AgentTier } from "../../../src/shared/agentTier.js";
import type { AgentToolAllow } from "../../../src/shared/agentToolAllow.js";
import { groupSeatsOf, seatAgentId, seatCardsOf, seatHandles, seatLabel, seatUidOf, type GroupSeat } from "../../../src/shared/groupSeats.js";
import { tempDir } from "../../helpers/tempDir.js";
import { createSimBox, type SimBox } from "./simWorld.js";

export interface PersonaDef {
  id: string;
  uid: string;
  name: string;
  tz: string;
  adminName: string;
  /** 这个人是谁、怎么说话（给扮演他的模型读） */
  bio: string;
  /** 他对「别人使唤我的管理员」的态度（点头卡由它决定） */
  privacy: string;
  /** 他主场 /work 里有什么（真文件） */
  files: Record<string, string>;
  /** 他会让自己的管理员建哪些专员（他自己的话的要点） */
  wantsAgents?: string[];
}

export type Beat =
  | { kind: "say"; who: string; goal: string; at?: string[]; cards?: "persona" | "ignore" }
  | { kind: "policy"; who: string; policy: "ask" | "open" }
  | { kind: "leave"; who: string }
  | { kind: "invite"; who: string; add: string[] }
  | { kind: "fire_timers" };

export interface Scenario {
  id: string;
  title: string;
  /** 这场想验证什么（报告里写） */
  aim: string;
  groupTitle: string;
  owner: string;
  members: string[];
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
  box: SimBox;
  dm: CloudSession | null;
  seats: Map<string, CloudSession>;
}

const DM_SID = (id: string): string => `dm-${id}`;

export interface City {
  homes: Map<string, Home>;
  calls: Call[];
  alerts: unknown[][];
  timers: (() => void)[];
  routines: ReturnType<typeof createInMemoryRoutineStore>;
  friendMessages: { from: string; agent: string; friend: string; text: string }[];
  personaCalls: number;
  log: string[];
  setupAgents(p: PersonaDef): Promise<void>;
  runScenario(s: Scenario): Promise<ScenarioResult>;
  destroy(): Promise<void>;
}

export interface ScenarioResult {
  scenario: Scenario;
  transcript: { kind: "human" | "agent" | "system" | "card" | "decision"; who: string; text: string; ts: number }[];
  seatLogs: Record<string, SessionEvent[]>;
  groupLog: SessionEvent[];
  seats: GroupSeat[];
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
  const friendMessages: City["friendMessages"] = [];
  const groups = new Map<string, CloudSession>();
  const groupStores = new Map<string, EventStore>();
  const log: string[] = [];
  let personaCalls = 0;

  for (const p of o.personas) {
    const box = await createSimBox(`otto-sim-${p.id}`);
    await box.seed(p.files);
    const h: Home = { p, ws: `w-${p.id}`, store: new EventStore(join(tempDir(`otto-sim-${p.id}-`), "s.db")), writer: createInMemoryAgentWriter(), box, dm: null, seats: new Map() };
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
      const s = open(h, sid);
      h.seats.set(ref.sessionId, s);
      return s;
    },
    log: (m) => log.push(m),
  });
  const groupTitles = new Map<string, string>();

  function open(h: Home, sessionId: string, store: EventStore = h.store): CloudSession {
    return createCloudSession({
      diskUsage: () => null, routines, onOutreachEnded: null, signSpeechTicket: async () => "t", pairMessages: null, outreach: null, callback: null,
      approveAll: true, sessionMeta: createInMemoryCloudSessionMeta(),
      workspaceId: h.ws, sessionId, ownerUid: h.p.uid, createdByUid: h.p.uid,
      store, world: h.box.world, px: { edgeBase: o.edgeBase, runtimeSecret: o.runtimeSecret }, hostUids: async () => [h.p.uid],
      agents: async () => teamOf(h),
      adapterFor: (a) => adapterFor(h, sessionId, a.agentId),
      onEvent: () => {}, onUsage: () => {},
      wiki: createWikiService({ workspaceId: h.ws, fs: createMemoryWikiFs(), journal: createInMemoryWikiJournal(), legacyMemories: async () => [], agentNames: async () => new Map(teamOf(h).map((a) => [a.agentId, a.name] as const)), isRunning: async () => true }),
      mentionInbox: createInMemoryMentionInbox(), agentWriter: h.writer,
      isMember: async () => true, contextWindowOf: () => 128_000, sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
      seatHub: hub,
      alert: (...a: unknown[]) => void alerts.push(a),
      ringTimers: { setTimer: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimer: () => {} },
      friendMessage: {
        send: async ({ agentName, friend, text }) => {
          friendMessages.push({ from: h.p.name, agent: agentName, friend, text });
          return `已经发给 ${friend} 了（模拟：私聊里多了一条），对方手机会收到通知。`;
        },
      },
    });
  }

  /** 扮演一个人：读群里最近几句 + 这一步要干什么，回他会发的那一句 */
  async function personaLine(p: PersonaDef, context: string[], goal: string, hint: string): Promise<string> {
    personaCalls += 1;
    const h = homes.get(p.id)!;
    const adapter = createHostedRuntimeAdapter({ edgeBase: o.edgeBase, runtimeSecret: o.runtimeSecret, probe, routeMemo: createRouteMemo(), ownerUid: o.payer, workspaceId: o.payerWs, sessionId: `persona-${p.id}`, agentId: "persona", preferredModels: () => [] });
    void h;
    const sys =
      `You are role-playing a real person in a messaging app group chat. Stay fully in character.\n${p.bio}\n` +
      `Write like a real person texting friends: casual, short (usually 1-2 sentences), your own slang/abbreviations, occasional typos, emojis only if it fits you. ` +
      `Never sound like a customer-service bot. Never explain that you are role-playing. Output ONLY the message text, nothing else.\n${hint}`;
    const user = `Recent chat (oldest first):\n${context.slice(-25).join("\n") || "(nothing yet)"}\n\nWhat you want to do in your next message: ${goal}`;
    const r = await adapter.chat([{ role: "system", content: sys }, { role: "user", content: user }], []);
    return r.content.replace(/^["'“]|["'”]$/g, "").trim();
  }

  async function personaDecides(p: PersonaDef, card: { fromName: string; agentName: string; summary: string; ask: string }, context: string[]): Promise<{ accept: boolean; why: string }> {
    personaCalls += 1;
    const adapter = createHostedRuntimeAdapter({ edgeBase: o.edgeBase, runtimeSecret: o.runtimeSecret, probe, routeMemo: createRouteMemo(), ownerUid: o.payer, workspaceId: o.payerWs, sessionId: `persona-${p.id}`, agentId: "persona", preferredModels: () => [] });
    const sys = `You are ${p.name}. ${p.bio}\nYour attitude about other people using your AI assistant: ${p.privacy}\nAnswer with JSON only: {"accept": true|false, "why": "<short reason in your voice>"}`;
    const user = `Recent chat:\n${context.slice(-15).join("\n")}\n\nYour phone shows a request card: "${card.fromName} wants your assistant ${card.agentName} to do something: ${card.summary}" (their original message: "${card.ask}"). Accept or decline?`;
    const r = await adapter.chat([{ role: "system", content: sys }, { role: "user", content: user }], []);
    const m = /\{[\s\S]*\}/.exec(r.content);
    try {
      const j = JSON.parse(m?.[0] ?? "{}") as { accept?: unknown; why?: unknown };
      return { accept: j.accept === true, why: typeof j.why === "string" ? j.why : "" };
    } catch {
      return { accept: false, why: "(没读懂回答，按不接)" };
    }
  }

  const everyStore = (): EventStore[] => [...[...homes.values()].map((h) => h.store), ...groupStores.values()];
  const totalEvents = (): number => {
    let n = 0;
    for (const h of homes.values()) {
      for (const sid of [DM_SID(h.p.id), ...[...h.seats.keys()].map((g) => `seat-${h.p.id}-${g}`)]) n += h.store.load(sid).length;
    }
    for (const [sid, st] of groupStores) n += st.load(sid).length;
    return n;
  };
  async function settle(capMs = 8 * 60_000): Promise<void> {
    const t0 = Date.now();
    let quiet = 0;
    while (Date.now() - t0 < capMs) {
      const before = totalEvents();
      await new Promise((r) => setTimeout(r, 1200));
      const rooms = [...groups.values(), ...[...homes.values()].flatMap((h) => [...(h.dm ? [h.dm] : []), ...h.seats.values()])];
      for (const r of rooms) await r.settled();
      quiet = totalEvents() === before ? quiet + 1 : 0;
      if (quiet >= 2) return;
    }
    log.push(`settle 超时（${capMs}ms）`);
  }
  void everyStore;

  function render(groupId: string, seats: GroupSeat[]): string[] {
    const st = groupStores.get(groupId)!;
    const out: string[] = [];
    for (const e of st.load(groupId)) {
      if (e.type === "chat_message") out.push(`${e.fromUid === "system" ? "[system]" : e.label}: ${e.content}`);
      else if (e.type === "assistant_message" && e.agentId !== undefined) {
        const uid = seatUidOf(e.agentId);
        const s = seats.find((x) => x.uid === uid);
        out.push(`${s ? `${s.agentName} (${s.name}'s assistant)` : e.agentId}: ${e.content}`);
      }
    }
    return out;
  }

  return {
    homes, calls, alerts, timers, routines, friendMessages, log,
    get personaCalls() { return personaCalls; },
    async setupAgents(p) {
      const h = homes.get(p.id)!;
      if (h.dm === null) {
        h.store.append({ sessionId: DM_SID(p.id), ts: Date.now(), type: "session_created", workspace: "/work", cloud: { workspaceId: h.ws, chat: { kind: "dm" }, home: true } });
        h.store.append({ sessionId: DM_SID(p.id), ts: Date.now(), type: "chat_roster_changed", ignorable: true, agents: [{ agentId: "admin", name: p.adminName }] });
        h.dm = open(h, DM_SID(p.id));
      }
      for (const want of p.wantsAgents ?? []) {
        const ctx = h.store.load(DM_SID(p.id)).flatMap((e) =>
          e.type === "user_message" && e.greeting === undefined ? [`${p.name}: ${e.content.replace(/^\[[^\]]*\]:\s*/, "")}`]
            : e.type === "assistant_message" && e.content.trim() !== "" ? [`${p.adminName}: ${e.content}`] : []);
        // 管理员多半先反问细节：最多来回三次，答它的问题、让它动手建
        const before = h.writer.specs(h.ws).length;
        for (let round = 0; round < 3 && h.writer.specs(h.ws).length === before; round++) {
          const ctx2 = round === 0 ? ctx : h.store.load(DM_SID(p.id)).flatMap((e) =>
            e.type === "user_message" && e.greeting === undefined ? [`${p.name}: ${e.content.replace(/^\[[^\]]*\]:\s*/, "")}`]
              : e.type === "assistant_message" && e.content.trim() !== "" ? [`${p.adminName}: ${e.content}`] : []);
          const goal = round === 0 ? want : `Answer your assistant's questions briefly with realistic details from your life, and tell it to go ahead and create the agent now. (Your original ask: ${want})`;
          const text = await personaLine(p, ctx2, goal, `You're in a private 1:1 chat with your own AI assistant "${p.adminName}" (it can set up specialist AI agents for you).`);
          await h.dm.say(p.uid, p.name, text, true, ["admin"], undefined, undefined, undefined, undefined, undefined, p.tz);
          await settle();
        }
      }
    },
    async runScenario(sc) {
      const startedAt = Date.now();
      const gid = `g-${sc.id}`;
      const gstore = new EventStore(join(tempDir(`otto-sim-g-${sc.id}-`), "g.db"));
      groupStores.set(gid, gstore);
      groupTitles.set(gid, sc.groupTitle);
      const owner = homes.get(sc.owner)!;
      const people = [sc.owner, ...sc.members.filter((m) => m !== sc.owner)].map((id) => homes.get(id)!.p);
      const seats0: GroupSeat[] = people.map((p) => ({ uid: p.uid, name: p.name, agentName: p.adminName }));
      gstore.append({ sessionId: gid, ts: Date.now(), type: "session_created", workspace: "/work", cloud: { workspaceId: owner.ws, chat: { kind: "group" }, home: true } });
      gstore.append({ sessionId: gid, ts: Date.now(), type: "chat_roster_changed", ignorable: true, agents: [], humans: seats0.slice(1).map((x) => ({ uid: x.uid, name: x.name })), seats: seats0, groupOwnerUid: owner.p.uid });
      const group = open(owner, gid, gstore);
      groups.set(gid, group);
      const seatsNow = (): GroupSeat[] => groupSeatsOf(gstore.load(gid)) ?? [];
      const decided = new Set<string>();

      const handleCards = async (): Promise<void> => {
        for (let round = 0; round < 4; round++) {
          const pending = [...seatCardsOf(gstore.load(gid)).values()].filter((c) => c.state === "pending" && !decided.has(c.requestId));
          if (pending.length === 0) return;
          for (const c of pending) {
            decided.add(c.requestId);
            const h = byUid.get(c.seatUid)!;
            const d = await personaDecides(h.p, c, render(gid, seatsNow()));
            log.push(`[卡] ${h.p.name} ${d.accept ? "接" : "不接"}「${c.summary.slice(0, 60)}」——${d.why}`);
            await group.decideSeat!(c.requestId, h.p.uid, d.accept ? "accepted" : "declined");
          }
          await settle();
        }
      };

      for (const b of sc.beats) {
        if (b.kind === "say") {
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
          const text = await personaLine(p, render(gid, seats), b.goal, hint);
          const at = (b.at ?? []).map((id) => seatAgentId(homes.get(id)!.p.uid));
          try {
            await group.say(p.uid, p.name, text, at.length > 0, at, undefined, undefined, undefined, undefined, undefined, p.tz);
          } catch (err) {
            log.push(`[发不出去] ${p.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
          await settle();
          if (b.cards !== "ignore") await handleCards();
        } else if (b.kind === "policy") {
          const p = homes.get(b.who)!.p;
          group.setSeatPolicy!(p.uid, p.name, b.policy);
        } else if (b.kind === "leave") {
          const p = homes.get(b.who)!.p;
          group.leaveGroup!(p.uid, p.name);
        } else if (b.kind === "invite") {
          const p = homes.get(b.who)!.p;
          const cur = seatsNow();
          const add = b.add.map((id) => homes.get(id)!.p);
          await group.updateChatRoster(p.uid, { seatPeople: [...cur.map((s) => ({ uid: s.uid, name: s.name, agentName: s.agentName })), ...add.map((x) => ({ uid: x.uid, name: x.name, agentName: x.adminName }))] }, p.name);
        } else if (b.kind === "fire_timers") {
          for (const t of timers.splice(0)) t();
          await settle();
        }
      }
      await settle();
      const seats = knownSeatsOf(gstore.load(gid));
      const transcript: ScenarioResult["transcript"] = [];
      for (const e of gstore.load(gid)) {
        if (e.type === "chat_message") transcript.push({ kind: e.fromUid === "system" ? "system" : "human", who: e.fromUid === "system" ? "system" : e.label, text: e.content, ts: e.ts });
        else if (e.type === "assistant_message" && e.agentId !== undefined) {
          const s = seats.find((x) => x.uid === seatUidOf(e.agentId!));
          transcript.push({ kind: "agent", who: s ? seatLabel(s) : e.agentId, text: e.content, ts: e.ts });
        } else if (e.type === "seat_request") transcript.push({ kind: "card", who: e.agentName, text: `${e.fromName} → ${e.agentName}：${e.summary}`, ts: e.ts });
        else if (e.type === "seat_decision") transcript.push({ kind: "decision", who: "", text: e.decision, ts: e.ts });
      }
      const seatLogs: Record<string, SessionEvent[]> = {};
      for (const h of homes.values()) {
        const s = h.seats.get(gid);
        if (s !== undefined) seatLogs[h.p.id] = h.store.load(`seat-${h.p.id}-${gid}`);
      }
      return { scenario: sc, transcript, seatLogs, groupLog: gstore.load(gid), seats, startedAt, endedAt: Date.now() };
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
