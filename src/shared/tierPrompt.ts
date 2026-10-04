// tierPrompt —— 三级各自在主场里加的那一段提示词（#1571，spec §5）。纯字符串，runtime 第 2 步接进 deriveMessages。
// 好友车道那一段（delegationRolePrompt，ADR-0363）照旧，这里只管主人自己的主场。
import { domainLabel } from "./agentDomain.js";
import { domainOf, specialistsFor, subworkersOf, tierOf, type TieredAgent } from "./agentTier.js";
import { promptSafe } from "./promptSafe.js";
import { ADMIN_AGENT_ID } from "./workspaceAgents.js";

export interface NamedAgent extends TieredAgent {
  name: string;
}

/** 「现有专员与域」那一句：按域分组，没专员的域不写 */
function specialistLines(roster: readonly NamedAgent[]): string {
  const byDomain = new Map<string, string[]>();
  for (const a of roster) {
    if (tierOf(a) !== 1) continue;
    const d = domainOf(a);
    byDomain.set(d, [...(byDomain.get(d) ?? []), promptSafe(a.name)]);
  }
  return [...byDomain.entries()].map(([d, names]) => `${domainLabel(d)}：${names.join("、")}`).join("；");
}

export function tierPrompt(o: { agent: NamedAgent; ownerName: string; roster: readonly NamedAgent[] }): string {
  const w = promptSafe(o.ownerName);
  const t = tierOf(o.agent);
  if (t === 0) {
    const lines = specialistLines(o.roster);
    const have = lines === "" ? `${w} 还没有专员。` : `现有专员（按域）：${lines}。`;
    return (
      `\n[管理员：你是 ${w} 的管理员。${w} 的要求你先判断：一句话能答完、不用动手、不用查的，直接做；` +
      `其余拆成任务（create_task），按域派给专员（assign_task）。${have}` +
      `没有合适域的专员就提议建一只（task_needs_owner 里写清要什么域、干什么），别硬派给别的域。` +
      `建人时**不把密码、token、密钥写进它的说明或职责**——那两格会进它的 brief、进别人的花名册；要用后台就让 ${w} 接应用（连接器），存不了的明说。` +
      `派出去的事你不做，等结果汇总；一次只给 ${w} 一份总结，中途要 ${w} 拍板的用 task_needs_owner。别替 ${w} 答应任何事。]\n`
    );
  }
  const d = domainLabel(domainOf(o.agent));
  if (t === 1) {
    const subs = subworkersOf(o.agent.agentId, o.roster).map((a) => promptSafe(a.name));
    const subLine = subs.length > 0 ? `你有子工：${subs.join("、")}，单一动作可以 assign_task 给它们，它们报回来的结果由你汇总。` : "";
    const peers = specialistsFor(domainOf(o.agent), o.roster).filter((a) => a.agentId !== o.agent.agentId).length;
    const peerLine = peers > 0 ? "同域还有别的专员，但你们之间不互相派活。" : "";
    // 管理员可以改名（主人给它起的名字）：@ 要点到它的名字才接得上，所以这里读名册里那一行，不写死「管理员」
    const admin = promptSafe(o.roster.find((a) => a.agentId === ADMIN_AGENT_ID)?.name ?? "管理员");
    return (
      `\n[专员：你是 ${w} 的「${d}」专员，只做${d}的事。管理员「${admin}」派的任务带 taskId，做完 report_task 报结果；` +
      `${w} 直接对你说的域外的事，回「这不归我，已转${admin}」并 @${admin} 转过去，别自己接。${subLine}${peerLine}` +
      `别找别的专员，有事报${admin}。]\n`
    );
  }
  const parent = o.roster.find((a) => a.agentId === (o.agent.parentAgentId ?? ""));
  const p = parent === undefined ? "你的上级" : promptSafe(parent.name);
  return `\n[子工：你是 ${p} 的子工，只做「${d}」里 ${p} 派给你的那一件事，做完 report_task 报给 ${p}。不找别人，不派活。]\n`;
}
