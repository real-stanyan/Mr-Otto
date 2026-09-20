// decisionOwner —— runtime 替**团队所有者**问决策模型（#1281）。
//
// runtime 独有的只有一样：怎么向网关证明身份（`x-runtime-secret` + on-behalf 头，云会话
// 统一走所有者的订阅额度，ADR-0233）。问什么、怎么验回包都在三端共用的 decision.ts 里。
// 这四个头原来在 autoModel / dispatch / sessionTitler 里各抄了一遍；这里是第四处用到它们
// 的地方，先收成一个函数——那三处不在这次改动的射程里，不顺手动。

import { AGENT_HEADER, ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER } from "../../../src/shared/billing.js";
import { requestDecision, type DecisionReply, type DecisionRequest } from "../../../src/shared/decision.js";

export interface OwnerDecisionDeps {
  edgeBase: string;
  runtimeSecret: string;
  ownerUid: string;
  workspaceId: string;
  sessionId: string;
  /** 只有「替某一只 agent 判」的调用才带（Auto）。派活 / 重命名不属于任何一只：
      `usage_event.agent_id` 空串 = 未归因（ADR-0221） */
  agentId?: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export function requestDecisionAsOwner(deps: OwnerDecisionDeps, req: DecisionRequest, timeoutMs: number): Promise<DecisionReply | null> {
  return requestDecision(
    {
      llmBase: `${deps.edgeBase}/llm/v1`,
      headers: {
        "x-runtime-secret": deps.runtimeSecret,
        [ON_BEHALF_HEADER]: deps.ownerUid,
        [WORKSPACE_HEADER]: deps.workspaceId,
        [SESSION_HEADER]: deps.sessionId,
        ...(deps.agentId ? { [AGENT_HEADER]: deps.agentId } : {}),
      },
      timeoutMs,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    },
    req,
  );
}
