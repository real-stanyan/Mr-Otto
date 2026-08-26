// /btw side chat（issue #502）：独立小会话 + 浮窗。
// 这里钉三件事：① absorbEvent 的分流——side session 的事件进 sideChatEvents
// 而不是主 events，也不像别的后台会话那样被丢（浮窗没有 resumeSession 兜底）；
// ② openSideChat 一次 app 运行只建一个 session（连按 /btw 不重复建）；
// ③ 浮窗的错误横幅与主时间线的 error 各自独立。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { absorbEvent, useChat } from "../../src/renderer/src/store.js";
import { SLASH_COMMANDS } from "../../src/renderer/src/commands.js";
import type { SessionEvent } from "../../src/session/events.js";

const MAIN = "sess-main";
const SIDE = "sess-side";

const baseState = () => ({
  sessionId: MAIN,
  events: [] as SessionEvent[],
  streamingBySession: {},
  toolOutputByCall: {},
  runningToolCallBySession: {},
  approvals: {},
  sideChatSessionId: SIDE as string | null,
  sideChatEvents: [] as SessionEvent[],
});

const msg = (sessionId: string, content: string): SessionEvent => ({
  seq: 1, sessionId, ts: 1, type: "user_message", content,
});

describe("absorbEvent 的 side chat 分流", () => {
  it("side session 的事件进 sideChatEvents，不进主 events", () => {
    const next = absorbEvent(baseState(), msg(SIDE, "浮窗里说的"));
    expect("events" in next).toBe(false);
    if (!("sideChatEvents" in next)) throw new Error("side 事件必须并入 sideChatEvents");
    expect(next.sideChatEvents).toHaveLength(1);
  });

  it("主会话事件照旧进 events，不碰 sideChatEvents", () => {
    const next = absorbEvent(baseState(), msg(MAIN, "主时间线"));
    if (!("events" in next)) throw new Error("主会话事件必须并入 events");
    expect("sideChatEvents" in next).toBe(false);
  });

  it("既非主也非 side 的后台会话事件照旧丢弃（DB 是缓冲区）", () => {
    const next = absorbEvent(baseState(), msg("sess-other", "别人的"));
    expect("events" in next).toBe(false);
    expect("sideChatEvents" in next).toBe(false);
  });

  it("side session 未建（null）时不误收任何事件", () => {
    const next = absorbEvent({ ...baseState(), sideChatSessionId: null }, msg(SIDE, "早到的"));
    expect("sideChatEvents" in next).toBe(false);
  });
});

describe("openSideChat / sendSideChat", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    useChat.setState({
      workspace: "/w/proj",
      sideChatOpen: false,
      sideChatSessionId: null,
      sideChatEvents: [],
      sideChatCreating: false,
      sideChatError: null,
      error: null,
    });
  });

  it("首次 /btw 建 session，连按不重复建（一次 app 运行一个）", async () => {
    const startSideSession = vi.fn(async () => ({ sessionId: SIDE }));
    vi.stubGlobal("window", { otter: { startSideSession } });
    await useChat.getState().openSideChat();
    expect(useChat.getState().sideChatOpen).toBe(true);
    expect(useChat.getState().sideChatSessionId).toBe(SIDE);

    useChat.getState().closeSideChat();
    await useChat.getState().openSideChat();
    expect(startSideSession).toHaveBeenCalledTimes(1); // 复用，不再建
    expect(useChat.getState().sideChatOpen).toBe(true);
  });

  it("没有工程会话在身：报错，浮窗不开", async () => {
    useChat.setState({ workspace: "" }); // welcome 阶段还没有工程会话
    await useChat.getState().openSideChat();
    expect(useChat.getState().sideChatOpen).toBe(false);
    expect(useChat.getState().error).toContain("工程文件夹");
  });

  it("建 session 失败：浮窗收回去，错误落主横幅", async () => {
    vi.stubGlobal("window", {
      otter: { startSideSession: vi.fn(async () => { throw new Error("模型没配 key"); }) },
    });
    await useChat.getState().openSideChat();
    expect(useChat.getState().sideChatOpen).toBe(false);
    expect(useChat.getState().sideChatSessionId).toBeNull();
    expect(useChat.getState().error).toContain("模型没配 key");
  });

  it("sendSideChat 发到 side session；失败落 sideChatError，不碰主 error", async () => {
    const sendMessage = vi.fn(async () => { throw new Error("会话不存在"); });
    vi.stubGlobal("window", { otter: { sendMessage } });
    useChat.setState({ sideChatSessionId: SIDE });
    await useChat.getState().sendSideChat("你好");
    expect(sendMessage).toHaveBeenCalledWith(SIDE, "你好");
    expect(useChat.getState().sideChatError).toContain("会话不存在");
    expect(useChat.getState().error).toBeNull();
  });

  it("关浮窗不丢 session 和已攒的时间线——再 /btw 接着聊", () => {
    useChat.setState({
      sideChatOpen: true,
      sideChatSessionId: SIDE,
      sideChatEvents: [msg(SIDE, "老话")],
    });
    useChat.getState().closeSideChat();
    expect(useChat.getState().sideChatOpen).toBe(false);
    expect(useChat.getState().sideChatSessionId).toBe(SIDE);
    expect(useChat.getState().sideChatEvents).toHaveLength(1);
  });
});

describe("/btw 指令注册", () => {
  it("SLASH_COMMANDS 里有 /btw（`/` 菜单和 dispatchSlash 共用这张表）", () => {
    expect(SLASH_COMMANDS["/btw"]).toBeDefined();
  });
});
