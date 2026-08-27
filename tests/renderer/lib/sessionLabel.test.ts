import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../../src/session/events.js";
import {
  fallbackSessionLabel,
  firstUserMessageTitle,
  sessionDisplayName,
} from "../../../src/renderer/src/lib/sessionLabel.js";

const userMsg = (content: string, seq = 1): SessionEvent =>
  ({ seq, ts: seq, sessionId: "s-1", type: "user_message", content }) as SessionEvent;

const assistantMsg = (seq: number): SessionEvent =>
  ({ seq, ts: seq, sessionId: "s-1", type: "assistant_message", content: "回你" }) as SessionEvent;

describe("firstUserMessageTitle", () => {
  it("取首条 user_message 的首行", () => {
    expect(firstUserMessageTitle([assistantMsg(1), userMsg("帮我配置好\n还有第二行", 2), userMsg("后来的", 3)]))
      .toBe("帮我配置好");
  });

  it("没发过话 = null", () => {
    expect(firstUserMessageTitle([assistantMsg(1)])).toBeNull();
  });

  it("全是空白算没有——空串会把兜底顶掉", () => {
    expect(firstUserMessageTitle([userMsg("   \n有正文")])).toBeNull();
  });
});

describe("fallbackSessionLabel", () => {
  it("内置 Default 里的会话叫「任务」", () => {
    expect(fallbackSessionLabel("/Users/me/Documents/Mr Otto/Default", "/Users/me/Documents/Mr Otto/Default"))
      .toBe("任务");
  });

  it("别的工程用文件夹名", () => {
    expect(fallbackSessionLabel("/Users/me/Github/Mr_Otto", "/Users/me/Documents/Mr Otto/Default"))
      .toBe("Mr_Otto");
  });

  it("还没读到内置路径时不误判成「任务」", () => {
    expect(fallbackSessionLabel("/Users/me/Github/Mr_Otto", null)).toBe("Mr_Otto");
  });
});

describe("sessionDisplayName", () => {
  it("镜像标题最优先", () => {
    expect(sessionDisplayName("改过的名字", [userMsg("帮我配置好")], "任务")).toBe("改过的名字");
  });

  it("镜像还没回来时,本地 events 顶上——不露会话 id", () => {
    expect(sessionDisplayName(null, [userMsg("帮我配置好")], "任务")).toBe("帮我配置好");
  });

  it("真没发过话才用兜底", () => {
    expect(sessionDisplayName(null, [], "任务")).toBe("任务");
  });

  it("镜像标题是空白 = 没有标题", () => {
    expect(sessionDisplayName("  ", [userMsg("帮我配置好")], "任务")).toBe("帮我配置好");
  });
});
