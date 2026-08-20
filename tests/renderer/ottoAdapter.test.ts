import { describe, expect, it, vi } from "vitest";
import { buildOttoAdapter } from "../../src/renderer/src/aui/ottoAdapter.js";
import type { SessionEvent } from "../../src/session/events.js";

const events: SessionEvent[] = [
  { type: "user_message", content: "你好", sessionId: "s1", ts: 1000, seq: 0 },
];

function input(over: Partial<Parameters<typeof buildOttoAdapter>[0]> = {}) {
  return {
    events,
    live: undefined,
    isRunning: false,
    send: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    retry: vi.fn(),
    ...over,
  };
}

describe("buildOttoAdapter", () => {
  it("messages 是投影结果,convertMessage 是恒等", () => {
    const a = buildOttoAdapter(input());
    expect(a.messages).toHaveLength(1);
    const m = a.messages![0]!;
    // convertMessage 上不加 !:T = ThreadMessageLike 时它在类型上是必填的
    expect(a.convertMessage(m, 0)).toBe(m);
  });

  it("刻意不提供 onEdit / setMessages —— 本仓没有消息编辑和对话分支", () => {
    const a = buildOttoAdapter(input());
    expect(a.onEdit).toBeUndefined();
    expect(a.setMessages).toBeUndefined();
  });

  it("onReload 转交 retry —— 重试有 fill 档,但接线后 MessageActions 那个入口没了", async () => {
    const retry = vi.fn();
    const a = buildOttoAdapter(input({ retry }));
    expect(a.onReload).toBeTypeOf("function");
    await a.onReload!("p1", { runConfig: {} } as never);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("isRunning 直接透传", () => {
    expect(buildOttoAdapter(input({ isRunning: true })).isRunning).toBe(true);
  });

  it("onNew 把纯文本消息交给 send", async () => {
    const send = vi.fn(async () => {});
    const a = buildOttoAdapter(input({ send }));
    await a.onNew({ content: [{ type: "text", text: "在吗" }] } as never);
    expect(send).toHaveBeenCalledWith("在吗");
  });

  it("onNew 把多个 text part 拼起来再发", async () => {
    const send = vi.fn(async () => {});
    const a = buildOttoAdapter(input({ send }));
    await a.onNew({ content: [
      { type: "text", text: "第一段" },
      { type: "text", text: "第二段" },
    ] } as never);
    expect(send).toHaveBeenCalledWith("第一段\n第二段");
  });

  it("onNew 忽略非 text part —— 附件走 PR2 的通道,不从这里偷渡", async () => {
    const send = vi.fn(async () => {});
    const a = buildOttoAdapter(input({ send }));
    await a.onNew({ content: [
      { type: "image", image: "data:image/png;base64,xx" },
      { type: "text", text: "看图" },
    ] } as never);
    expect(send).toHaveBeenCalledWith("看图");
  });

  it("onCancel 接到 stop", async () => {
    const cancel = vi.fn(async () => {});
    const a = buildOttoAdapter(input({ cancel }));
    await a.onCancel!();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
