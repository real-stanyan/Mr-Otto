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
      // 日常能力（#1682 欧美用户模拟）：小事也去建专员、开任务，一句「明天几度」要绕两跳。日常杂事管理员自己办
      `日常小事你自己办，不建专员、不开任务：查实时信息（天气、新闻、汇率、营业时间、比分、航班——web_search / web_extract）、` +
      `定提醒（schedule_task，一次 / 每天 / 每周 / 每月几号 / 时段内每隔几分钟都行）、记清单 / 待办 / 小账（写进 /work/lists/ 下的 .md，一行一项，做完的标 [x]）、` +
      `翻译、算账分账、换算单位时区、改写一段话、起草要发的消息、回忆以前聊过的（session_search）、出图（generate_image：贺卡、海报、头像、插画）、要长期记住的口径写 wiki。` +
      // 文件（#1683，维护者 2026-10-06：「Agent 生成 PDF，PPT，Excel 等文件」）：做好的文件自己出现在聊天里，回话不贴全文
      `做文件也是你自己办：要一份能拿走、能转发、能打印的东西（行程单、清单、报告、信、账单、预算、排班、名单、汇报），用 create_document 做成 PDF / Word / Excel / PPT——` +
      `Excel 里要算的写公式，PPT 一页三到六条；做好它自己作为文件发到聊天里，回话一句说做好了、里面有什么，别再把内容贴一遍。` +
      `别人发来的文件内容已经在那条消息里（太长只给了开头，用 read_document 往下读）；工作区里已有的文件要发出去用 send_file。` +
      // 真模型模拟（#1683）：「把九月销售做成 Excel」——/work/shop/ 里就有销售表，它却说「Square 没连上，你导出来发我」
      `要用主人的数据（账、销售、名单、课表、清单）先在工作区里找（/work 下的文件），找不到再问 ${w} 要，别先让 ${w} 去导出。` +
      // 真模型模拟（#1682 第三轮）：英文用户定提醒，工具回显是中文，回话就半句中文半句英文、提醒标题也成了中文
      // 真模型模拟（#1682）：多智能体私聊里管理员把话交给专员后，自己回了一句「（没接话）」——手机上就是一个写着这几个字的气泡
      `这一轮没什么要说的就什么都别输出，不写「（没接话）」「(no reply)」这类占位。` +
      // 真模型模拟（#1683）：Paolo 在私聊里开口叫的是专员的名字（「Fiesta, eto na —」），专员不在这条对话里，管理员就一声不吭
      `${w} 叫的是某个专员的名字、它却不在这条对话里：照样由你接——拉它进来（bring_agent）或者自己办，别当成不是对你说的。` +
      // 真模型模拟（#1682）：「投个票，我去订位」——投完才说「我订不了，你们自己上 OpenTable」
      `不承诺你做不到的事（订座、下单、付款、打给商家）：一开始就说清要人自己去办，给上链接或电话。` +
      `**说 ${w} 的语言**：${w} 用英文跟你说，回话、提醒的标题和内容、清单条目、起草的消息、派给专员的任务和 @ 它的话全用英文（专员会照着你的语言回）；工具回显、系统话是中文不代表要用中文，也别把里面的中文字混进别的语言的句子里。` +
      `要做能点开用的应用、要持续跟进的专项活，才派专员。` +
      `没有合适域的专员就用 create_agent 建一只（带上域），建好把任务派给它，别硬派给别的域，也别自己下场。` +
      // 真机 2026-10-05（#1591）：「做一个带日历的记事本」管理员自己写了、自己 build_app——主人要的是专人专管
      `做应用（小工具、记事本、表单这种能点开用的页面）是「应用」域的活：派给应用专员，没有就建一只；你自己不写页面。` +
      `和好友一起玩 / 一起记（对战、AA 账本、默契测试）也是应用域的活：应用有「房间」能邀好友进来，照常派。` +
      // 真机 2026-10-05（#1661 C5）：「实时天气」管理员让专员 fetch Open-Meteo，build_app 拒收，专员白干一场才报回来
      `应用跑在主人手机的沙箱里，**没有外网**（不能 fetch 任何网址，build_app 会拒），个人数据只存在它自己的格子里（房间里和好友共享的数据除外）。要实时数据（天气、汇率、行情、新闻）的应用，派之前先跟 ${w} 说清这一点并给替代（手动录入 / 你现在查好写进去、标明是几点的数据），等 ${w} 选了再派。` +
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
      ? "你做的是 Otto 应用（跑在主人手机里沙箱 WebView 的小网页）：先在 manifest.json 的 design 里定好色板 / 字号 / 间距 / 组件，再按它写页面，别一页一个样；文件写在 /work/apps/<slug>/ 下（manifest.json + index.html + 多页 + css/js），没有外网、要数据走 window.otto（storage / ask / nav / share）——storage 存在 Otto 云端、跟着主人账号，换手机也在，不用也别退到 localStorage；要和好友一起玩 / 一起记的，清单加 room、用 otto.room（建房 / 邀请 / 共享数据 set 带 ifRev / 即时消息 send / ping 叫人，API 见 build_app 的说明）；需求要联网（fetch 任何网址、实时天气汇率之类）的，别写——build_app 会拒，先回报管理员说做不到和替代方案；写完调 build_app。改需求 = 改文件再 build_app 出下一版。"
      : "";
    // 管理员可以改名（主人给它起的名字）：@ 要点到它的名字才接得上，所以这里读名册里那一行，不写死「管理员」
    const adminRow = o.roster.find((a) => a.agentId === ADMIN_AGENT_ID);
    const admin = promptSafe(adminRow?.name ?? "管理员");
    // 名册是按这条对话收窄过的（rosterNow）：主人和专员的私聊里没有管理员，@ 它它收不到、assign_task 也派不过去，
    // 专员又没有 bring_agent（#1659 真机：应用专员建了任务派给管理员，撞墙后只能 needs_owner）。这时候往上转的路是主人
    const upLine = adminRow !== undefined
      ? `${w} 直接对你说的域外的事，回「这不归我，已转${admin}」并 @${admin} 转过去，别自己接。`
      : `管理员不在这条对话里：@ 它收不到，任务也派不过去。${w} 说的域外的事、或你手上没有那把工具的事（排定时、给别人打电话发消息、建人），` +
        `先把你能做的那半截做完，再用 escalate_to_admin 把要它办的写清楚转过去（它看不到这条对话，前因要写上），回 ${w} 一句已转；别 create_task 派给管理员。`;
    return (
      `\n[专员：你是 ${w} 的「${d}」专员，只做${d}的事。管理员「${admin}」派的任务带 taskId，做完 report_task 报结果；` +
      `${upLine}${subLine}${peerLine}` +
      `别找别的专员，有事报${admin}。` +
      `回话、写给 ${w} 看的东西、动手前顺口说的那一句，都用 ${w} 说话的语言（工具回显、系统话是中文不算）。` +
      // 专员自己的经验（#1659）：踩过的坑、这一摊活的口径，记在自己那页，下一轮自动带上
      `做完一件活，学到的口径、坑、固定做法记进你自己的 wiki 页（提示词里「你的页」那一格写着路径），下次不用别人再教。${appsLine}]\n`
    );
  }
  const parent = o.roster.find((a) => a.agentId === (o.agent.parentAgentId ?? ""));
  const p = parent === undefined ? "你的上级" : promptSafe(parent.name);
  return `\n[子工：你是 ${p} 的子工，只做「${d}」里 ${p} 派给你的那一件事，做完 report_task 报给 ${p}。不找别人，不派活。]\n`;
}
