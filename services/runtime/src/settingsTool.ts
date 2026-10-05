// update_settings —— 管理员按主人要求改 Otto 设置（#1621）。判据在 src/shared/ownerSettings.ts；这里只管找对象、写、复述。
// 只依赖注入的 OwnerSettingsStore（硬规则「工具只依赖接口」）：不知道 Supabase。
// 挂给谁由 sessionService 判（L0 + 主场 + 私聊）；亮不亮由 available 判（主人亲口的那一轮，同 routineTools）。
import type { Tool } from "../../../src/tools/tool.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import type { FriendTier } from "../../../src/shared/friendTier.js";
import type { NotifyPrefs } from "../../../src/shared/notifyPrefs.js";
import type { PairFacing } from "../../../src/shared/pairChat.js";
import type { QuietWindow, ReportPlan } from "../../../src/shared/quietHours.js";
import { SETTING_DOC, SETTING_KEYS, UPDATE_SETTINGS_TOOL_NAME, parseSettingsArgs, settingsChangedText } from "../../../src/shared/ownerSettings.js";
import { resolveFriend } from "../../../src/shared/outreach.js";

export interface OwnerSettingsStore {
  /** notify_prefs 那一行：quiet / report / tz 三格与四个推送开关。缺席的格子不动（upsert 合并） */
  writeNotify(uid: string, patch: { quiet?: QuietWindow | null; report?: ReportPlan | null; tz?: string; push?: Partial<NotifyPrefs> }): Promise<void>;
  /** 主人的好友（只认 accepted） */
  friendsOf(uid: string): Promise<{ uid: string; name: string }[]>;
  setFriendTier(uid: string, friendUid: string, tier: FriendTier): Promise<void>;
  /** 和这位朋友的车道朝向；回一句拒绝的话或 null（没有车道 / 档位不够都在这里说） */
  setLaneFacing(workspaceId: string, uid: string, friendUid: string, facing: PairFacing): Promise<string | null>;
  /** 主场的名册（找名字用） */
  agentsOf(workspaceId: string): Promise<{ agentId: string; name: string }[]>;
  setPublicAgent(uid: string, agentId: string | null): Promise<void>;
  updateAgent(workspaceId: string, agentId: string, patch: { name?: string; description?: string; instructions?: string }): Promise<void>;
  setProfileName(uid: string, name: string): Promise<void>;
}

export interface SettingsToolDeps {
  workspaceId: string;
  ownerUid: string;
  store: OwnerSettingsStore;
  /** 主人亲口的那一轮才亮（同 routineTools） */
  available: () => boolean;
  /** 改完在聊天里落一句系统行，主人不用翻工具回执也看得到 */
  announce: (line: string) => void;
}

const sameName = (a: string, b: string): boolean => a.replace(/\s+/g, "") === b.replace(/\s+/g, "");

export function createSettingsTool(deps: SettingsToolDeps): Tool {
  return {
    def: {
      name: UPDATE_SETTINGS_TOOL_NAME,
      description:
        "按主人的要求改 Otto 的设置，不用他进设置页。主人说「以后十点以后别推送」「周日早上打电话汇报」「把和 Stan 的车道公开」这类话就用它。" +
        "改完把回执里那句「已改：…」告诉主人。涉及给别人看的（车道公开、好友权限、公开智能体）主人没点名对象就问清是谁，别猜。能改的：\n" +
        SETTING_KEYS.map((k) => `- ${k}：${SETTING_DOC[k]}`).join("\n"),
      parameters: {
        type: "object",
        properties: {
          setting: { type: "string", enum: [...SETTING_KEYS] },
          value: { description: "按 setting 的说明给；关掉的传 null" },
          friend: { type: "string", description: "friend_tier / lane_facing 要：朋友的名字" },
          agent: { type: "string", description: "agent 要：那只智能体现在的名字" },
        },
        required: ["setting"],
      },
    },
    exposure: "direct",
    requiresApproval: false,
    available: deps.available,
    async run(args: unknown, _world: ExecutionWorld) {
      const c = parseSettingsArgs(args);
      const { store, ownerUid, workspaceId } = deps;
      const findFriend = async (name: string): Promise<{ uid: string; name: string }> => {
        const m = resolveFriend(await store.friendsOf(ownerUid), name);
        if (m.kind === "one") return { uid: m.uid, name: m.name };
        if (m.kind === "many") throw new Error(`好友里有 ${m.count} 位叫「${name}」，分不出是哪一位，问问主人`);
        throw new Error(m.names.length === 0 ? "主人还没有好友" : `好友里没有叫「${name}」的。有：${m.names.join("、")}。问问主人指的是哪一位`);
      };
      const findAgent = async (name: string): Promise<{ agentId: string; name: string }> => {
        const all = await store.agentsOf(workspaceId);
        const hits = all.filter((a) => sameName(a.name, name));
        if (hits.length === 1) return hits[0]!;
        if (hits.length > 1) throw new Error(`有 ${hits.length} 只都叫「${name}」，问问主人是哪只`);
        throw new Error(`没有叫「${name}」的智能体。有：${all.map((a) => a.name).join("、")}`);
      };
      let text: string;
      switch (c.kind) {
        case "quiet_hours": await store.writeNotify(ownerUid, { quiet: c.window }); text = settingsChangedText(c); break;
        case "report": await store.writeNotify(ownerUid, { report: c.plan }); text = settingsChangedText(c); break;
        case "tz": await store.writeNotify(ownerUid, { tz: c.tz }); text = settingsChangedText(c); break;
        case "push": await store.writeNotify(ownerUid, { push: c.patch }); text = settingsChangedText(c); break;
        case "friend_tier": {
          const f = await findFriend(c.friend);
          await store.setFriendTier(ownerUid, f.uid, c.tier);
          text = settingsChangedText(c, { friend: f.name });
          break;
        }
        case "lane_facing": {
          const f = await findFriend(c.friend);
          const refused = await store.setLaneFacing(workspaceId, ownerUid, f.uid, c.facing);
          if (refused !== null) throw new Error(refused);
          text = settingsChangedText(c, { friend: f.name });
          break;
        }
        case "public_agent": {
          if (c.agent === null) { await store.setPublicAgent(ownerUid, null); text = settingsChangedText(c); break; }
          const a = await findAgent(c.agent);
          await store.setPublicAgent(ownerUid, a.agentId);
          text = settingsChangedText(c, { agent: a.name });
          break;
        }
        case "agent": {
          const a = await findAgent(c.agent);
          await store.updateAgent(workspaceId, a.agentId, c.patch);
          text = settingsChangedText(c, { agent: a.name });
          break;
        }
        case "profile_name": await store.setProfileName(ownerUid, c.name); text = settingsChangedText(c); break;
      }
      deps.announce(text);
      return `${text} 用一句话告诉主人就行。`;
    },
  };
}
