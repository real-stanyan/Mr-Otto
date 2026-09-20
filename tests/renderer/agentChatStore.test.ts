// @vitest-environment jsdom
// 花名册那几个 store 动作（#1280）：建主场、点一只进它的私聊、聊天草稿。
// 判据全挂在「点下去之后打了哪几次 IPC、带了什么参数」上——这一层的 bug 都是
// 「多建了一条」「建的时候没带 chat」「团队那颗 ＋ 继承了上一次的聊天草稿」这种。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../../src/renderer/src/store.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const agent = (agentId: string, name: string) => ({
  agentId, name, description: "", instructions: "", models: [], tools: [],
  createdBy: "me", updatedTs: 0, avatarSlot: null,
});

const HOME = {
  id: "home", name: "我的智能体", ownerUid: "me", members: [], connectors: [], sessions: [],
  agents: [agent("admin", "管理员"), agent("a_000000000001", "运营")],
  sandboxApproval: null, kind: "home",
} as unknown as WorkspaceSnapshot;

let calls: unknown[][];

function stubBridge(over: Record<string, unknown> = {}): void {
  calls = [];
  const rec = (name: string, value: unknown) =>
    vi.fn(async (...a: unknown[]) => { calls.push([name, ...a]); return value; });
  (window as unknown as { otter: unknown }).otter = {
    workspaceHomeEnsure: rec("workspaceHomeEnsure", { ok: true, value: { id: "home" } }),
    workspaceList: rec("workspaceList", { ok: true, value: [HOME] }),
    workspaceCloudList: rec("workspaceCloudList", { ok: true, value: [] }),
    workspaceCloudCreate: rec("workspaceCloudCreate", { ok: true, value: { sessionId: "new-dm" } }),
    workspaceCloudJoin: rec("workspaceCloudJoin", { ok: true, value: null }),
    workspaceCloudLeave: rec("workspaceCloudLeave", { ok: true, value: null }),
    workspaceMentionsRead: rec("workspaceMentionsRead", { ok: true, value: null }),
    ...over,
  };
}

function seed(over: Record<string, unknown> = {}): void {
  useChat.setState({
    workspaceGroups: [HOME], cloudSessionList: { home: [] }, cloudSession: null,
    cloudDraftWorkspaceId: null, cloudDraftChat: null, cloudPendingFirstMessage: null,
    homeEnsure: "idle", homeError: null, workspaceGroupsError: null,
    ...over,
  } as never);
}

beforeEach(() => { stubBridge(); seed(); });

describe("ensureHome（#1280）", () => {
  it("成功：刷新团队清单，状态回 idle", async () => {
    await useChat.getState().ensureHome();
    expect(calls.map((c) => c[0])).toEqual(["workspaceHomeEnsure", "workspaceList"]);
    expect(useChat.getState().homeEnsure).toBe("idle");
  });

  it("失败：记下原因，不自动重试成一个死循环", async () => {
    stubBridge({ workspaceHomeEnsure: vi.fn(async () => ({ ok: false, message: "档位不带智能体" })) });
    await useChat.getState().ensureHome();
    expect(useChat.getState()).toMatchObject({ homeEnsure: "failed", homeError: "档位不带智能体" });
  });

  it("正在建的时候再叫一次是空操作", async () => {
    seed({ homeEnsure: "ensuring" });
    await useChat.getState().ensureHome();
    expect(calls).toEqual([]);
  });

  it("重试：failed 之后再叫得动（那颗「重试」钮就是这么工作的）", async () => {
    seed({ homeEnsure: "failed", homeError: "上次挂了" });
    await useChat.getState().ensureHome();
    expect(calls.map((c) => c[0])).toEqual(["workspaceHomeEnsure", "workspaceList"]);
    expect(useChat.getState()).toMatchObject({ homeEnsure: "idle", homeError: null });
  });
});

