// ownerSettings —— 管理员按主人要求改 Otto 设置（#1621）的纯逻辑：哪些能改、参数怎么认、改完怎么复述。
// runtime 的 update_settings 按它校验；形状与手机设置页的判据共用（quietHours / notifyPrefs / friendTier / profileEdit）。
//
// 边界（维护者 2026-10-05）：刀只给 L0、只在主场、只在主人亲口的那一轮亮（客人轮 / 汇报轮 / 接力轮不亮）；
// 改完必复述「已改：…（要改回来说一声）」；涉及给别人看的（车道公开、好友档位、公开智能体）主人没点名对象不猜。
import { isFriendTier, TIER_LABEL, type FriendTier } from "./friendTier.js";
import { DEFAULT_NOTIFY_PREFS, type NotifyPrefs } from "./notifyPrefs.js";
import type { PairFacing } from "./pairChat.js";
import { sanitizeName } from "./profileEdit.js";
import { parseQuietWindow, parseReportPlan, quietWindowText, reportPlanText, type QuietWindow, type ReportPlan } from "./quietHours.js";
import { isIanaTimeZone } from "./routines.js";

export const UPDATE_SETTINGS_TOOL_NAME = "update_settings";

export const SETTING_KEYS = ["quiet_hours", "report", "tz", "push", "friend_tier", "lane_facing", "public_agent", "agent", "profile_name"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** 给模型看的一行说明（工具 description 里逐条列） */
export const SETTING_DOC: Record<SettingKey, string> = {
  quiet_hours: "免打扰时段：value = {start:\"22:00\", end:\"08:00\", days?:[1..7]}，null = 关掉",
  report: "定时汇报：value = {mode:\"call\"|\"message\", schedule:{kind:\"daily\",time:\"09:00\"} 或 {kind:\"weekly\",days:[1..7],time:\"09:00\"}}，null = 关掉",
  tz: "时区：value = IANA 名，如 \"Australia/Brisbane\"",
  push: "推送开关：value = {agentReply?, mentions?, friends?, readReceipts?}（布尔，只给要改的）",
  friend_tier: "给某位朋友的权限：friend = 朋友名字，value = \"chat\"（仅聊天）| \"agents\"（可带智能体）| \"full\"（全部开放）",
  lane_facing: "和某位朋友的车道公不公开：friend = 朋友名字，value = \"both\"（公开给 TA）| \"self\"（仅我可见）",
  public_agent: "公开智能体：value = 智能体名字，null = 不公开",
  agent: "改一只智能体：agent = 它现在的名字，value = {name?, description?, instructions?}",
  profile_name: "主人自己的显示名：value = 新名字",
};

export type SettingsChange =
  | { kind: "quiet_hours"; window: QuietWindow | null }
  | { kind: "report"; plan: ReportPlan | null }
  | { kind: "tz"; tz: string }
  | { kind: "push"; patch: Partial<NotifyPrefs> }
  | { kind: "friend_tier"; friend: string; tier: FriendTier }
  | { kind: "lane_facing"; friend: string; facing: PairFacing }
  | { kind: "public_agent"; agent: string | null }
  | { kind: "agent"; agent: string; patch: { name?: string; description?: string; instructions?: string } }
  | { kind: "profile_name"; name: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** 工具参数 → 一条改动；形状不对就抛一句模型能照着改的话 */
export function parseSettingsArgs(args: unknown): SettingsChange {
  const a = isObj(args) ? args : {};
  const setting = a.setting;
  if (!(SETTING_KEYS as readonly unknown[]).includes(setting)) throw new Error(`setting 要是其中之一：${SETTING_KEYS.join(" / ")}`);
  const value = a.value;
  switch (setting as SettingKey) {
    case "quiet_hours": {
      if (value === null) return { kind: "quiet_hours", window: null };
      const w = parseQuietWindow(value);
      if (w === null) throw new Error("免打扰时段要是 {start:\"HH:MM\", end:\"HH:MM\", days?:[1..7]}，开始结束不能一样；关掉传 null");
      return { kind: "quiet_hours", window: w };
    }
    case "report": {
      if (value === null) return { kind: "report", plan: null };
      const p = parseReportPlan(value);
      if (p === null) throw new Error("汇报要是 {mode:\"call\"|\"message\", schedule:{kind:\"daily\"|\"weekly\", time:\"HH:MM\", days?:[1..7]}}；关掉传 null");
      return { kind: "report", plan: p };
    }
    case "tz": {
      const tz = str(value);
      if (!isIanaTimeZone(tz)) throw new Error("时区要是 IANA 名，如 Australia/Brisbane");
      return { kind: "tz", tz };
    }
    case "push": {
      if (!isObj(value)) throw new Error("推送开关要是 {agentReply?, mentions?, friends?, readReceipts?}，布尔");
      const patch: Partial<NotifyPrefs> = {};
      for (const k of Object.keys(DEFAULT_NOTIFY_PREFS) as (keyof NotifyPrefs)[]) {
        if (value[k] === undefined) continue;
        if (typeof value[k] !== "boolean") throw new Error(`${k} 要是布尔`);
        patch[k] = value[k] as boolean;
      }
      if (Object.keys(patch).length === 0) throw new Error("至少给一个开关");
      return { kind: "push", patch };
    }
    case "friend_tier": {
      const friend = str(a.friend);
      if (friend === "") throw new Error("friend 要写朋友的名字——主人没点名就问他是哪位");
      if (!isFriendTier(value)) throw new Error("value 要是 chat / agents / full");
      return { kind: "friend_tier", friend, tier: value };
    }
    case "lane_facing": {
      const friend = str(a.friend);
      if (friend === "") throw new Error("friend 要写朋友的名字——主人没点名就问他是哪位");
      if (value !== "both" && value !== "self") throw new Error("value 要是 both（公开给 TA）或 self（仅我可见）");
      return { kind: "lane_facing", friend, facing: value };
    }
    case "public_agent": {
      if (value === null) return { kind: "public_agent", agent: null };
      const agent = str(value);
      if (agent === "") throw new Error("value 要写智能体的名字，或 null 表示不公开");
      return { kind: "public_agent", agent };
    }
    case "agent": {
      const agent = str(a.agent);
      if (agent === "") throw new Error("agent 要写它现在的名字");
      if (!isObj(value)) throw new Error("value 要是 {name?, description?, instructions?}");
      const patch: { name?: string; description?: string; instructions?: string } = {};
      if (value.name !== undefined) patch.name = str(value.name);
      if (value.description !== undefined) patch.description = typeof value.description === "string" ? value.description.trim() : "";
      if (value.instructions !== undefined) patch.instructions = typeof value.instructions === "string" ? value.instructions.trim() : "";
      if (Object.keys(patch).length === 0) throw new Error("至少改一样：name / description / instructions");
      if (patch.name !== undefined && patch.name === "") throw new Error("名字不能是空的");
      return { kind: "agent", agent, patch };
    }
    case "profile_name": {
      const name = sanitizeName(str(value));
      if (name === "") throw new Error("名字不能是空的");
      return { kind: "profile_name", name };
    }
  }
}

const PUSH_LABEL: Record<keyof NotifyPrefs, string> = { agentReply: "智能体回答", mentions: "有人 @ 我", friends: "朋友消息", readReceipts: "已读回执" };

/** 改完复述给主人的那句（也是工具回执的主体）。`resolved` 里是实际落到的对象名（朋友 / 智能体现在叫什么） */
export function settingsChangedText(c: SettingsChange, resolved: { friend?: string; agent?: string } = {}): string {
  const tail = "（要改回来说一声）";
  switch (c.kind) {
    case "quiet_hours": return `已改：免打扰${c.window === null ? "关了" : `设成 ${quietWindowText(c.window)}`}${tail}`;
    case "report": return `已改：定时汇报${c.plan === null ? "关了" : `设成 ${reportPlanText(c.plan)}`}${tail}`;
    case "tz": return `已改：时区设成 ${c.tz}${tail}`;
    case "push": return `已改：${(Object.keys(c.patch) as (keyof NotifyPrefs)[]).map((k) => `${PUSH_LABEL[k]}${c.patch[k] ? "开" : "关"}`).join("、")}${tail}`;
    case "friend_tier": return `已改：给 ${resolved.friend ?? c.friend} 的权限设成「${TIER_LABEL[c.tier]}」——TA 那边看到的也跟着变${tail}`;
    case "lane_facing": return `已改：和 ${resolved.friend ?? c.friend} 的车道${c.facing === "both" ? "公开给 TA 了，TA 看得到你的智能体在里面说的话" : "改成仅你可见了"}${tail}`;
    case "public_agent": return `已改：${c.agent === null ? "不再公开智能体" : `公开智能体设成「${resolved.agent ?? c.agent}」——朋友能直接 @ 它`}${tail}`;
    case "agent": {
      const parts: string[] = [];
      if (c.patch.name !== undefined) parts.push(`改名叫「${c.patch.name}」`);
      if (c.patch.description !== undefined) parts.push("职责改了");
      if (c.patch.instructions !== undefined) parts.push("说明改了");
      return `已改：「${resolved.agent ?? c.agent}」${parts.join("、")}${tail}`;
    }
    case "profile_name": return `已改：你的显示名改成「${c.name}」${tail}`;
  }
}
