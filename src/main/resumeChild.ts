// 恢复一个子会话（ADR-0047）—— 与 subagentRunner 的"创建口"对称的那个"重建口"。
//
// 为什么单独成一个模块，而不是塞在 index.ts 的 resumeSession 里：这里是
// "子 agent 不能再派子 agent"（ADR-0047 决定 5）的第二个把守点。创建那一侧靠
// subagentRunner 刻意不传 subagentRunner 挡住；恢复这一侧曾经压根不知道
// "会话还可能是子会话"这回事，于是一个 tools: read_file / approval: deny 的
// 搜索员 resume 回来时带着 bash、write_file 和 task 工具（review I1）——
// 而 resume 恰恰是查看子会话的唯一途径（时间线那张卡、"回到父会话"都走它）。
//
// createChildAgent 的参数表里**没有 subagentRunner 这一项**：递归不再靠
// "记得别传"，靠类型系统。

import { createAgent, type AgentPush, type SkillLibrary } from "./agent.js";
import type { ExecRule } from "../shared/execPolicy.js";
import { denyingApprover } from "./uiApprover.js";
import type { EventStore } from "../session/store.js";
import type { AttachmentStore } from "../session/attachments.js";
import type { BrowserCapability, McpCapability } from "../world/executionWorld.js";
import type { SessionEvent } from "../session/events.js";
import type { AutoCompactSettings } from "../shared/autoCompact.js";

/** 一个子会话当初那副装备。审批模式（ask/auto）不在这里：它是运行时偏好、
    从来没落过盘，而重建只信快照（ADR-0048 决策 3），所以 `deny` 现在恒为 true ——
    比 ADR-0047 当初接受的"回默认 ask"更紧。字段留着不折叠成常量：它是
    createChildAgent 的输入契约，那一侧要能表达"这次不拒绝"，哪怕今天没人这么传。 */
export interface ChildAgentConfig {
  agent: string;
  allowTools: readonly string[];
  deny: boolean;
}

/**
 * 从一份会话日志里认出"这是谁派出来的子会话"，并把它当初那副装备找回来。
 *
 * 不是子会话 → null（调用方照旧按主会话装配）。
 *
 * **只信 `subagent_briefed` 快照，不读磁盘定义**（ADR-0048 决策 3）。快照是
 * append-only 日志的一部分 —— 事实来源；磁盘上那份 .md 是可变的外部状态，用它
 * 重建等于让一个历史会话的内容随文件改动而改写，与"任何投影必须可从日志推导"
 * 直接冲突。曾经这里是"磁盘优先、快照兜底"，代价是用户改一改 tools 就能给一个
 * 历史子会话换副装备。
 *
 * 审批档快照里没有（它从来没落过盘），所以重建一律按最严的 deny —— 推不出来
 * 就不能替用户假设它松。
 *
 * **不存在"认不出就当主 agent 建"这条退路**——那等于删掉一个 md 文件
 * 就能把一个只读搜索员提权成带 bash + task 的全权 agent。
 */
export function childAgentConfig(events: readonly SessionEvent[]): ChildAgentConfig | null {
  const first = events[0];
  // kind === "side"（/btw 旁聊，issue #502）：可见性借子会话口径，但它是按
  // 主会话装配建的全权 agent——resume 也回主装配，不按 subagent 白名单收权。
  // 旧日志没有 kind → undefined ≠ "side"，照旧按子会话重建（向后兼容）
  if (!first || first.type !== "session_created" || !first.spawnedBy || first.spawnedBy.kind === "side") return null;
  const briefed = events.find((e) => e.type === "subagent_briefed");
  return {
    agent: first.spawnedBy.agent,
    // 连快照都没有（理论不可达：briefed 一定在子会话开头那几条里——不一定是第 1 条，
    // switchModel 跑在 append 之前,model_changed 可能占掉 seq 1,所以上面按 `.find()`
    // 取而不按位置取）= 一把工具都不给。
    // 宁可这个会话只能看不能动，也不给它一副来路不明的装备
    allowTools: briefed?.type === "subagent_briefed" ? briefed.tools : [],
    deny: true,
  };
}

