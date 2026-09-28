// daemon.ts 进不了 vitest（import 即连 docker / Supabase）。状态表（#1282）在它身上两处接线，漏了都是安静的：
// 状态永远写不进库（列表静止，与今天一样，没人发现），或者启动归零排在补开房间之后、把刚写回的真状态盖成 idle。
// 所以判据落在源码上（同 daemonNewAgentWiring.test.ts / daemonDecisionWiring.test.ts）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../services/runtime/src/daemon.ts", import.meta.url), "utf8");

describe("daemon.ts：智能体状态的接线（#1282）", () => {
  it("每条会话的 sessionMeta 带上 workspaceId（agent_activity 那一列要它）", () => {
    expect(src).toMatch(/createSupabaseCloudSessionMeta\(supabase, sessionId, \(m\) => console\.warn\(m\), workspaceId\)/);
  });
  it("启动时先归零、再补开房间", () => {
    const reset = src.indexOf("await resetAgentActivity(supabase");
    const reopen = src.indexOf("const { data: cloudSessions, error: cloudErr } = await supabase");
    expect(reset).toBeGreaterThan(-1);
    expect(reopen).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(reopen);
  });
});
