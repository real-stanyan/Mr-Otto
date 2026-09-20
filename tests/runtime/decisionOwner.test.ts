import { describe, expect, it } from "vitest";
import { requestDecisionAsOwner } from "../../services/runtime/src/decisionOwner.js";
import { AGENT_HEADER, ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER } from "../../src/shared/billing.js";
import { noul } from "../../src/shared/decision.js";

describe("requestDecisionAsOwner：替团队所有者调 /llm/v1/decision", () => {
  const req = { model: "jev-1.13", use: "dispatch" as const, state: "x", questions: { act: noul("q", "y", "n") } };
  const run = async (agentId?: string) => {
    const seen: Request[] = [];
    const fetchImpl = (async (i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(i, init));
      return Response.json({ model: "jev-1.13.0", answers: { act: { type: "noul", noul: 0.5 } } });
    }) as typeof fetch;
    const r = await requestDecisionAsOwner(
      { edgeBase: "https://edge", runtimeSecret: "s3", ownerUid: "owner-1", workspaceId: "ws-1", sessionId: "cs-1", fetchImpl, ...(agentId ? { agentId } : {}) },
      req, 500,
    );
    return { r, sent: seen[0]! };
  };
  it("四个头齐全，打的是 /llm/v1/decision", async () => {
    const { r, sent } = await run();
    expect(r?.answers.act).toEqual({ type: "noul", noul: 0.5 });
    expect(sent.url).toBe("https://edge/llm/v1/decision");
    expect(sent.headers.get("x-runtime-secret")).toBe("s3");
    expect(sent.headers.get(ON_BEHALF_HEADER)).toBe("owner-1");
    expect(sent.headers.get(WORKSPACE_HEADER)).toBe("ws-1");
    expect(sent.headers.get(SESSION_HEADER)).toBe("cs-1");
    expect(sent.headers.get(AGENT_HEADER)).toBeNull(); // 不属于任何一只 agent 的调用：空 = 未归因（ADR-0221）
  });
  it("给了 agentId 才带 agent 头（Auto 那一处是替某一只判的）", async () => {
    expect((await run("dev")).sent.headers.get(AGENT_HEADER)).toBe("dev");
  });
});
