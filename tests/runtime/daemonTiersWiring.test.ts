// 分级在 daemon 里的接线（#1571，ADR-0367）：名单查询带上三列（单独一条、容错）、缺管理员自愈、bring/dismiss 改名单后写
// workspace_sessions.agent_ids。daemon.ts 进不了 vitest，读源码钉住；正则不依赖换行（工作区可能是 CRLF）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../services/runtime/src/daemon.ts", import.meta.url), "utf8");

describe("daemon：分级", () => {
  it("三列单独一条、容错：读不到就不带（判据层按 agentId 派生）", () => {
    expect(src).toMatch(/\.select\("agent_id,tier,domain,parent_agent_id"\)\.eq\("workspace_id", workspaceId\)/);
    expect(src).toMatch(/if \(!tiers\.error\) \{/);
    expect(src).toMatch(/\.\.\.\(isAgentTier\(r\.tier\) \? \{ tier: r\.tier \} : \{\}\)/);
  });
  it("缺管理员就补一只再查一次", () => {
    expect(src).toMatch(/if \(!rows\.some\(\(r: \{ agent_id: string \}\) => r\.agent_id === ADMIN_AGENT_ID\)\) \{/);
    expect(src).toMatch(/await rawAgentWriter\.ensureAdmin\(workspaceId, ownerUid\)/);
    expect(src).toMatch(/ensureAdmin: \(w, u\) => rawAgentWriter\.ensureAdmin\(w, u\),/);
  });
  it("管理员改了名单：写 workspace_sessions.agent_ids", () => {
    expect(src).toMatch(/onRosterChanged: async \(agentIds\) => \{\s*const \{ error \} = await supabase\.from\("workspace_sessions"\)\.update\(\{ agent_ids: agentIds \}\)\.eq\("id", sessionId\);/);
  });
});
