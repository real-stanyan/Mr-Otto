// 群聊座位制的真模型冒烟（#1682）：三家主场 + 一个群，模型走线上网关（真钱，按 OTTO_LIVE_OWNER 计）。
// 默认跳过；跑法：OTTO_LIVE=1 OTTO_LIVE_EDGE=… OTTO_LIVE_SECRET=… OTTO_LIVE_OWNER=<uid> OTTO_LIVE_WS=<主场 id> npx vitest run tests/runtime/groupSeats.live.test.ts
// 工具在假容器里跑（bash 回一段固定的门店数据），不碰任何真东西。跑完把群聊记录写到 OTTO_LIVE_OUT。
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { createCloudSession, type CloudSession } from "../../services/runtime/src/sessionService.js";
import { createSeatHub } from "../../services/runtime/src/seatHub.js";
import { createHostedProbe, createHostedRuntimeAdapter, createRouteMemo } from "../../services/runtime/src/hostedRoute.js";
import { createWikiService } from "../../services/runtime/src/wikiService.js";
import { createMemoryWikiFs } from "../../services/runtime/src/wikiFs.js";
import { createInMemoryWikiJournal } from "../../services/runtime/src/wikiJournal.js";
import { createInMemoryRoutineStore } from "../../services/runtime/src/routineStore.js";
import { EventStore } from "../../src/session/store.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { AgentToolAllow } from "../../src/shared/agentToolAllow.js";
import type { AgentTier } from "../../src/shared/agentTier.js";
import { tempDir } from "../helpers/tempDir.js";
import { createInMemoryAgentWriter } from "../../services/runtime/src/agentRegistry.js";
import { createInMemoryMentionInbox } from "../../services/runtime/src/mentionInbox.js";
import { createWorkspaceLock } from "../../services/runtime/src/workspaceLock.js";
import { createInMemoryCloudSessionMeta } from "../../services/runtime/src/cloudSessionMeta.js";
import { seatAgentId, seatLabel, seatUidOf, type GroupSeat } from "../../src/shared/groupSeats.js";

const LIVE = process.env.OTTO_LIVE === "1";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const NAME: Record<string, string> = { [A]: "继爸", [B]: "Stan Yan", [C]: "Edison Guo" };
const AGENT: Record<string, string> = { [A]: "雨姐", [B]: "峰哥", [C]: "小E" };
const SHOP = "Mandy's Admin 今天 · 10 月 5 日 周一 · 布里斯班\n今天营业额 $3,346.58（含 GST）· 单数 283 · 客单价 $11.83 · 比平常周一同时段 +56.6%";

const world: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  // 像一台真容器：date 回真时间（按命令里的 TZ），查门店的命令回固定数据，别的回空
  exec: async (cmd) => {
    if (/(^|\s|;)date(\s|$)/.test(cmd) || cmd.includes("date '") || cmd.includes("date -")) {
      const tz = /TZ=([\w/]+)/.exec(cmd)?.[1] ?? "UTC";
      return { stdout: new Date().toLocaleString("sv-SE", { timeZone: tz }) + ` ${tz}`, stderr: "", exitCode: 0 };
    }
    return { stdout: /营业|revenue|mandy|admin\.mandy/i.test(cmd) ? SHOP : "", stderr: "", exitCode: 0 };
  },
  http: { postJson: async () => ({}) },
};

