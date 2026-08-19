import { describe, it, expect, vi } from "vitest";
import { browserReadTool } from "../../src/tools/browserRead.js";
import type { ExecutionWorld, BrowserReadResult } from "../../src/world/executionWorld.js";

function worldWith(read: (o?: unknown) => Promise<BrowserReadResult>): ExecutionWorld {
  return {
    fs: { read: async () => "", write: async () => {} },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    http: { postJson: async () => ({}) },
    browser: { read },
  };
}

const bare: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

describe("browser_read 工具", () => {
  it("不审批 —— 纯读不落地,照 web_extract", () => {
    expect(browserReadTool.requiresApproval).toBe(false);
  });

  it("把 url 透传给 world.browser.read", async () => {
    const read = vi.fn(async () => ({ url: "https://a.com", title: "A", text: "正文", truncated: false }));
    const out = await browserReadTool.run({ url: "https://a.com" }, worldWith(read));
    expect(read).toHaveBeenCalledWith({ url: "https://a.com" });
    expect(String(out)).toContain("正文");
    expect(String(out)).toContain("https://a.com");
  });

  it("不给 url = 读当前页", async () => {
    const read = vi.fn(async () => ({ url: "https://cur.com", title: "当前", text: "内容", truncated: false }));
    await browserReadTool.run({}, worldWith(read));
    expect(read).toHaveBeenCalledWith({});
  });

  it("截断了要在输出里说 —— 不说的话模型会把半页当整页用", async () => {
    const read = async () => ({ url: "https://a.com", title: "A", text: "长", truncated: true });
    const out = String(await browserReadTool.run({}, worldWith(read)));
    expect(out).toContain("截断");
  });

  it("world 没有浏览器能力 = 抛,不静默返回空", async () => {
    await expect(browserReadTool.run({}, bare)).rejects.toThrow(/浏览器/);
  });

  it("url 不是 http(s) = 抛 —— file:// 能读到本机任意文件,不该由模型随口指定", async () => {
    const read = vi.fn(async () => ({ url: "", title: "", text: "", truncated: false }));
    await expect(browserReadTool.run({ url: "file:///etc/passwd" }, worldWith(read))).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it("底层抛什么就往上抛什么 —— 错误信息是给模型下一步决策用的", async () => {
    const read = async () => { throw new Error("页面加载失败：NAME_NOT_RESOLVED（-105）"); };
    await expect(browserReadTool.run({ url: "https://nope.invalid" }, worldWith(read)))
      .rejects.toThrow(/NAME_NOT_RESOLVED/);
  });
});
