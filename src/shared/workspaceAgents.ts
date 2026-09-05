// workspaceAgents —— 工作区 agent 表单的纯校验（#932 切片 1b）+ 接力上限表单校验
// （#950 Task 9）。桌面设置页用；手机端将来做同一张表单时 import 同一份（纪律同
// workspaces.ts）。DB 那侧的约束（0021：name 1–32 字符、一个工作区不重名）在这里
// 对齐成能提前说出口的人话；重名靠 23505 回来再翻，这里判不了。

import { RELAY_MAX_DEPTH_RANGE } from "./agentRelay.js";

export const AGENT_NAME_MAX = 32;

/** 每个工作区开箱自带的那只（0021 migration 的 seed_workspace_admin_agent
    触发器种的行）。不能删、名单里恒排第一（按 created_at 升序），也是
    "客户端没给 mentions 时唤醒谁"的老语义答案。
    **DB 那侧的触发器与 RLS 里写着同一个字面量**——那半改不了常量，所以这里
    改名字不等于改行为，两边要一起动。 */
export const ADMIN_AGENT_ID = "admin";

export function validateAgentName(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0) return "名字不能为空";
  if (name.length > AGENT_NAME_MAX) return `名字最多 ${AGENT_NAME_MAX} 个字符`;
  if (name.includes("@")) return "名字里不能有 @——它是点名用的前缀";
  if (/[\r\n]/.test(name)) return "名字不能换行";
  // B-I2：零宽字符（Cf，如 U+200B）与其它控制字符（Cc）能造出"肉眼一样、机器不同"的
  // 两个名字，选人弹层/名单点错哪一行都看不出来
  if (/[\p{Cf}\p{Cc}]/u.test(name)) return "名字里不能有不可见字符";
  // B-I2：内部空白（哪怕只有一个空格）会让 @ 补全的边界判据失效——parseMentions
  // 靠"最长匹配"逐字符扫描，一个内嵌空格就能把 @ 后面的文本切错行
  if (/\s/.test(name)) return "名字里不能有空白";
  return null;
}

/** 落库前的归一化（B-I2）：NFKC 把全角/兼容字符折成规范形式（"Ａｄｓ" → "Ads"），
    再 trim。不放进 validateAgentName 本身——校验只读不改，写入路径显式调用这个函数
    才落库，两处职责分开，调用方忘了归一化会在 agentNameConflict/DB 唯一索引那层
    露出来，不会静默生效。 */
export function normalizeAgentName(raw: string): string {
  return raw.normalize("NFKC").trim();
}

/** B-I2 前缀劫持：同名，或一方是另一方的前缀（两个方向）都判冲突——
    "管理员" 与 "管理员帮我" 共存时，"@管理员帮我" 这句话会被 parseMentions 的
    最长匹配算法认成后者，用户以为自己 @ 到了前者。落库前（新建/改名）都要过
    这一关，服务端（agentRegistry 的两个实现）与桌面表单共用同一份判据。 */
export function agentNameConflict(name: string, existing: readonly string[]): string | null {
  for (const other of existing) {
    if (other.length === 0) continue;
    if (name === other || name.startsWith(other) || other.startsWith(name)) {
      return `与已有的「${other}」冲突：一个名字不能是另一个的开头（@ 会认错人）`;
    }
  }
  return null;
}

/** B-C2 短字段折空白：`noNewline` 只挡字面 \r\n，挡不住"一串空格 + pre-wrap 自动换行"
    这条等价的伪造通道（终审实测：66 个空格能把审批卡后半段顶到视觉下一行，效果与真换行
    相同）。把任意一段连续空白（含 tab）折成单个空格，用在 name/description/models[]/
    serverId/工具名这些短字段上——它们的语义都是"一个词/一行"，折叠不丢信息；
    instructions 是卡上本来就该多行的那一段，不套这层。 */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ");
}

export function parseModelList(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(/[,，]/)) {
    const m = piece.trim();
    if (m !== "" && !out.includes(m)) out.push(m);
  }
  return out;
}

/** owner 在智能体 tab 改的「接力上限」输入框校验（#950 Task 9）。范围与
    normalizeRelayMaxDepth 同一份常量（RELAY_MAX_DEPTH_RANGE）——表单能提前
    说人话的判据，与落库时兜底的判据必须是同一条，否则两处会各说各话 */
export function validateRelayMaxDepth(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const errorMsg = `接力上限得是 ${RELAY_MAX_DEPTH_RANGE.min} 到 ${RELAY_MAX_DEPTH_RANGE.max} 之间的整数`;
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, error: errorMsg };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < RELAY_MAX_DEPTH_RANGE.min || n > RELAY_MAX_DEPTH_RANGE.max) {
    return { ok: false, error: errorMsg };
  }
  return { ok: true, value: n };
}
