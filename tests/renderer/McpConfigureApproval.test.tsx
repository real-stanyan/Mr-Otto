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
