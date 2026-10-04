// say() 的第 10 个参数 tz 原样落到开场白上（#1283）；不给就没有这一格。
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createCloudSession, type CloudSessionOpts } from "../../services/runtime/src/sessionService.js";
import { createWikiService } from "../../services/runtime/src/wikiService.js";
import { createMemoryWikiFs } from "../../services/runtime/src/wikiFs.js";
import { createInMemoryWikiJournal } from "../../services/runtime/src/wikiJournal.js";
import { createInMemoryAgentWriter } from "../../services/runtime/src/agentRegistry.js";
import { createInMemoryMentionInbox } from "../../services/runtime/src/mentionInbox.js";
import { createWorkspaceLock } from "../../services/runtime/src/workspaceLock.js";
import { createInMemoryCloudSessionMeta } from "../../services/runtime/src/cloudSessionMeta.js";
import { EventStore } from "../../src/session/store.js";
import type { ModelAdapter } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { UserMessageEvent } from "../../src/session/events.js";
import { tempDir } from "../helpers/tempDir.js";

const OWNER = "owner";
const SID = "s-tz";
const HELPER = { agentId: "a_000000000001", name: "助手", description: "", instructions: "", models: ["fake-model"], tools: [] };
const fakeWorld: ExecutionWorld = { fs: { read: async () => "", write: async () => {} }, exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), http: { postJson: async () => ({}) } };

function open() {
  const store = new EventStore(join(tempDir("mrotto-runtime-tz-"), "session.db"));
  store.append({ sessionId: SID, ts: 1, type: "session_created", workspace: "/work", cloud: { workspaceId: "home", home: true, chat: { kind: "dm" } } });
  const adapter: ModelAdapter = { model: "fake-model", async chat() { return { content: "好的" }; } };
  const opts: CloudSessionOpts = {
    sessionMeta: createInMemoryCloudSessionMeta(),
    workspaceId: "home", sessionId: SID, ownerUid: OWNER, createdByUid: OWNER, store, world: fakeWorld,
    agents: async () => [HELPER], adapterFor: () => adapter, px: { edgeBase: "https://edge.example", runtimeSecret: "sek" },
    hostUids: async () => [OWNER], onEvent: () => {}, onUsage: () => {},
    wiki: createWikiService({ workspaceId: "home", fs: createMemoryWikiFs(), journal: createInMemoryWikiJournal(), legacyMemories: async () => [], agentNames: async () => new Map(), isRunning: async () => true }),
    mentionInbox: createInMemoryMentionInbox(), agentWriter: createInMemoryAgentWriter(), isMember: async () => true, contextWindowOf: () => undefined,
    sandboxApproval: async () => "ask", workspaceLock: createWorkspaceLock(), relayRemainingMicro: async () => null,
    diskUsage: () => null, routines: null, onOutreachEnded: null, signSpeechTicket: async () => "t", pairMessages: null, outreach: null, approveAll: true, callback: null,
  };
  return { session: createCloudSession(opts), store };
}

describe("say() 的 tz", () => {
  it("给了就落在开场白上；不给就没有这一格", async () => {
    const { session, store } = open();
    await session.say(OWNER, "小明", "早", true, [HELPER.agentId], undefined, [], undefined, undefined, undefined, "Asia/Shanghai");
    await session.settled();
    await session.say(OWNER, "小明", "晚", true, [HELPER.agentId], undefined, []);
    await session.settled();
    const openings = store.load(SID).filter((e): e is UserMessageEvent => e.type === "user_message");
    expect(openings[0]?.tz).toBe("Asia/Shanghai");
    expect("tz" in openings[1]!).toBe(false);
    store.close();
  });
});