/** 按 config 重建一个子 agent。签名里没有 subagentRunner，所以重建出来的
    这一位永远没有 task 工具——递归到此为止，与创建那一侧一字不差。 */
export function createChildAgent(opts: {
  store: EventStore;
  workspace: string;
  resumeSessionId: string;
  push: AgentPush;
  attachments: AttachmentStore;
  config: ChildAgentConfig;
  getAccessToken?: () => Promise<string | null>;
  makeBrowser?: (sessionId: string) => BrowserCapability;
  alwaysAllow?: () => ReadonlySet<string>;
  /** execpolicy 规则现读器（issue #347，同 alwaysAllow 的活引用规矩）：
      forbidden 对子 agent 同样生效，用户写的"永不放行"不被派活绕过 */
  execPolicy?: () => { rules: ExecRule[] };
  /** MCP 能力（ADR-0054）。这里必须显式传：重建走的是新造的 LocalWorld，
      父 agent 可能早已不在内存里，没有一个带着 withMcp 的 world 可以继承。
      给了也只是**挂载**——config.allowTools 那份白名单里没点名的 mcp__… 照样过滤掉，
      与活着那一侧（subagentRunner 复用父 world）是同一套规则 */
  mcp?: McpCapability;
  /** 自动压缩设置的现读器（同 alwaysAllow 的活引用规矩）。子会话也该守同一份
      设置——不给 = 走 createAgent 的全局默认 */
  autoCompactSettings?: () => AutoCompactSettings;
  /** skill 库（ADR-0122 / issue #482）。同 mcp 的理由必须显式传：重建走的是
      新造的 LocalWorld，没有父 world 可继承。
      **给了也只是挂载**——`config.allowTools` 那份白名单说了算，而快照记的
      `tools` 是当初**实际挂上**的那几把（subagentRunner 落 briefed 时写的是
      `child.toolDefs.map(...)`，不是定义文件里写的那几个字）。于是
      `skills: "none"` 的子 agent 当初根本没挂上 "skill"，快照里也就没有它，
      恢复回来照样没有——「不被行为 skill 污染」这条不靠这一侧记得别传，
      靠快照本身。skill 功能之前的旧日志同理：那时候没有这把刀，快照里没有。 */
  skills?: SkillLibrary;
}): ReturnType<typeof createAgent> {
  // 刻意不传 history：重建出来的子会话没有 world.history，session_search 工具
  // 不会挂上去。活着的子会话（subagentRunner.ts）复用 `parent.world`——同一个
  // world 实例，history 早就在里面；这里是新造一个 LocalWorld，没有父 world
  // 可继承，也没必要单独焊一个：子会话本来就该只查自己那段，不该反过来
  // 翻别的历史会话（ADR-0065 排除子会话同一个道理）
  return createAgent({
    store: opts.store,
    workspace: opts.workspace,
    resumeSessionId: opts.resumeSessionId,
    push: opts.push,
    attachments: opts.attachments,
    allowTools: opts.config.allowTools,
    ...(opts.getAccessToken ? { getAccessToken: opts.getAccessToken } : {}),
    ...(opts.makeBrowser ? { makeBrowser: opts.makeBrowser } : {}),
    ...(opts.mcp ? { mcp: opts.mcp } : {}),
    ...(opts.skills ? { skills: opts.skills } : {}),
    ...(opts.autoCompactSettings ? { autoCompactSettings: opts.autoCompactSettings } : {}),
    // deny 换掉整条审批链（mode/授权都不参与）；否则走常规链——永久授过权的
    // 工具在子 agent 里照样免问（授权授的是工具，不是会话），同创建那一侧
    ...(opts.config.deny
      ? { approver: denyingApprover }
      : {
          ...(opts.alwaysAllow ? { alwaysAllow: opts.alwaysAllow } : {}),
          // forbidden 规则跟着常规链走（同创建侧 subagentRunner）
          ...(opts.execPolicy ? { execPolicy: opts.execPolicy } : {}),
        }),
    // 刻意不传 subagentRunner —— 这个参数在本函数的签名里根本不存在
  });
}
