// invite_to_call —— agent 把一只不在语音通话里的 agent 拉进通话（#1163）。
//
// 通话进行中只有通话成员参与（维护者拍板）：派活与接力都按名单过滤，于是「这件事该由
// 通话外的人做」时 agent 唯一的出路是把 TA 拉进来。**不过审批门**——拍板的原话是
// 「用户口头同意了就行」，所以「先问用户、用户答应了再调」这条纪律写在提示词里
// （deriveMessages 的通话块），这把刀只管四条判据：没有通话 / 名单里没这个名字 /
// 已经在通话里 / 拉进来。拉进来的后果人立刻看得见（通话栏多一张脸 + 时间线一行
// 「「开发」把测试拉进了通话」），人也能从通话栏把 TA 移出去。
//
// 只依赖注入的三个回调（硬规则「工具只依赖接口」）：不知道 store、不知道 Supabase。
// `invite` 由 sessionService 接成 logVoiceCall——byUid 是点火的那个人（同 create_agent
// 的 created_by，spec §4.2 不给 agent 发伪 uid），byAgentId 是这只自己。
// 参数是**名字**不是 id：模型看得见的只有名字（brief 的花名册不带 id）。

import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import { INVITE_TO_CALL_TOOL_NAME, inVoiceCall, type VoiceCallState } from "../../../src/shared/voiceCall.js";
import { normalizeAgentName } from "../../../src/shared/workspaceAgents.js";

export interface InviteToCallDeps {
  /** 这把刀挂在哪只 agent 的 engine 上 */
  agentId: string;
  /** 此刻的通话名单（sessionService 里那份从日志推进的状态）。null = 没有通话 */
  currentCall: () => VoiceCallState | null;
  /** 此刻的名单（现取，同 relayAfterTurn：这一轮里刚建的那只也要拉得进来）。
      带 `degraded` 的是查询失败的占位——拿它核对会把一次抖动说成「不存在」 */
  roster: () => Promise<{ agentId: string; name: string; degraded?: true }[]>;
  /** 落一条并集名单。这一层不自己拼名单：当前名单是 sessionService 的状态 */
  invite: (target: { agentId: string; name: string }) => void;
}

export function createInviteToCallTool(deps: InviteToCallDeps): Tool {
  return {
    def: {
      name: INVITE_TO_CALL_TOOL_NAME,
      description:
        "把一只不在语音通话里的智能体拉进通话（通话进行中只有通话成员参与）。" +
        "**先问用户要不要拉 TA 进来，用户同意了再调**；用户没同意就别调、也别替 TA 做那件事。" +
        "拉进来之后在回复里 @ TA 的名字就能让 TA 接手。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "要拉进通话的智能体名字（花名册里的那个，不含 @）" },
        },
        required: ["name"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    async run(args: unknown, _world: ExecutionWorld) {
      const raw = (args as { name?: unknown } | null)?.name;
      if (typeof raw !== "string" || raw.trim() === "") throw new Error("invite_to_call: 参数 name 必须是非空字符串");
      const name = normalizeAgentName(raw);
      const call = deps.currentCall();
      if (call === null) throw new Error("现在没有语音通话，不用拉人——直接 @ TA 就行");
      const roster = await deps.roster();
      if (roster.some((a) => a.degraded)) throw new Error("智能体名单这会儿读不出来，稍后再试");
      const target = roster.find((a) => normalizeAgentName(a.name) === name);
      if (!target) throw new Error(`团队里没有叫「${name}」的智能体（看你 briefing 里的花名册）`);
      if (inVoiceCall(call, target.agentId)) return `「${target.name}」已经在通话里了，直接 @${target.name} 就行。`;
      deps.invite({ agentId: target.agentId, name: target.name });
      return `已把「${target.name}」拉进通话，现在可以 @${target.name} 让 TA 接手。`;
    },
  };
}
