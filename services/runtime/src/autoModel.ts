// autoModel（runtime 侧）—— 「Auto」那一档在云会话里的接线（#1009，ADR-0237）。
//
// 判据本体搬去了 `src/shared/autoModel.ts`（#1042）：桌面输入框那枚选择器也长出了
// Auto，两条路共用同一份分类提示词与同一条「认不出来一律 null」的纪律。留在这里的
// 只有 runtime 独有的那一样——**怎么向网关证明身份**：`x-runtime-secret` + on-behalf
// 头替团队所有者调，而桌面带的是用户自己的 JWT。
//
// 触发条件仍然只有一个：这只 agent 的型号白名单是**空**的（界面上的 Auto）。配了型号
// 的 agent 一字不变走 ADR-0232 那条优先级链。

import { AGENT_HEADER, ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER } from "../../../src/shared/billing.js";
import { pickAutoModel as pickShared } from "../../../src/shared/autoModel.js";

export {
  CLASSIFY_MAX_CHARS,
  CLASSIFY_SYSTEM,
  modelForDifficulty,
  parseDifficulty,
  type Difficulty,
} from "../../../src/shared/autoModel.js";

export interface AutoModelDeps {
  edgeBase: string;
  runtimeSecret: string;
  ownerUid: string;
  workspaceId: string;
  sessionId: string;
  agentId?: string;
  fetchImpl?: typeof fetch;
  /** 判不出来时说一声（daemon 的 log）。不抛异常——分类失败不该让 turn 失败 */
  log?: (msg: string) => void;
}

/**
 * 判一手：拿最便宜那款读这段话，回这一 turn 该用的型号 id；判不出来回 null。
 *
 * **走同一条网关、带同样的 workspace/session/agent 头**，所以这一次调用照样落
 * `usage_event`、照样扣所有者的窗口——不做暗扣。代价明写在 issue #1009 里：
 * 约 200 输入 / 5 输出，在最便宜那款上约 $0.00005，外加 0.3~0.8 秒延迟。
 */
export async function pickAutoModel(
  deps: AutoModelDeps,
  text: string,
  models: readonly string[]
): Promise<string | null> {
  return pickShared(
    {
      llmBase: `${deps.edgeBase}/llm/v1`,
      headers: {
        "x-runtime-secret": deps.runtimeSecret,
        [ON_BEHALF_HEADER]: deps.ownerUid,
        [WORKSPACE_HEADER]: deps.workspaceId,
        [SESSION_HEADER]: deps.sessionId,
        ...(deps.agentId ? { [AGENT_HEADER]: deps.agentId } : {}),
      },
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    },
    text,
    models
  );
}
