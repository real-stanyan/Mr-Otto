// @vitest-environment jsdom
//
// Task 9 复审 Important 1：预览数据层（buildApprovalPreview）从第一版起就
// 一直把 args 存成数组，bug 只出在渲染层（App.tsx 的 McpConfigureApproval
// 把 preview.args join(" ") 塞进一个 <pre>）。只测数据层的断言测不出"明天
// 谁把 join(" ") 改回去"这种回归——这里渲染真组件，断言 DOM 里出现了
// **两个**独立的参数值节点，而不是一个 join 后的字符串。
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { McpConfigureApproval } from "../../src/renderer/src/App.js";
import type { McpConfigurePreview } from "../../src/shared/shellBridge.js";

afterEach(() => {
  cleanup();
});

function preview(over: Partial<McpConfigurePreview> = {}): McpConfigurePreview {
  return {
    kind: "mcp_configure",
    server: "fs",
    action: "add",
    transport: "stdio",
    host: null,
    url: null,
    command: "npx",
    args: ["-y", "some pkg"],
    credentialKeys: [],
    enabled: true,
    before: null,
    truncated: { url: false, command: false, args: [false, false] },
    fullLength: { url: 0, command: 4, args: [2, 8] },
    ...over,
  };
}

describe("McpConfigureApproval 的 args 渲染", () => {
  it("每条 arg 是它自己的节点，不折成一句 join 后的字符串", () => {
    render(<McpConfigureApproval preview={preview()} />);
    // 两个参数各自出现在页面上……
    expect(screen.getByText("-y")).toBeInTheDocument();
    expect(screen.getByText("some pkg")).toBeInTheDocument();
    // ……而不是被 join(" ") 粘成一句话
    expect(screen.queryByText("-y some pkg")).not.toBeInTheDocument();
  });
});

// 终审 B Important：enabled 有执行后果（stdio 的 true = 这条 command 会被
// spawn），而它翻转的那一次 command 可能与 before 逐字相同——只显示新值的话
// 卡片会把这次翻转显示成"什么都没变的更新"。
describe("McpConfigureApproval 的 enabled 渲染", () => {
  it("值发生改变时显示「false → true」，而不是只显示 true", () => {
    render(
      <McpConfigureApproval
        preview={preview({
          action: "update",
          command: "rm",
          args: ["-rf", "/"],
          enabled: true,
          before: { url: null, command: "rm", enabled: false, toolCount: 0 },
        })}
      />
    );
    expect(screen.getByText("false → true")).toBeInTheDocument();
    // 而且点破这次调用的后果，不只是把两个字面量摆出来
    expect(screen.getByText(/这次调用会启用这台 server/)).toBeInTheDocument();
  });

  it("反向（启用 → 停用）同样看得出来", () => {
    render(
      <McpConfigureApproval
        preview={preview({
          action: "update",
          enabled: false,
          before: { url: null, command: "npx", enabled: true, toolCount: 3 },
        })}
      />
    );
    expect(screen.getByText("true → false")).toBeInTheDocument();
    expect(screen.getByText(/这次调用会停用这台 server/)).toBeInTheDocument();
  });

  it("没有翻转时不喊狼来了——只显示当前值", () => {
    render(
      <McpConfigureApproval
        preview={preview({
          action: "update",
          enabled: true,
          before: { url: null, command: "npx", enabled: true, toolCount: 3 },
        })}
      />
    );
    expect(screen.queryByText(/这次调用会(启用|停用)/)).not.toBeInTheDocument();
  });

  it("remove 的卡不谈启用状态（enabled 为 null → 这一行不渲染）", () => {
    render(
      <McpConfigureApproval
        preview={preview({
          action: "remove",
          transport: null,
          command: null,
          args: [],
          enabled: null,
          before: { url: "https://x/mcp", command: null, enabled: true, toolCount: 2 },
        })}
      />
    );
    expect(screen.queryByText("enabled")).not.toBeInTheDocument();
  });
});

describe("McpConfigureApproval 的 host / url", () => {
  it("host 独立一行，放在 url 之前，且和 url 分开出现", () => {
    render(
      <McpConfigureApproval
        preview={preview({
          transport: "http",
          command: null,
          args: [],
          host: "evil.com",
          url: "https://mcp.supabase.com" + ".".repeat(50) + "@evil.com/mcp",
          truncated: { url: false, command: false, args: [] },
          fullLength: { url: 0, command: 0, args: [] },
        })}
      />
    );
    expect(screen.getByText("evil.com")).toBeInTheDocument();
  });
});
