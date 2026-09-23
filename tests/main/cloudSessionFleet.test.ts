// cloudSessionFleetRow（桌面会话列表 / 灵动岛上的那一行）——从 cloudSessionClient.test.ts
// 拆出来（#1356）：客户端挪进 shared，这一行留在桌面，测试跟着分家。
import { describe, expect, it } from "vitest";
import { cloudSessionFleetRow } from "../../src/main/cloudSessionFleet.js";
import type { CloudSessionSummary } from "../../src/shared/remote/cloudSessionClient.js";
import { flattenFleet, initialIsland, type IslandState } from "../../src/main/islandProjection.js";
import { createWorkspaceLens } from "../../src/main/workspaceLens.js";
import type { ApprovalRequest } from "../../src/shared/shellBridge.js";

function cloudSummary(overrides: Partial<CloudSessionSummary> = {}): CloudSessionSummary {
  return { workspaceId: "w1", sessionId: "cloud-s1", status: "ready", lastEventTs: 12345, ...overrides };
}

// ─── 复审 P0：云会话必须能上原生岛/手机 fleet ──────────────────────────────
// flattenFleet 只遍历它拿到的 sessions 参数、从不反向遍历 islandStates 的
// key——云会话从不 store.append，天生不在本地 sessions 列表里。不补一条虚拟
// SessionSummary 进 sessions 参数，approval_request 命中 self 可批时算好的
// IslandState（含 pendingApproval）永远够不到 flattenFleet 的输出，审批横幅
// 在原生岛/手机上静默不出现。cloudSessionFleetRow 是这个洞的补丁：纯函数，
// index.ts 的 pushFleet 拿它的结果并进真实会话列表一起喂给 flattenFleet。
describe("cloudSessionFleetRow — 复审 P0：云会话上岛", () => {
  it("null，或 connecting/denied/gone 状态：不产出虚拟行", () => {
    expect(cloudSessionFleetRow(null)).toBeNull();
    const statuses: CloudSessionSummary["status"][] = ["connecting", "denied", "gone"];
    for (const status of statuses) {
      expect(cloudSessionFleetRow(cloudSummary({ status }))).toBeNull();
    }
  });

  it("ready：产出一条合成 SessionSummary——sessionId 对得上、workspace 是绝对路径、不是子会话、不是归档", () => {
    const row = cloudSessionFleetRow(cloudSummary({ sessionId: "cloud-s1" }));
    expect(row).not.toBeNull();
    expect(row!.sessionId).toBe("cloud-s1");
    expect(row!.workspace).not.toBeNull();
    // 必须是绝对路径：相对片段会被 path.resolve 拼上 process.cwd()，在 dev
    // checkout 这样的环境里可能意外爬进真实项目的 .git（见文件内那段注释）
    expect(row!.workspace!.startsWith("/")).toBe(true);
    expect(row!.spawnedFrom).toBeNull();
    expect(row!.archived).toBe(false);
  });

  it("lastTs 用 summary.lastEventTs，不是现取 Date.now()（复审 fix round 2 Minor）", () => {
    const row = cloudSessionFleetRow(cloudSummary({ lastEventTs: 424242 }));
    expect(row!.lastTs).toBe(424242); // 精确等于传入值，不是"接近当下"
  });

  it("不同 workspaceId 产出不同的 workspace 分组键（不会把两个不同工作区的云会话混进同一组）", () => {
    const a = cloudSessionFleetRow(cloudSummary({ workspaceId: "w1", sessionId: "s-a" }))!;
    const b = cloudSessionFleetRow(cloudSummary({ workspaceId: "w2", sessionId: "s-b" }))!;
    expect(a.workspace).not.toBe(b.workspace);
  });

  it("与真实 flattenFleet 拼接：ready 的云会话 + islandStates 里的 pendingApproval 一起喂进去，输出里能找到它且带 pendingApproval", () => {
    // 不碰真文件系统：reader 一律回"什么都没有"，等价于这条合成路径一路
    // 找不到 .git，回落到"就地当根"——这正是生产环境里对一个没有真实
    // 对应目录的合成路径会发生的事
    const noFs = { exists: () => false, readFile: () => null };
    const lens = createWorkspaceLens({ reader: noFs });

    const cloudRow = cloudSessionFleetRow(cloudSummary({ sessionId: "cloud-s1" }))!;
    const approval: ApprovalRequest = {
      sessionId: "cloud-s1",
      call: { id: "call-1", name: "bash", args: { summary: "ls -la" } },
      toolDescription: "ls -la",
      availableDecisions: ["approve", "deny"],
    };
    const islandStates = new Map<string, IslandState>([
      ["cloud-s1", { ...initialIsland, sessionId: "cloud-s1", phase: "approval", pendingApproval: approval }],
    ]);

    const fleet = flattenFleet(islandStates, [cloudRow], null, lens);

    const agent = fleet.agents.find((a) => a.sessionId === "cloud-s1");
    expect(agent).toBeDefined();
    expect(agent!.pendingApproval).not.toBeNull();
    expect(agent!.pendingApproval!.callId).toBe("call-1");
  });

  it("云会话不是 ready（比如 gone）：cloudSessionFleetRow 不产出行，flattenFleet 的 sessions 参数里也就没有它——即使 islandStates 里还留着 pendingApproval，也不会出现在 fleet 输出里", () => {
    const noFs = { exists: () => false, readFile: () => null };
    const lens = createWorkspaceLens({ reader: noFs });

    const goneRow = cloudSessionFleetRow(cloudSummary({ status: "gone" }));
    expect(goneRow).toBeNull();

    const approval: ApprovalRequest = {
      sessionId: "cloud-s1",
      call: { id: "call-1", name: "bash", args: {} },
      toolDescription: "ls -la",
    };
    const islandStates = new Map<string, IslandState>([
      ["cloud-s1", { ...initialIsland, sessionId: "cloud-s1", phase: "approval", pendingApproval: approval }],
    ]);
    // 装配方（index.ts 的 pushFleet）在 cloud 为 null 时不会把它拼进 sessions——
    // 这里直接模拟那个决定：sessions 数组里没有这条云会话
    const fleet = flattenFleet(islandStates, [], null, lens);

    expect(fleet.agents.find((a) => a.sessionId === "cloud-s1")).toBeUndefined();
  });
});

describe("cloudSessionFleetRow 的标题（#1280）", () => {
  const base = { workspaceId: "w", sessionId: "s", status: "ready" as const, lastEventTs: 1 };
  it("join 的调用方递了名字就用它：岛上那一行写「运营」不写「云会话」", () => {
    expect(cloudSessionFleetRow({ ...base, title: "运营" })!.title).toBe("运营");
  });
  it("没递（团队会话）照旧写「云会话」", () => {
    expect(cloudSessionFleetRow(base)!.title).toBe("云会话");
  });
});
