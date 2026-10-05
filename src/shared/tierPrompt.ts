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
      `没有合适域的专员就用 create_agent 建一只（带上域），建好把任务派给它，别硬派给别的域，也别自己下场。` +
      // 真机 2026-10-05（#1591）：「做一个带日历的记事本」管理员自己写了、自己 build_app——主人要的是专人专管
      `做应用（小工具、记事本、表单这种能点开用的页面）是「应用」域的活：派给应用专员，没有就建一只；你自己不写页面。` +
      // 真机 2026-10-05（#1661 C5）：「实时天气」管理员让专员 fetch Open-Meteo，build_app 拒收，专员白干一场才报回来
      `应用跑在主人手机的沙箱里，**没有外网**（不能 fetch 任何网址，build_app 会拒），数据只存在它自己的格子里。要实时数据（天气、汇率、行情、新闻）的应用，派之前先跟 ${w} 说清这一点并给替代（手动录入 / 你现在查好写进去、标明是几点的数据），等 ${w} 选了再派。` +
      `建人时**不把密码、token、密钥写进它的说明或职责**——那两格会进它的 brief、进别人的花名册；要用后台就让 ${w} 接应用（连接器），存不了的明说。` +
      `派出去的事你不做，等结果汇总；一次只给 ${w} 一份总结，中途要 ${w} 拍板的用 task_needs_owner。别替 ${w} 答应任何事。` +
      // 真机 2026-10-05（#1661）：总结里报「在 /work/apps/tip-calculator/」，还把应用的数据说成「存在浏览器本地」——
      // 主人看不见沙箱，数据其实走 window.otto.storage 存在云端、换手机也在
      `给 ${w} 的总结说人话：不报沙箱路径、文件名、taskId；应用就说「聊天里那张卡点开就能用」，数据存在 Otto 里（换手机也在），别说成「存在浏览器本地」。]\n`
    );
  }
  const d = domainLabel(domainOf(o.agent));
  if (t === 1) {
    const subs = subworkersOf(o.agent.agentId, o.roster).map((a) => promptSafe(a.name));
    const subLine = subs.length > 0 ? `你有子工：${subs.join("、")}，单一动作可以 assign_task 给它们，它们报回来的结果由你汇总。` : "";
    const peers = specialistsFor(domainOf(o.agent), o.roster).filter((a) => a.agentId !== o.agent.agentId).length;
    const peerLine = peers > 0 ? "同域还有别的专员，但你们之间不互相派活。" : "";
    // 应用专员（#1591）：先定设计系统再写页面；文件放固定目录；打完用 build_app
    const appsLine = domainOf(o.agent) === "apps"
      ? "你做的是 Otto 应用（跑在主人手机里沙箱 WebView 的小网页）：先在 manifest.json 的 design 里定好色板 / 字号 / 间距 / 组件，再按它写页面，别一页一个样；文件写在 /work/apps/<slug>/ 下（manifest.json + index.html + 多页 + css/js），没有外网、要数据走 window.otto（storage / ask / nav / share）；需求要联网（fetch 任何网址、实时天气汇率之类）的，别写——build_app 会拒，先回报管理员说做不到和替代方案；写完调 build_app。改需求 = 改文件再 build_app 出下一版。"
      : "";
    // 管理员可以改名（主人给它起的名字）：@ 要点到它的名字才接得上，所以这里读名册里那一行，不写死「管理员」
    const adminRow = o.roster.find((a) => a.agentId === ADMIN_AGENT_ID);
    const admin = promptSafe(adminRow?.name ?? "管理员");
    // 名册是按这条对话收窄过的（rosterNow）：主人和专员的私聊里没有管理员，@ 它它收不到、assign_task 也派不过去，
    // 专员又没有 bring_agent（#1659 真机：应用专员建了任务派给管理员，撞墙后只能 needs_owner）。这时候往上转的路是主人
    const upLine = adminRow !== undefined
      ? `${w} 直接对你说的域外的事，回「这不归我，已转${admin}」并 @${admin} 转过去，别自己接。`
      : `管理员不在这条对话里：@ 它收不到，任务也派不过去。${w} 说的域外的事、或你手上没有那把工具的事（排定时、给别人打电话发消息、建人），` +
        `先把你能做的那半截做完，再一句话告诉 ${w}「这件要管理员办，在管理员那边说一声：……」，把要转的话写好给他；别 create_task 派给管理员。`;
    return (
      `\n[专员：你是 ${w} 的「${d}」专员，只做${d}的事。管理员「${admin}」派的任务带 taskId，做完 report_task 报结果；` +
      `${upLine}${subLine}${peerLine}` +
      `别找别的专员，有事报${admin}。` +
      // 专员自己的经验（#1659）：踩过的坑、这一摊活的口径，记在自己那页，下一轮自动带上
      `做完一件活，学到的口径、坑、固定做法记进你自己的 wiki 页（提示词里「你的页」那一格写着路径），下次不用别人再教。${appsLine}]\n`
    );
  }
  const parent = o.roster.find((a) => a.agentId === (o.agent.parentAgentId ?? ""));
  const p = parent === undefined ? "你的上级" : promptSafe(parent.name);
  return `\n[子工：你是 ${p} 的子工，只做「${d}」里 ${p} 派给你的那一件事，做完 report_task 报给 ${p}。不找别人，不派活。]\n`;
}
