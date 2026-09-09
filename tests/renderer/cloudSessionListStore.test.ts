// @vitest-environment jsdom
//
// store 对云会话事件的两条新反应（#1213，Task 7）：会话被自动命名了 →
// 侧栏那一行的字该刷新；有人在这条会话里说了话 → 本地把他并进那一行的
// 参与者，不打网络。
//
// 这两条逻辑长在 boot() 内部注册给 window.otter.onCloudSessionEvent 的那个
// 匿名回调里——store.ts 没有为它单独导出一个可调用的 action（同 cloudTimeline.ts
// 里 createAgentLanded 那条不一样：那条是纯函数、这条是内联的 set() 调用，
// brief 的 "Produces: 无新导出" 约束也不允许再切一个新导出出来）。要验证的
// 是真代码而不是一份重新实现，只剩一条路：
//   1. 用一个"没被显式接管的方法一律回退成空操作"的 Proxy 顶替 window.otter，
//      借它跑一次真正的 boot()。此仓没有别的测试这样做过——boot() 有一个
//      模块级 `bootStarted` 门闩，但每个测试文件本来就是全新的模块实例，
//      整份文件只 boot 一次不会撞上它，之后反复用 useChat.setState 重置
//      想要的那几格状态即可；
//   2. 从 onCloudSessionEvent(cb) 这次注册里把 cb 摘出来，之后直接调用它——
//      拿到的正是 boot() 里那份闭包，读写的都是同一个 store。
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat, type CloudSessionState } from "../../src/renderer/src/store.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { CloudSessionListRow } from "../../src/renderer/src/lib/workspaceView.js";

let cloudEventHandler: ((e: SessionEvent) => void) | null = null;
const workspaceCloudListCalls: string[] = [];

beforeAll(async () => {
  const base: Record<string, unknown> = {
    getAccount: async () => ({ signedIn: false, id: "", email: "", name: "", avatarUrl: "" }),
    onCloudSessionEvent: (cb: (e: SessionEvent) => void) => {
      cloudEventHandler = cb;
    },
    workspaceCloudList: async (workspaceId: string) => {
      workspaceCloudListCalls.push(workspaceId);
      return { ok: true, value: [] };
    },
  };
  // boot() 里还有几十个 window.otter.onXxx(...) 注册 + 几个一次性查询（会话列表、
  // skill、账号……）。这个文件只关心 onCloudSessionEvent 这一条，其余的只要不炸
  // 就行——没被上面显式接管的方法统一换成"什么都不做、回一个 resolved promise"，
  // 免得为每一个用不上的方法各写一行
  const handler: ProxyHandler<typeof base> = {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      return vi.fn(async () => undefined);
    },
  };
  (window as unknown as { otter: unknown }).otter = new Proxy(base, handler);
  await useChat.getState().boot();
});

