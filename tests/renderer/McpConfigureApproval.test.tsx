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
    truncated: { server: false, url: false, command: false, args: [false, false] },
    fullLength: { server: 2, url: 0, command: 4, args: [2, 8] },
    ...over,
  };
}

// #472：模型不带 env/headers 更新一台已配好的 server 时，旧凭据键被整批丢掉
// ——一台能用的 server 在一次「更新」后变成 401，而这一项此前不在用户签的
// 字里。update 的卡要把「改之前 / 改之后」的键名集合并排画出来，掉键要点破。
describe("McpConfigureApproval 的凭据键渲染（#472）", () => {
  it("更新丢掉旧凭据键时显示「旧 → 新」并点破后果", () => {
    render(
      <McpConfigureApproval
        preview={preview({
          action: "update",
          transport: "http",
          command: null,
          args: [],
          host: "mcp.example.com",
          url: "https://mcp.example.com/mcp",
          credentialKeys: [],
          before: {
            url: "https://mcp.example.com/mcp",
            command: null,
            enabled: true,
            toolCount: 3,
            credentialKeys: ["Authorization"],
          },
          truncated: { server: false, url: false, command: false, args: [] },
          fullLength: { server: 2, url: 27, command: 0, args: [] },
        })}
      />
    );
    expect(screen.getByText("Authorization → （不含凭据）")).toBeInTheDocument();
    expect(screen.getByText(/这次更新会去掉凭据键/)).toBeInTheDocument();
  });

  it("键名集合没变时不画箭头也不告警", () => {
    render(
      <McpConfigureApproval
        preview={preview({
          action: "update",
          credentialKeys: ["TOKEN"],
          before: { url: null, command: "npx", enabled: true, toolCount: 3, credentialKeys: ["TOKEN"] },
        })}
      />
    );
    expect(screen.getByText("TOKEN")).toBeInTheDocument();
    expect(screen.queryByText(/→/)).not.toBeInTheDocument();
    expect(screen.queryByText(/去掉凭据键/)).not.toBeInTheDocument();
  });

  it("新增（没有 before）时照旧只显示这次配的键", () => {
    render(<McpConfigureApproval preview={preview({ credentialKeys: ["TOKEN"] })} />);
    expect(screen.getByText("TOKEN")).toBeInTheDocument();
    expect(screen.queryByText(/→/)).not.toBeInTheDocument();
  });
});

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
          before: { url: null, command: "rm", enabled: false, toolCount: 0, credentialKeys: [] },
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
          before: { url: null, command: "npx", enabled: true, toolCount: 3, credentialKeys: [] },
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
          before: { url: null, command: "npx", enabled: true, toolCount: 3, credentialKeys: [] },
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
          before: { url: "https://x/mcp", command: null, enabled: true, toolCount: 2, credentialKeys: [] },
        })}
      />
    );
    expect(screen.queryByText("enabled")).not.toBeInTheDocument();
  });
});

/** 卡上每一行的 (标签, 值)，按 DOM 里的真实先后顺序。
    Field / Row 都是「一个 div.flex.flex-col.gap-[2px]，第一个 <span> 是标签，
    <pre> 是值」——顺序断言要的就是这份序列。 */
function rows(container: HTMLElement): { label: string; value: string | null }[] {
  return [...container.querySelectorAll('div[class*="gap-[2px]"]')].map((row) => ({
    label: row.querySelector("span")?.textContent ?? "",
    value: row.querySelector("pre")?.textContent ?? null,
  }));
}

const labelIndex = (container: HTMLElement, label: string): number =>
  rows(container).findIndex((r) => r.label === label);

// 终审 C 8+9：Task 9 经过两轮修复才换来这条防线——卡上有一个独立的、永不
// 截断的 host 字段，渲染在 url 那一行**之前**：无论 url 字符串怎么变形、
// 多长、被截成什么样，"到底连哪个主机"永远在折叠线以上。
// 这条用例名从第一版起就承诺了"host 独立一行、放在 url 之前"，但测试体只
// 断言了 getByText("evil.com") 存在——顺序和不截断两件都没断，把 host 那行
// 挪到 url 后面、或者给它加上截断，这条照样绿。
describe("McpConfigureApproval 的 host / url", () => {
  const attack = (over = {}) =>
    preview({
      transport: "http",
      command: null,
      args: [],
      host: "evil.com",
      url: "https://mcp.supabase.com" + ".".repeat(50) + "@evil.com/mcp",
      truncated: { server: false, url: false, command: false, args: [] },
      fullLength: { server: 2, url: 0, command: 0, args: [] },
      ...over,
    });

  it("host 独立一行，DOM 顺序上真的排在 url 之前", () => {
    const { container } = render(<McpConfigureApproval preview={attack()} />);
    const hostAt = labelIndex(container, "host");
    const urlAt = labelIndex(container, "url");
    expect(hostAt).toBeGreaterThanOrEqual(0);
    expect(urlAt).toBeGreaterThanOrEqual(0);
    expect(hostAt).toBeLessThan(urlAt);
    // 值也确实分家：host 那行是完整主机名，不是从 url 串里现切的一段
    expect(rows(container)[hostAt]?.value).toBe("evil.com");
  });

  it("host 值永不截断——它旁边不该出现「只显示前 N 字符」那句告警", () => {
    const { container } = render(<McpConfigureApproval preview={attack()} />);
    const hostRow = [...container.querySelectorAll('div[class*="gap-[2px]"]')].find(
      (r) => r.querySelector("span")?.textContent === "host"
    );
    expect(hostRow?.textContent).toContain("evil.com");
    expect(hostRow?.textContent).not.toMatch(/只显示前/);
  });

  // server 是完全由模型控制的 id，且渲染在 host 之前——不设上限的话，几千
  // 字符的 id 能把这条唯一的安全闸挤下折叠线
  it("server 是几千字符时，host 行仍在 url 之前、host 值仍然完整", () => {
    const { container } = render(
      <McpConfigureApproval
        preview={attack({
          // 主进程会截到 200；这里模拟"截断之后"的样子，连同它的告警一起渲染
          server: "S".repeat(200),
          truncated: { server: true, url: false, command: false, args: [] },
          fullLength: { server: 5000, url: 0, command: 0, args: [] },
        })}
      />
    );
    const hostAt = labelIndex(container, "host");
    expect(hostAt).toBeLessThan(labelIndex(container, "url"));
    expect(rows(container)[hostAt]?.value).toBe("evil.com");
    // 而且截断这件事说出来了，不是静默吞掉
    expect(screen.getByText(/只显示前 200 字符，共 5000/)).toBeInTheDocument();
  });
});
