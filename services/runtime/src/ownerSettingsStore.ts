// ownerSettingsStore —— update_settings（#1621）落库的那一半：内存实现（测试）+ Supabase 实现（service role）。
// service role 绕过 RLS 与 friendships 的档位触发器，所以**每一笔都自己按 ownerUid 圈**：notify_prefs 按 uid、
// friendships 只改「我给 TA 的」那一列（myTierColumn）、profiles 按 id、workspace_agents 走 updateAgentChecked。
// 车道朝向与名册不在这里写（那是会话 / 名册缓存的事），由 daemon 以回调注入。
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FriendTier } from "../../../src/shared/friendTier.js";
import { myTierColumn, type FriendTierRow } from "../../../src/shared/friendTier.js";
import { prefsFromRow, prefsToRow, type NotifyPrefs } from "../../../src/shared/notifyPrefs.js";
import type { PairFacing } from "../../../src/shared/pairChat.js";
import type { QuietWindow, ReportPlan } from "../../../src/shared/quietHours.js";
import { updateAgentChecked } from "../../../src/shared/agentAdmin.js";
import { listAgentNames, setPublicAgent, updateAgentRow } from "../../../src/shared/supabaseWorkspacesApi.js";
import type { OwnerSettingsStore } from "./settingsTool.js";

export interface InMemoryOwnerSettings extends OwnerSettingsStore {
  notify: Map<string, { quiet: QuietWindow | null; report: ReportPlan | null; tz: string | null; push: NotifyPrefs; reportNextAt: number | null }>;
  tiers: Map<string, FriendTier>;
  facings: { friendUid: string; facing: PairFacing }[];
  publicAgent: Map<string, string | null>;
  agentPatches: { agentId: string; patch: Record<string, unknown> }[];
  names: Map<string, string>;
}

export function createInMemoryOwnerSettings(o: { friends?: { uid: string; name: string }[]; agents?: { agentId: string; name: string }[]; refuseFacing?: string | null } = {}): InMemoryOwnerSettings {
  const s: InMemoryOwnerSettings = {
    notify: new Map(), tiers: new Map(), facings: [], publicAgent: new Map(), agentPatches: [], names: new Map(),
    async writeNotify(uid, patch) {
      const cur = s.notify.get(uid) ?? { quiet: null, report: null, tz: null, push: prefsFromRow(null), reportNextAt: 1 };
      s.notify.set(uid, {
        quiet: patch.quiet !== undefined ? patch.quiet : cur.quiet,
        report: patch.report !== undefined ? patch.report : cur.report,
        tz: patch.tz !== undefined ? patch.tz : cur.tz,
        push: { ...cur.push, ...(patch.push ?? {}) },
        reportNextAt: patch.quiet !== undefined || patch.report !== undefined || patch.tz !== undefined ? null : cur.reportNextAt,
      });
    },
    friendsOf: async () => o.friends ?? [],
    async setFriendTier(_uid, friendUid, tier) { s.tiers.set(friendUid, tier); },
    async setLaneFacing(_ws, _uid, friendUid, facing) { if (o.refuseFacing) return o.refuseFacing; s.facings.push({ friendUid, facing }); return null; },
    agentsOf: async () => o.agents ?? [],
    async setPublicAgent(uid, agentId) { s.publicAgent.set(uid, agentId); },
    async updateAgent(_ws, agentId, patch) { s.agentPatches.push({ agentId, patch }); },
    async setProfileName(uid, name) { s.names.set(uid, name); },
  };
  return s;
}

export interface SupabaseOwnerSettingsDeps {
  client: SupabaseClient;
  /** 主人的好友（accepted）——同外联那条路的 friendsOf（名字现取） */
  friendsOf(uid: string): Promise<{ uid: string; name: string }[]>;
  /** 主场名册（走 agentsCache） */
  agentsOf(workspaceId: string): Promise<{ agentId: string; name: string }[]>;
  /** 改完一只之后名册快照作废（同 agentWriter.create 那一格） */
  invalidateAgents(workspaceId: string): void;
  /** 车道朝向走会话那条路（daemon 的 updateChat：查友谊、公开时补管理员、落 chat_roster_changed） */
  setLaneFacing(workspaceId: string, uid: string, friendUid: string, facing: PairFacing): Promise<string | null>;
}

export function createSupabaseOwnerSettings(d: SupabaseOwnerSettingsDeps): OwnerSettingsStore {
  const { client } = d;
  return {
    async writeNotify(uid, patch) {
      const row: Record<string, unknown> = { uid, updated_at: new Date().toISOString() };
      if (patch.quiet !== undefined) row.quiet = patch.quiet;
      if (patch.report !== undefined) row.report = patch.report;
      if (patch.tz !== undefined) row.tz = patch.tz;
      // 三格任一变了就把认领指针清空，runtime 下一拍重排（同手机 setQuietSettings）
      if (patch.quiet !== undefined || patch.report !== undefined || patch.tz !== undefined) row.report_next_at = null;
      if (patch.push !== undefined) {
        // 开关是四格一起 upsert 的：先读现状再合并，别把没提的那几格抹成默认
        const cur = await client.from("notify_prefs").select("agent_reply,mentions,friends,read_receipts").eq("uid", uid).maybeSingle();
        if (cur.error) throw new Error(`读推送开关失败：${cur.error.message}`);
        const merged = prefsToRow(uid, { ...prefsFromRow(cur.data), ...patch.push });
        delete merged.updated_at;
        Object.assign(row, merged);
      }
      const { error } = await client.from("notify_prefs").upsert(row, { onConflict: "uid" });
      if (error) throw new Error(error.code === "42703" ? "服务器还没准备好这一项（迁移 0062 没跑）" : `没存上：${error.message}`);
    },
    friendsOf: (uid) => d.friendsOf(uid),
    async setFriendTier(uid, friendUid, tier) {
      const res = await client.from("friendships").select("requester,addressee").eq("status", "accepted")
        .or(`and(requester.eq.${uid},addressee.eq.${friendUid}),and(requester.eq.${friendUid},addressee.eq.${uid})`).maybeSingle();
      if (res.error) throw new Error(`查好友失败：${res.error.message}`);
      if (res.data === null) throw new Error("他已经不在好友名单里了");
      const r = res.data as FriendTierRow;
      const col = myTierColumn(r, uid);
      const up = await client.from("friendships").update({ [col]: tier }).eq("requester", r.requester).eq("addressee", r.addressee);
      if (up.error) throw new Error(`没存上：${up.error.message}`);
    },
    setLaneFacing: (ws, uid, friendUid, facing) => d.setLaneFacing(ws, uid, friendUid, facing),
    agentsOf: (ws) => d.agentsOf(ws),
    setPublicAgent: (uid, agentId) => setPublicAgent(client, uid, agentId),
    async updateAgent(workspaceId, agentId, patch) {
      await updateAgentChecked({ listAgentNames, updateAgentRow }, client, workspaceId, agentId, patch);
      d.invalidateAgents(workspaceId);
    },
    async setProfileName(uid, name) {
      const { error } = await client.from("profiles").update({ name }).eq("id", uid);
      if (error) throw new Error(`没存上：${error.message}`);
    },
  };
}