const fire = (e: SessionEvent): void => {
  if (!cloudEventHandler) throw new Error("boot() 没有把 onCloudSessionEvent 注册上");
  cloudEventHandler(e);
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const makeCloudSession = (over: Partial<CloudSessionState> = {}): CloudSessionState => ({
  workspaceId: "w1", sessionId: "s1", state: "ready",
  initiatorUid: null, ownerUid: "o", selfUid: "u1",
  modelRoute: null, gapNote: null, events: [],
  ...over,
});

const makeRow = (over: Partial<CloudSessionListRow> = {}): CloudSessionListRow => ({
  id: "s1", title: "旧标题", publisherUid: "o", archived: false, updatedTs: 1, participantUids: [],
  ...over,
});

const chat = (seq: number, fromUid: string, sessionId = "s1"): SessionEvent => ({
  sessionId, ts: 0, seq, type: "chat_message", fromUid, label: fromUid, content: "hi", mention: false,
});
const autotitled = (seq: number, sessionId = "s1"): SessionEvent => ({
  sessionId, ts: 0, seq, type: "session_autotitled", title: "新标题", model: "m",
});
const agentReply = (seq: number, sessionId = "s1"): SessionEvent => ({
  sessionId, ts: 0, seq, type: "assistant_message", content: "答案", model: "m",
});

beforeEach(() => {
  workspaceCloudListCalls.length = 0;
  useChat.setState({
    cloudSession: makeCloudSession(),
    cloudSessionList: { w1: [makeRow()] },
  });
});

describe("会话被自动命名 → 刷新侧栏清单（不是每条人类发言都要打一次网络）", () => {
  it("session_autotitled 触发 refreshCloudSessions(workspaceId)", async () => {
    fire(autotitled(1));
    await flush();
    expect(workspaceCloudListCalls).toEqual(["w1"]);
  });

  it("普通聊天消息不触发刷新——这条判据只认事件类型，不是「有没有人说话」", async () => {
    fire(chat(1, "u2"));
    await flush();
    expect(workspaceCloudListCalls).toEqual([]);
  });
});

describe("有人说话 → 本地并入参与者，只并不删", () => {
  it("新说话的人被追加，已有的人原样保留在前面", () => {
    useChat.setState({ cloudSessionList: { w1: [makeRow({ participantUids: ["u9"] })] } });
    fire(chat(1, "u2"));
    expect(useChat.getState().cloudSessionList["w1"]![0]!.participantUids).toEqual(["u9", "u2"]);
  });

  it("同一个人再说一遍不重复", () => {
    useChat.setState({ cloudSessionList: { w1: [makeRow({ participantUids: ["u9", "u2"] })] } });
    fire(chat(2, "u2"));
    expect(useChat.getState().cloudSessionList["w1"]![0]!.participantUids).toEqual(["u9", "u2"]);
  });

  it("非人类事件（agent 自己的回复）不改变参与者——humanSpeakerOf 回 null 就该原样跳过", () => {
    useChat.setState({ cloudSessionList: { w1: [makeRow({ participantUids: ["u9"] })] } });
    fire(agentReply(1));
    expect(useChat.getState().cloudSessionList["w1"]![0]!.participantUids).toEqual(["u9"]);
  });

  it("不属于当前 join 着的会话的事件原样跳过——sessionId 对不上就不该动这一行", () => {
    useChat.setState({ cloudSessionList: { w1: [makeRow({ participantUids: ["u9"] })] } });
    fire(chat(1, "u2", "another-session"));
    expect(useChat.getState().cloudSessionList["w1"]![0]!.participantUids).toEqual(["u9"]);
  });

  // 控制器备注 3 点名的那处：session_archived 那支会在这条回调里提前拿到的
  // cur 之后关掉当前会话（既有逻辑，本就会触发一次 refreshCloudSessions）。
  // 两条新分支各自认的事件类型（session_autotitled / humanSpeakerOf 为真的
  // chat_message、user_message）与 session_archived 互斥，一次回调里不会
  // 同时命中——这条钉的是"只有既有那一次刷新，新分支没有跟着凑一次"，
  // 以及参与者没被这条事件误改，而不是靠读代码相信它
  it("归档事件：只触发既有那一次刷新，新分支不跟着多刷一次，也不改变参与者", () => {
    useChat.setState({ cloudSessionList: { w1: [makeRow({ participantUids: ["u9"] })] } });
    fire({ sessionId: "s1", ts: 0, seq: 1, type: "session_archived" });
    // 不等 flush：refreshCloudSessions 的响应回来会把 cloudSessionList.w1 整个
    // 换成 mock 回的空清单（那是它自己的既有行为，与本条要钉的事无关），会盖住
    // "新分支有没有跟着多改一次参与者"这件事本身。调用本身（连同 push 进
    // workspaceCloudListCalls）在 fire() 返回前就已经同步发生，不必等它
    expect(workspaceCloudListCalls).toEqual(["w1"]); // session_archived 既有逻辑那一次，不多不少
    expect(useChat.getState().cloudSessionList["w1"]![0]!.participantUids).toEqual(["u9"]);
  });
});