describe("openAgentChat（#1280）", () => {
  const DM = {
    id: "dm-1", title: "", publisherUid: "me", archived: false, updatedTs: 1,
    participantUids: [], chatKind: "dm" as const, agentIds: ["a_000000000001"],
  };

  it("聊过：直接进那一条，岛上的标题是它的名字", async () => {
    seed({ cloudSessionList: { home: [DM] } });
    await useChat.getState().openAgentChat("a_000000000001");
    expect(calls.find((c) => c[0] === "workspaceCloudJoin")).toEqual(["workspaceCloudJoin", "home", "dm-1", "运营"]);
    expect(calls.some((c) => c[0] === "workspaceCloudCreate")).toBe(false);
  });

  it("没聊过：只开开局卡，什么都不建（ADR-0218）", async () => {
    await useChat.getState().openAgentChat("a_000000000001");
    expect(calls).toEqual([]);
    expect(useChat.getState()).toMatchObject({
      cloudDraftWorkspaceId: "home",
      cloudDraftChat: { kind: "dm", agentId: "a_000000000001" },
      cloudSession: null,
    });
  });

  it("第一句话发出去才建：create 带着 chat", async () => {
    await useChat.getState().openAgentChat("a_000000000001");
    await useChat.getState().createCloudSessionFromDraft("home", "昨天卖得怎么样");
    expect(calls.find((c) => c[0] === "workspaceCloudCreate")).toEqual([
      "workspaceCloudCreate", "home", { kind: "dm", agentId: "a_000000000001" },
    ]);
    expect(useChat.getState()).toMatchObject({ cloudDraftChat: null, cloudPendingFirstMessage: "昨天卖得怎么样" });
  });

  it("名册里没有的 id：什么都不做，不开一张空白开局卡", async () => {
    await useChat.getState().openAgentChat("a_ffffffffffff");
    expect(calls).toEqual([]);
    expect(useChat.getState().cloudDraftChat).toBeNull();
  });

  it("还没有主场：什么都不做（那一栏此刻画的是骨架或订阅卡）", async () => {
    seed({ workspaceGroups: [] });
    await useChat.getState().openAgentChat("a_000000000001");
    expect(calls).toEqual([]);
  });
});

describe("openGroupChat（#1280）", () => {
  const GROUP = {
    id: "g-1", title: "上线冲刺", publisherUid: "me", archived: false, updatedTs: 3,
    participantUids: [], chatKind: "group" as const, agentIds: ["admin", "a_000000000001"],
  };

  it("进那一条，岛上的标题是群名", async () => {
    seed({ cloudSessionList: { home: [GROUP] } });
    await useChat.getState().openGroupChat("g-1");
    expect(calls.find((c) => c[0] === "workspaceCloudJoin")).toEqual(["workspaceCloudJoin", "home", "g-1", "上线冲刺"]);
  });
});

describe("聊天草稿不串台（#1280）", () => {
  it("团队那颗 ＋ 开的草稿不带 chat（团队一字不变）", async () => {
    useChat.getState().startCloudDraft("team-1");
    await useChat.getState().createCloudSessionFromDraft("team-1", "你好");
    expect(calls.find((c) => c[0] === "workspaceCloudCreate")).toEqual(["workspaceCloudCreate", "team-1", undefined]);
  });

  it("上一次挑的聊天不会被团队那颗 ＋ 继承", async () => {
    await useChat.getState().openAgentChat("a_000000000001");
    useChat.getState().startCloudDraft("team-1");
    expect(useChat.getState().cloudDraftChat).toBeNull();
  });

  it("取消草稿也清掉那一格", async () => {
    await useChat.getState().openAgentChat("a_000000000001");
    useChat.getState().cancelCloudDraft();
    expect(useChat.getState()).toMatchObject({ cloudDraftWorkspaceId: null, cloudDraftChat: null });
  });

  it("建失败：待发那句话与草稿一起清掉，不留在下一条会话里冒出来", async () => {
    stubBridge({ workspaceCloudCreate: vi.fn(async () => ({ ok: false, message: "群聊至少要两只智能体" })) });
    seed();
    await useChat.getState().openAgentChat("a_000000000001");
    await useChat.getState().createCloudSessionFromDraft("home", "第一句");
    expect(useChat.getState()).toMatchObject({
      cloudPendingFirstMessage: null,
      cloudDraftChat: null,
      workspaceGroupsError: "群聊至少要两只智能体",
    });
  });
});
