// tests/edge/pxCloudMerge.test.ts
// mergeEscrow（pxCloud）+ pxGate / grantedView（px）的组合（#1430 终审 M4）。两半各有单测，
// 但 DO 的 grants / call 两个 op 真正跑的是「先合并、再过原来的闸」——这一层是那条路本身：
// 同一个团队同时有桌面那只箱的授权与手机那台的授权、另一个团队只借了手机那台、还有一台要重新登录。

import { describe, expect, it } from "vitest";
import { grantedView, pxGate, workspaceIdsOf, type PxRelations } from "../../services/edge/src/px.js";
import {
  emptyCloudBox, markNeedsLogin, mergeEscrow, setCloudGrant, upsertCloudService, type CloudBox,
} from "../../src/shared/remote/pxCloud.js";
import type { EscrowDoc } from "../../src/shared/remote/pxEscrow.js";

const HOME = "11111111-1111-1111-1111-111111111111";
const TEAM = "22222222-2222-2222-2222-222222222222";
const tool = (name: string) => ({ name, description: "", inputSchema: {} });
const rel = (...ws: string[]): PxRelations => ({ friendAccepted: false, workspaceOk: new Set(ws) });

/** 桌面那只箱：linear 借给主场，只放行 list */
const sealed: EscrowDoc = {
  v: 1, hostUid: "u1", updatedTs: 1,
  services: [{
    serverId: "linear", url: "https://mcp.linear.app/mcp", toolDefs: [tool("list"), tool("delete")],
    oauth: { tokens: { access_token: "LINEAR-AT" } },
  }],
  grants: [{ workspaceId: HOME, allow: [{ serverId: "linear", tools: ["list"] }] }],
};

/** 手机那边：notion（活的，主场 + 借给 TEAM）、github（要重新登录，主场 + 借给 TEAM） */
function box(): CloudBox {
  let b = upsertCloudService(emptyCloudBox("u1", 1), {
    serverId: "cloud-notion", catalogId: "notion", url: "https://mcp.notion.com/mcp",
    oauth: { tokens: { access_token: "NOTION-AT", refresh_token: "RT" }, clientInformation: { client_id: "c" }, tokenEndpoint: "https://t.example/t", resource: "https://mcp.notion.com/" },
    toolDefs: [tool("search")],
  }, HOME, 2);
  b = upsertCloudService(b, {
    serverId: "cloud-github", catalogId: "github", url: "https://api.githubcopilot.com/mcp/",
    headers: { Authorization: "Bearer ghp_secret" }, toolDefs: [tool("issues")],
  }, HOME, 3);
  b = setCloudGrant(b, "cloud-notion", TEAM, true, 4)!;
  b = setCloudGrant(b, "cloud-github", TEAM, true, 5)!;
  return markNeedsLogin(b, "cloud-github", 6);
}

describe("mergeEscrow → pxGate", () => {
  const doc = mergeEscrow(sealed, box())!;

  it("主场成员：桌面那台按它自己的白名单、手机那台整台放行，两份主场授权互不吞", () => {
    expect(pxGate(doc, { fromUid: "u1", serverId: "linear", tool: "list" }, rel(HOME))).toMatchObject({ ok: true, service: { serverId: "linear" } });
    expect(pxGate(doc, { fromUid: "u1", serverId: "linear", tool: "delete" }, rel(HOME))).toMatchObject({ ok: false, code: "tool_not_granted" });
    const notion = pxGate(doc, { fromUid: "u1", serverId: "cloud-notion", tool: "search" }, rel(HOME));
    expect(notion).toMatchObject({ ok: true, service: { serverId: "cloud-notion", url: "https://mcp.notion.com/mcp" } });
    // 投影出去的凭据只有 tokens / clientInformation（tokenEndpoint、resource 留在箱里给续期用）
    if (notion.ok) expect(notion.service.oauth).toEqual({ tokens: { access_token: "NOTION-AT", refresh_token: "RT" }, clientInformation: { client_id: "c" } });
  });

  it("只借了手机那台的团队：够得着 notion，够不着桌面那台主场授权的 linear", () => {
    expect(pxGate(doc, { fromUid: "u2", serverId: "cloud-notion", tool: "search" }, rel(TEAM))).toMatchObject({ ok: true, grant: { workspaceId: TEAM } });
    expect(pxGate(doc, { fromUid: "u2", serverId: "linear", tool: "list" }, rel(TEAM))).toMatchObject({ ok: false, code: "server_not_granted" });
  });

  it("要重新登录的那台对谁都是「没有这台的授权」：合并视图里它连授权带服务一起不在", () => {
    for (const ws of [HOME, TEAM]) {
      expect(pxGate(doc, { fromUid: "u2", serverId: "cloud-github", tool: "issues" }, rel(ws))).toMatchObject({ ok: false, code: "server_not_granted" });
    }
    expect(doc.services.some((s) => s.serverId === "cloud-github")).toBe(false);
    expect(JSON.stringify(doc)).not.toContain("ghp_secret");
  });

  it("不在籍的调用者：一律 not_member，看不出箱里有哪几台、哪台要重新登录", () => {
    for (const serverId of ["cloud-notion", "cloud-github", "linear"]) {
      expect(pxGate(doc, { fromUid: "stranger", serverId, tool: "x" }, rel())).toMatchObject({ ok: false, code: "not_member" });
    }
  });

  it("在籍查询要打的团队全集含两边的授权", () => {
    expect(workspaceIdsOf(doc).sort()).toEqual([HOME, TEAM].sort());
  });
});

describe("mergeEscrow → grantedView", () => {
  const doc = mergeEscrow(sealed, box())!;

  it("主场：桌面那台只列放行的工具、手机那台全列、要重新登录的不列；都不带凭据", () => {
    const v = grantedView(doc, "u1", rel(HOME));
    expect(v.servers).toEqual([
      { serverId: "linear", toolDefs: [tool("list")], workspaceId: HOME },
      { serverId: "cloud-notion", toolDefs: [tool("search")], workspaceId: HOME },
    ]);
    expect(JSON.stringify(v)).not.toMatch(/NOTION-AT|LINEAR-AT|ghp_secret/);
  });

  it("团队：只有借给它的那台", () => {
    expect(grantedView(doc, "u2", rel(TEAM)).servers).toEqual([{ serverId: "cloud-notion", toolDefs: [tool("search")], workspaceId: TEAM }]);
  });

  it("桌面那只箱不在（只有手机那边）：照样合并出一份", () => {
    const only = mergeEscrow(null, box())!;
    expect(grantedView(only, "u1", rel(HOME)).servers.map((s) => s.serverId)).toEqual(["cloud-notion"]);
  });
});