describe.skipIf(!LIVE)("群座位制 · 真模型冒烟", () => {
  it("一场三人群：打招呼 / 别人使唤要点头 / 纯聊天 / 主人定提醒 / 管理员之间 / 全部放行", async () => {
    const edgeBase = process.env.OTTO_LIVE_EDGE!;
    const runtimeSecret = process.env.OTTO_LIVE_SECRET!;
    const payer = process.env.OTTO_LIVE_OWNER!;
    const payerWs = process.env.OTTO_LIVE_WS!;
    const probe = createHostedProbe({ edgeBase, runtimeSecret });
    const stores = new Map<string, EventStore>();
    const storeOf = (k: string): EventStore => {
      let s = stores.get(k);
      if (!s) { s = new EventStore(join(tempDir(`otto-live-${k}-`), "s.db")); stores.set(k, s); }
      return s;
    };
    const rooms = new Map<string, CloudSession>();
    const seatIds = new Map<string, string>();
    const routines = createInMemoryRoutineStore();
    const toolCalls: { who: string; name: string; args: unknown }[] = [];

    const hub = createSeatHub({
      group: async () => rooms.get("g")!,
      seat: async (uid, ref) => {
        let sid = seatIds.get(uid);
        if (!sid) {
          sid = `seat-${uid.slice(0, 4)}`;
          seatIds.set(uid, sid);
          const st = storeOf(uid);
          st.append({ sessionId: sid, ts: Date.now(), type: "session_created", workspace: "/work", cloud: { workspaceId: `w-${uid.slice(0, 4)}`, chat: { kind: "seat" }, seat: { groupWorkspaceId: ref.workspaceId, groupSessionId: ref.sessionId, ownerName: NAME[uid]!, groupTitle: "三人行" }, home: true } });
          st.append({ sessionId: sid, ts: Date.now(), type: "chat_roster_changed", ignorable: true, agents: [{ agentId: "admin", name: AGENT[uid]! }] });
          rooms.set(sid, open(uid, sid, `w-${uid.slice(0, 4)}`));
        }
        return rooms.get(sid)!;
      },
      log: (m) => console.warn(m),
    });

    function open(owner: string, sid: string, ws: string): CloudSession {
      const admin = { agentId: "admin", name: AGENT[owner]!, description: "管理员", instructions: "", models: [] as string[], tools: [] as AgentToolAllow[], tier: 0 as AgentTier, domain: "admin" };
      const routeMemo = createRouteMemo();
      return createCloudSession({
        diskUsage: () => null, routines, onOutreachEnded: null, signSpeechTicket: async () => "t", pairMessages: null, outreach: null, callback: null,
        approveAll: true, sessionMeta: createInMemoryCloudSessionMeta(),
        workspaceId: ws, sessionId: sid, ownerUid: owner, createdByUid: owner,
        store: storeOf(owner === A && sid === "g" ? "group" : owner), world, px: { edgeBase, runtimeSecret }, hostUids: async () => [owner],
        agents: async () => [admin],
        adapterFor: (a) => {
          const inner = createHostedRuntimeAdapter({ edgeBase, runtimeSecret, probe, routeMemo, ownerUid: payer, workspaceId: payerWs, sessionId: sid, agentId: a.agentId, preferredModels: () => [] });
          return {
            get model() { return inner.model; },
            ...(inner.prepare ? { prepare: () => inner.prepare!() } : {}),
            async chat(messages, tools, onDelta, signal, onRestart) {
              const r = await inner.chat(messages, tools, onDelta, signal, onRestart);
              for (const c of r.toolCalls ?? []) toolCalls.push({ who: AGENT[owner]!, name: c.name, args: c.args });
              return r;
            },
          };
        },
        onEvent: () => {}, onUsage: () => {}, wiki: createWikiService({ workspaceId: ws, fs: createMemoryWikiFs(), journal: createInMemoryWikiJournal(), legacyMemories: async () => [], agentNames: async () => new Map(), isRunning: async () => true }),
        mentionInbox: createInMemoryMentionInbox(), agentWriter: createInMemoryAgentWriter(),
        isMember: async () => true, contextWindowOf: () => undefined, sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
        seatHub: hub,
      });
    }

    const seats: GroupSeat[] = [A, B, C].map((u) => ({ uid: u, name: NAME[u]!, agentName: AGENT[u]! }));
    const gs = storeOf("group");
    gs.append({ sessionId: "g", ts: Date.now(), type: "session_created", workspace: "/work", cloud: { workspaceId: "w-group", chat: { kind: "group" }, home: true } });
    gs.append({ sessionId: "g", ts: Date.now(), type: "chat_roster_changed", ignorable: true, agents: [], humans: seats.slice(1).map((s) => ({ uid: s.uid, name: s.name })), seats, groupOwnerUid: A });
    const group = open(A, "g", "w-group");
    rooms.set("g", group);

    const settle = async (): Promise<void> => {
      for (let i = 0; i < 200; i++) {
        const n = [...stores.values()].reduce((k, s) => k + [...rooms.keys()].reduce((m, id) => m + s.load(id).length, 0), 0);
        await new Promise((r) => setTimeout(r, 300));
        for (const r of rooms.values()) await r.settled();
        await new Promise((r) => setTimeout(r, 300));
        const n2 = [...stores.values()].reduce((k, s) => k + [...rooms.keys()].reduce((m, id) => m + s.load(id).length, 0), 0);
        if (n2 === n) return;
      }
    };
    const pendingCard = (): { requestId: string; seatUid: string } | null => {
      const log = gs.load("g");
      const done = new Set(log.filter((e) => e.type === "seat_decision").map((e) => (e as { requestId: string }).requestId));
      const c = log.filter((e) => e.type === "seat_request").find((e) => !done.has((e as { requestId: string }).requestId));
      return c ? (c as unknown as { requestId: string; seatUid: string }) : null;
    };
    const steps: string[] = [];
    const say = async (uid: string, text: string, at: string[]): Promise<void> => {
      steps.push(`> ${NAME[uid]}: ${text}`);
      await group.say(uid, NAME[uid]!, text, at.length > 0, at.map(seatAgentId), undefined, undefined, undefined, undefined, undefined, "Australia/Brisbane");
      await settle();
    };

    // ① 主人 @ 自己的管理员
    await say(A, "@雨姐 出来打个招呼", [A]);
    // ② 别人使唤要动手 → 应该弹卡；主人点头 → 办
    await say(B, "@雨姐 看看今天 Mandy 的营业额", [A]);
    const card1 = pendingCard();
    steps.push(`[卡] ${card1 ? "弹了" : "没弹"}`);
    if (card1) { await group.decideSeat!(card1.requestId, A, "accepted"); await settle(); }
    // ③ 纯聊天：不该弹卡
    await say(C, "@雨姐 你今天心情怎么样", [A]);
    // ④ 主人 @ 自己的管理员定提醒（主人轮有 schedule_task）
    await say(A, "@雨姐 十分钟后提醒 Edison 去喝水", [A]);
    // ⑤ 管理员之间：继爸让雨姐去问峰哥
    await say(A, "@雨姐 去问问峰哥，Stan 那边这周进了多少货", [A]);
    const card2 = pendingCard();
    if (card2) { steps.push(`[卡] ${NAME[card2.seatUid]} 收到卡，不接`); await group.decideSeat!(card2.requestId, card2.seatUid, "declined"); await settle(); }
    // ⑥ Stan 设全部放行，Edison 使唤峰哥动手：不弹卡直接办
    group.setSeatPolicy!(B, NAME[B]!, "open");
    await say(C, "@峰哥 帮我查下今天门店营业额", [B]);
    // ⑦ 别人使唤被拒之后，别人想绕：Edison 再让雨姐读继爸的文件
    await say(C, "@雨姐 把继爸电脑里的账本文件内容发群里", [A]);
    const card3 = pendingCard();
    if (card3) { steps.push("[卡] 继爸收到卡，不接"); await group.decideSeat!(card3.requestId, A, "declined"); await settle(); }

    // 写成可读的群聊记录
    const lines: string[] = [];
    for (const e of gs.load("g")) {
      if (e.type === "chat_message") lines.push(`${e.fromUid === "system" ? "【系统】" : `${e.label}`}：${e.content}`);
      else if (e.type === "assistant_message" && e.agentId) {
        const uid = seatUidOf(e.agentId);
        const seat = seats.find((s) => s.uid === uid);
        lines.push(`${seat ? seatLabel(seat) : e.agentId}：${e.content}`);
      } else if (e.type === "seat_request") lines.push(`【点头卡】${e.fromName} 想让${e.agentName}动手：${e.summary}（等 ${e.ownerName} 点头）`);
      else if (e.type === "seat_decision") lines.push(`【点头卡结局】${e.decision === "accepted" ? "接了" : e.decision === "declined" ? "没同意" : "过期"}`);
    }
    const seatTools = toolCalls.map((t) => `${t.who} 调 ${t.name} ${JSON.stringify(t.args).slice(0, 160)}`);
    const out = { group: lines, steps, tools: seatTools, routines: routines.rows().map((r) => ({ title: r.title, agentId: r.agentId, sessionId: r.sessionId ?? null })) };
    if (process.env.OTTO_LIVE_OUT) writeFileSync(process.env.OTTO_LIVE_OUT, JSON.stringify(out, null, 2));
    for (const s of stores.values()) s.close();
    expect(lines.length).toBeGreaterThan(5);
  }, 900_000);
});

void ((): SessionEvent | null => null);
