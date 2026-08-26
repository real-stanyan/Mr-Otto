// @vitest-environment jsdom
// side chat store slice（issue #502）：openSideChat / closeSideChat / sendSide 的
// 行为契约。window.otter 用最小桩（cast ShellBridge），只钉这个 slice 依赖的三个通道。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../../src/renderer/src/store.js";
import type { ShellBridge } from "../../src/shared/shellBridge.js";

const SIDE_ID = "side-session-1";

function stubBridge() {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  window.otter = {
    startSideSession: vi.fn().mockResolvedValue({ sessionId: SIDE_ID }),
    sendMessage,
  } as unknown as ShellBridge;
  return { sendMessage };
}

beforeEach(() => {
  useChat.setState({ sideChat: null, error: null, sessionId: "main-session" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openSideChat", () => {
  it("首次：建独立会话，sideChat 就位", async () => {
    stubBridge();
    await useChat.getState().openSideChat();
    const side = useChat.getState().sideChat;
    expect(side).not.toBeNull();
    expect(side!.sessionId).toBe(SIDE_ID);
    expect(side!.open).toBe(true);
    expect(window.otter.startSideSession).toHaveBeenCalledWith("main-session");
  });

  it("/btw 带参：首开时把内容发成旁聊首条（issue #516）", async () => {
    stubBridge();
    await useChat.getState().openSideChat("顺便查一下明天天气");
    expect(window.otter.sendMessage).toHaveBeenCalledWith(SIDE_ID, "顺便查一下明天天气");
  });

  it("/btw 带参 + 旁聊已存在：只抬回可见，不重发（内容已在日志里）", async () => {
    stubBridge();
    await useChat.getState().openSideChat();
    useChat.getState().closeSideChat();
    await useChat.getState().openSideChat("这条不该重发");
    // 只发过一次都没有——sendMessage 全程没被调（首开没传参，重开传了但走的是抬回路径）
    expect(window.otter.sendMessage).not.toHaveBeenCalled();
    expect(useChat.getState().sideChat!.open).toBe(true);
  });

  it("已开着：再敲 /btw 只抬回可见，不重建会话", async () => {
    stubBridge();
    await useChat.getState().openSideChat();
    useChat.getState().closeSideChat();
    expect(useChat.getState().sideChat!.open).toBe(false);
    await useChat.getState().openSideChat();
    expect(useChat.getState().sideChat!.open).toBe(true);
    // startSideSession 只调过一次
    expect(window.otter.startSideSession).toHaveBeenCalledTimes(1);
  });

  it("没有主会话时不建，报错", async () => {
    stubBridge();
    useChat.setState({ sessionId: "" });
    await useChat.getState().openSideChat();
    expect(useChat.getState().sideChat).toBeNull();
    expect(useChat.getState().error).toBeTruthy();
    expect(window.otter.startSideSession).not.toHaveBeenCalled();
  });
});

describe("sendSide", () => {
  it("按旁聊自己的 sessionId 寻址，不碰主会话", async () => {
    const { sendMessage } = stubBridge();
    await useChat.getState().openSideChat();
    await useChat.getState().sendSide("hello");
    expect(sendMessage).toHaveBeenCalledWith(SIDE_ID, "hello");
  });

  it("没开旁聊时发送是空操作", async () => {
    const { sendMessage } = stubBridge();
    await useChat.getState().sendSide("hello");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("closeSideChat", () => {
  it("只置 open=false，会话本体保留", async () => {
    stubBridge();
    await useChat.getState().openSideChat();
    useChat.getState().closeSideChat();
    const side = useChat.getState().sideChat;
    expect(side).not.toBeNull();
    expect(side!.open).toBe(false);
  });
});
