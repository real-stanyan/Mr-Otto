// @vitest-environment jsdom
//
// 设置页「权限」栏目（issue #370）：两份文件的可视化 + 撤销/删除。
// 验收对照 issue：审批产出的规则在设置页看得见、删得掉，删除后热生效
// （热生效那半在 store 层测试里钉——removeAlwaysAllow/removeExecRule 写盘，
// 审批链现读；这里钉 UI 的往返：列表可读化、按钮返程、坏文件的错误展示）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { PermissionsSettings } from "../../src/renderer/src/components/PermissionsSettings.js";
import { SidebarProvider } from "../../src/renderer/src/components/ui/sidebar.js";
import { grantKeysFor } from "../../src/shared/grantKey.js";
import type { PermissionsSnapshot } from "../../src/shared/shellBridge.js";

const [npmTestKey] = grantKeysFor({ name: "bash", args: { cmd: "npm test" } }, "/proj/a");

const snapshot = (over: Partial<PermissionsSnapshot> = {}): PermissionsSnapshot => ({
  grants: [npmTestKey!, "bash"],
  execRules: [{ pattern: ["npm", "test"], decision: "allow", cwd: "/proj/a" }],
  ...over,
});

function renderPage() {
  return render(
    <SidebarProvider>
      <PermissionsSettings />
    </SidebarProvider>
  );
}

afterEach(cleanup);

describe("PermissionsSettings", () => {
  it("永久授权 key 可读化展示（cmd key 拼回命令，旧条目标宽语义）", async () => {
    vi.stubGlobal("window", Object.assign(window, {
      otter: { listPermissions: vi.fn(async () => snapshot()) },
    }));
    renderPage();
    // 出现两处：授权 key 的 detail + exec 规则的 pattern（同一条命令两种身份）
    expect(await screen.findAllByText("npm test")).toHaveLength(2);
    expect(screen.getByText(/旧条目/)).toBeInTheDocument();
  });

  it("撤销走 revokeGrant，返回的快照直接刷新列表", async () => {
    const revokeGrant = vi.fn(async () => snapshot({ grants: ["bash"] }));
    vi.stubGlobal("window", Object.assign(window, {
      otter: { listPermissions: vi.fn(async () => snapshot()), revokeGrant },
    }));
    renderPage();
    await screen.findAllByText("npm test");
    await userEvent.click(screen.getAllByTitle("撤销这条授权")[0]!);
    expect(revokeGrant).toHaveBeenCalledWith(npmTestKey);
    // 撤销后的快照只剩旧条目 bash 和 exec 规则——授权列表里的 npm test 消失
    await waitFor(() => expect(screen.queryAllByText("npm test")).toHaveLength(1));
  });

  it("删规则走 removeExecRule（整条规则做参数——按内容匹配，不按下标）", async () => {
    const removeExecRule = vi.fn(async () => snapshot({ execRules: [] }));
    vi.stubGlobal("window", Object.assign(window, {
      otter: { listPermissions: vi.fn(async () => snapshot()), removeExecRule },
    }));
    renderPage();
    await screen.findByTitle("删除这条规则");
    await userEvent.click(screen.getByTitle("删除这条规则"));
    expect(removeExecRule).toHaveBeenCalledWith({
      pattern: ["npm", "test"],
      decision: "allow",
      cwd: "/proj/a",
    });
  });

  it("execPolicy 文件坏了：展示 loadExecPolicy 的 error（规则未生效的 fail-safe 口径）", async () => {
    vi.stubGlobal("window", Object.assign(window, {
      otter: {
        listPermissions: vi.fn(async () =>
          snapshot({ execRules: [], execError: "execPolicy.json 不是合法 JSON：..." })
        ),
      },
    }));
    renderPage();
    expect(await screen.findByText(/不是合法 JSON/)).toBeInTheDocument();
    expect(screen.getByText(/规则未生效/)).toBeInTheDocument();
  });

  it("空态讲清楚这两份文件是什么", async () => {
    vi.stubGlobal("window", Object.assign(window, {
      otter: { listPermissions: vi.fn(async () => ({ grants: [], execRules: [] })) },
    }));
    renderPage();
    expect(await screen.findByText("还没有永久授权。")).toBeInTheDocument();
    expect(screen.getByText("还没有规则。")).toBeInTheDocument();
    expect(screen.getByText(/审批卡上点「永久允许」落在这里/)).toBeInTheDocument();
  });
});
