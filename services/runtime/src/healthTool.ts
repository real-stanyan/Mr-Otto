// read_health（#1656，spec §2.1 / §3.2）：读说话人自己那台开着 Otto 的 iPhone 上的 Apple 健康，按天汇总。
// 工具不碰网络与 fs（硬规则）：取 cid 与等结果都经注入的 HealthGateway（daemon 给 healthBroker）。
// cid 在**调用时**现选：手机回前台会换一条新连接，turn 开始时那条可能已经没了。
// 不过审批门：是说话人本人在问，而且只读他自己的手机；谁的哪一轮能用由 healthTurnEligible 判。

import { formatHealthForModel, HEALTH_MAX_SPAN_DAYS, HEALTH_METRICS, parseHealthQuery, READ_HEALTH_TOOL } from "../../../src/shared/health.js";
import type { Tool } from "../../../src/tools/tool.js";
import type { HealthBroker } from "./healthBroker.js";

export const READ_HEALTH_TOOL_NAME = READ_HEALTH_TOOL;

export type HealthGateway = Pick<HealthBroker, "cidOf" | "request">;

/** 这一轮能不能读健康数据：人亲口说的（人亲口 = 这一轮覆盖的每一条开场白都是同一个人亲手发的，没有招呼 / 接力；
    系统替人落的开场白带着人的 fromUid，不能凭它算亲口——soleSpeaker 由调用方按开场白逐条核）。不是接力棒 / 定时任务 / 汇报 / 重启补跑；主场里（个人空间、私密车道、
    好友群）只认主人——客人那一轮读不到主人的手机，也不该读他们自己的（数据会落进主人的日志）。团队会话里哪位成员
    亲口都行：读的是他自己的手机，回答在他自己选的群里 */
export function healthTurnEligible(t: {
  approveAll: boolean; ownerUid: string; initiator: string | null;
  depth: number; routine: boolean; report: boolean; rerun: boolean; soleSpeaker: boolean;
}): boolean {
  if (t.initiator === null || t.initiator === "system") return false;
  if (!t.soleSpeaker) return false;
  if (t.depth > 0 || t.routine || t.report || t.rerun) return false;
  return t.approveAll ? t.initiator === t.ownerUid : true;
}

/** allowed：调用那一刻这一轮还算「人亲口」吗（sessionService 传 healthTurn）。引擎的工具表中途只长不缩（engine
    refreshToolsKeepingNames：模型见过的名字必须还查得到），所以一轮中途别人的话折进来之后，tools() 不亮它也撤不掉
    已经亮出去的这把刀——闸得落在调用口上 */
export function createReadHealthTool(deps: { gateway: HealthGateway; initiator: () => string | null; allowed: () => boolean }): Tool {
  return {
    def: {
      name: READ_HEALTH_TOOL_NAME,
      description:
        "读正在和你说话的这个人自己 iPhone 上的 Apple 健康数据（按天汇总：步数、距离、活动能量、爬楼、锻炼时长、站立、睡眠分期、" +
        "心率、静息心率、HRV、血氧、体重、体脂、体能训练）。只在他问到自己的运动、睡眠、身体指标时用。" +
        `日期是他手机的本地日历，闭区间，跨度最多 ${HEALTH_MAX_SPAN_DAYS} 天；「今天」以系统提示里的日期为准。` +
        "某一类读出来是空的，可能是他没授权那一类，也可能是没记录——照实说，不要猜数。",
      parameters: {
        type: "object",
        properties: {
          metrics: { type: "array", items: { type: "string", enum: [...HEALTH_METRICS] }, minItems: 1, description: "要读哪几类" },
          from: { type: "string", description: "起始日期 YYYY-MM-DD" },
          to: { type: "string", description: "结束日期 YYYY-MM-DD（含这一天）" },
        },
        required: ["metrics", "from", "to"],
      },
    },
    requiresApproval: false,
    async run(args, _world, ctx) {
      if (!deps.allowed()) throw new Error("这一轮已经不是他一个人亲口问的了（中途有别人的话并进来），读不了他的健康数据。");
      const q = parseHealthQuery(args);
      if (q === null) {
        throw new Error(`参数不对：metrics 取 ${HEALTH_METRICS.join(" / ")} 里的一个或几个；from、to 是 YYYY-MM-DD，from 不晚于 to，跨度不超过 ${HEALTH_MAX_SPAN_DAYS} 天。`);
      }
      const uid = deps.initiator();
      const cid = uid === null ? null : deps.gateway.cidOf(uid);
      if (cid === null) throw new Error("他的手机现在没连着（Otto App 不在前台），读不到健康数据。可以请他打开 Otto 再问一次。");
      const r = await deps.gateway.request(cid, q, ctx?.signal);
      if (!r.ok) throw new Error(r.error);
      return formatHealthForModel(q, r);
    },
  };
}
