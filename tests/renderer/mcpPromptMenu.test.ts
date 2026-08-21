import { describe, expect, it } from "vitest";

import {
  initialMcpPromptValues,
  isCurrentMcpPromptSubmission,
  mcpPromptCommandDescription,
  mcpPromptCommandId,
  mcpPromptFormKey,
  missingRequiredArgs,
  type McpPromptArg,
} from "../../src/renderer/src/lib/mcpPromptMenu.js";

describe("mcpPromptCommandId", () => {
  it("同名 prompt 挂在不同 server 上,id 不会撞", () => {
    expect(mcpPromptCommandId("serverA", "summarize")).not.toBe(
      mcpPromptCommandId("serverB", "summarize")
    );
  });

  it("server 和名字都一样才是同一个 id", () => {
    expect(mcpPromptCommandId("serverA", "summarize")).toBe(mcpPromptCommandId("serverA", "summarize"));
  });
});

describe("mcpPromptCommandDescription", () => {
  it("有说明时,说明后缀上来源 server", () => {
    expect(mcpPromptCommandDescription("把长文压成摘要", "notion")).toBe("把长文压成摘要 · notion");
  });

  it("没说明时,退回一句带 server 名字的通用文案", () => {
    expect(mcpPromptCommandDescription(undefined, "notion")).toBe("来自 notion 的 MCP prompt");
  });
});

describe("initialMcpPromptValues", () => {
  it("每个参数一格空字符串,顺序跟 arguments 一致", () => {
    const args: McpPromptArg[] = [{ name: "topic" }, { name: "length", required: true }];
    expect(initialMcpPromptValues(args)).toEqual({ topic: "", length: "" });
  });

  it("没有参数时给空对象", () => {
    expect(initialMcpPromptValues([])).toEqual({});
  });
});

describe("missingRequiredArgs", () => {
  const args: McpPromptArg[] = [
    { name: "topic", required: true },
    { name: "tone" },
    { name: "length", required: true },
  ];

  it("必填且没填的都列出来", () => {
    expect(missingRequiredArgs(args, { topic: "", tone: "轻松", length: "" })).toEqual([
      "topic",
      "length",
    ]);
  });

  it("只打了空格不算填过", () => {
    expect(missingRequiredArgs(args, { topic: "   ", tone: "", length: "500" })).toEqual(["topic"]);
  });

  it("全填了就是空数组,可以提交", () => {
    expect(missingRequiredArgs(args, { topic: "猫", tone: "", length: "500" })).toEqual([]);
  });

  it("非必填的参数不管填没填都不拦", () => {
    expect(missingRequiredArgs(args, { topic: "猫", tone: "", length: "500" })).not.toContain("tone");
  });
});

describe("mcpPromptFormKey", () => {
  it("null 表单没有 remount key", () => {
    expect(mcpPromptFormKey(null)).toBeNull();
  });

  it("server+name 拼出 remount key", () => {
    expect(mcpPromptFormKey({ server: "notion", name: "summarize" })).toBe("notion:summarize");
  });

  it("换了 server 或换了名字,key 跟着变", () => {
    const a = mcpPromptFormKey({ server: "notion", name: "summarize" });
    const b = mcpPromptFormKey({ server: "linear", name: "summarize" });
    expect(a).not.toBe(b);
  });

  it("取消又重开同一个 prompt,key 不变——它不负责回答请求还新不新鲜", () => {
    // 这正是 review finding 1 的边界:key 相同不代表是同一次提交,
    // 这道判断是 isCurrentMcpPromptSubmission 的事,不是这个函数的事
    const before = mcpPromptFormKey({ server: "notion", name: "summarize" });
    const after = mcpPromptFormKey({ server: "notion", name: "summarize" });
    expect(before).toBe(after);
  });
});

describe("isCurrentMcpPromptSubmission", () => {
  const expected = { token: 3, sessionId: "session-a" };

  it("token 和 session 都对得上才算数", () => {
    expect(isCurrentMcpPromptSubmission({ token: 3, sessionId: "session-a" }, expected)).toBe(true);
  });

  it("token 变了(取消又重开同一个 prompt、或者又提交了一次)就不算数", () => {
    expect(isCurrentMcpPromptSubmission({ token: 4, sessionId: "session-a" }, expected)).toBe(false);
  });

  it("session 变了(切到另一个会话)就不算数,哪怕 token 没变", () => {
    expect(isCurrentMcpPromptSubmission({ token: 3, sessionId: "session-b" }, expected)).toBe(false);
  });

  it("两个都变了,同样不算数", () => {
    expect(isCurrentMcpPromptSubmission({ token: 9, sessionId: "session-z" }, expected)).toBe(false);
  });
});
