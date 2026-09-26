// daemon.ts 进不了 vitest（import 即连 docker / Supabase），「新建的智能体先开口」在它身上的两处接线
// 漏了的失败模式是**安静的**：那一只永远不先开口，或者职责写进去了名单快照却不作废——没有任何一条
// 测试会红。所以判据落在源码上（同 daemonDecisionWiring.test.ts / sandbox.test.ts 的处置）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../services/runtime/src/daemon.ts", import.meta.url), "utf8");

describe("daemon.ts：新建的智能体先开口的接线（#1356 A2）", () => {
  const start = src.indexOf("async create(workspaceId, byUid, chat)");
  const create = src.slice(start, src.indexOf("ownerOf,", start));

  it("只在建出**新**私聊之后问：greetOnCreate 排在新会话那一次 openSessionRoom 之后，只出现一次", () => {
    expect(start).toBeGreaterThan(-1);
    expect(create).toMatch(/const session = openSessionRoom\(workspaceId, sessionId, owner, byUid, home\);[\s\S]*greetOnCreate\(/);
    expect(create.match(/greetOnCreate\(/g)).toHaveLength(1);
    expect(create).toContain("session.greetNewAgent(");
  });
  it("抢那一格走 agentWriter 那一层（与结算职责同一个口）", () => {
    expect(create).toMatch(/claimGreeting: \(w, a\) => agentWriter\.claimGreeting\(w, a\)/);
  });
  it("agentWriter 包装接上了两个新口，职责真写进去才让名单快照作废", () => {
    expect(src).toMatch(/claimGreeting: \(w, a\) => rawAgentWriter\.claimGreeting\(w, a\)/);
    expect(src).toMatch(/const wrote = await rawAgentWriter\.settleRole\(workspaceId, agentId, role\);[\s\S]*?if \(wrote\) agentsCache\.invalidate\(workspaceId\);/);
  });
});
