// 「智能体」侧页的内容（#1566 → #1574 → #1571 第 4 步）：**员工表**，不是聊天列表。
// 人只对人和自己的管理员说话（ADR-0367）：管理员那条私聊留在聊天主页；这里列主场里的 L0 / L1（`visibleAgents`，L2 在它上级的
// 资料页里），每行：脸 + 名字 + 「专员 · 出行」+ 状态行（空闲 / 执行中 · 任务：明天出游 › 订票 / 执行中 · 在〈群〉）。
// 点一行**进它的私聊**（维护者 2026-10-05 真机：「从侧页点击智能体应该直接进入聊天窗口」）；资料页从聊天信息页进。
// 头像右上角照聊天列表那样压未读：它想完了发来一句就亮一枚（点数 / 点），点进去看过就灭（seenStore 的游标）。
// 不再左滑删聊天：删人在资料页。
// 底下一格抽屉「别人的智能体」照旧：那是别人的智能体跟我的**对话**（外联会话，#1441），默认收着。
import { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { agentStatusText, workspaceAgentWhere } from "../../../src/shared/agentActivityRows.js";
import type { AgentActivity } from "../../../src/shared/agentActivity.js";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { domainLabel } from "../../../src/shared/agentDomain.js";
import { domainOf, TIER_LABEL, tierOf, visibleAgents } from "../../../src/shared/agentTier.js";
import { liveTaskOf, taskLine } from "../../../src/shared/tasks.js";
import { splitInbox } from "../../../src/shared/wechatInbox.js";
import { ActivityFace } from "../activity/ActivityFace.js";
import { CountBadge, DotBadge } from "../wx/Badge.js";
import { useActivity } from "../activity/activityStore.js";
import { useHome } from "../home/homeStore.js";
import type { ChatRoute } from "../nav/types.js";
import { ChatListRow, CHAT_ROW_SEP } from "../tabs/ChatListRow.js";
import { ContactRow } from "../tabs/ContactsScreen.js";
import { useTasks } from "../tasks/tasksStore.js";
import { space, usePalette } from "../theme.js";
import { useNow } from "../ui.js";
import { Fold } from "../wx/Fold.js";
import { SwipeRow } from "../wx/SwipeRow.js";
import { hideChat } from "./hiddenStore.js";
import { useSeenStore } from "./seenStore.js";
import { useInbox } from "./useInbox.js";

/** 点了侧页里的什么：一条聊天（管理员的私聊 / 别人的智能体的对话）或一只员工的资料页 */
export type PanelPick = { kind: "chat"; route: ChatRoute } | { kind: "agent"; agentId: string };

export function AgentPanel({ onPick }: { onPick: (pick: PanelPick) => void }) {
  const { c } = usePalette();
  const home = useHome();
  const inbox = useInbox();
  const activity = useActivity();
  const tasks = useTasks();
  const { drafts } = useSeenStore();
  const now = useNow(30_000);
  const ws = home.home;
  const split = useMemo(() => splitInbox(inbox.rows), [inbox.rows]);
  /** 群名（在忙的那条会话是个群时写进状态里）：私聊不算——那一行本身就是那条私聊 */
  const groupTitle = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of split.main) if (r.target.kind !== "friend" && r.target.kind !== "agent") m.set(r.target.sessionId, r.title);
    return (sid: string): string | null => m.get(sid) ?? null;
  }, [split.main]);
  const staff = visibleAgents(ws?.agents ?? []);
  /** 每只的会话行（含管理员那条——它在聊天主页，但侧页这一行也要亮未读）：agentId → 行 */
  const chatRow = useMemo(() => {
    const m = new Map<string, (typeof inbox.rows)[number]>();
    for (const r of inbox.rows) if (r.target.kind === "agent") m.set(r.target.agentId, r);
    return m;
  }, [inbox.rows]);
  const sep = <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: CHAT_ROW_SEP }} />;
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ paddingTop: 4, paddingBottom: 40 }}>
        {ws === null ? (
          <Text style={{ fontSize: 14, color: c.mutedForeground, paddingHorizontal: 16, paddingVertical: 8 }}>订阅之后才有自己的智能体。</Text>
        ) : staff.length === 0 ? (
          <Text style={{ fontSize: 14, color: c.mutedForeground, paddingHorizontal: 16, paddingVertical: 8 }}>还没有智能体。跟管理员说你要办什么，它会按需雇人。</Text>
        ) : (
          <View style={{ backgroundColor: c.card }}>
            {staff.map((a, i) => {
              const where = workspaceAgentWhere(activity.rows, ws.id, a.agentId, now);
              const task = where === null || where.activity === "idle" ? null : liveTaskOf(tasks.rows.values(), a.agentId, where.sessionId);
              const status = task === null
                ? agentStatusText(where, groupTitle)
                : `${agentStatusText(where, () => null)} · ${taskLine(task, (id) => tasks.rows.get(id)?.title ?? null)}`;
              const busy = where !== null && where.activity !== "idle";
              const role = `${TIER_LABEL[tierOf(a)]} · ${domainLabel(domainOf(a))}`;
              const row = chatRow.get(a.agentId);
              return (
                <View key={a.agentId}>
                  {i === 0 ? null : sep}
                  <ContactRow
                    first
                    avatar={
                      <View>
                        <ActivityFace slot={agentFaceSlot(ws, a.agentId)} size={48} activity={where?.activity ?? null} ring={c.card} badgeSize={10} />
                        {row?.unread?.kind === "count" ? (
                          <View style={{ position: "absolute", top: -6, right: -7 }}><CountBadge n={row.unread.n} ring={c.card} /></View>
                        ) : row?.unread?.kind === "dot" || row?.mention === true ? (
                          <View style={{ position: "absolute", top: -3, right: -3 }}><DotBadge ring={c.card} /></View>
                        ) : null}
                      </View>
                    }
                    name={a.name}
                    sub={role}
                    right={
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 5, maxWidth: "45%" }}>
                        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: busy ? c.brand : c.faint }} />
                        <Text numberOfLines={1} style={{ fontSize: 12, color: busy ? c.brand : c.faint }}>{status}</Text>
                      </View>
                    }
                    onPress={() =>
                      onPick({ kind: "chat", route: { kind: "agent", agentId: a.agentId } })
                    }
                  />
                </View>
              );
            })}
          </View>
        )}

        {split.others.length > 0 ? (
          <Fold id="agents-others" label="别人的智能体" count={split.others.length} defaultClosed>
            <Text style={{ fontSize: 12, color: c.faint, paddingHorizontal: 16, paddingBottom: 6 }}>朋友的智能体跟你的对话。它们的状态由对方那边管。</Text>
            <View style={{ backgroundColor: c.card }}>
              {split.others.map((r, i) => (
                <View key={r.key}>
                  {i === 0 ? null : sep}
                  <SwipeRow onDelete={() => hideChat(r.key, r.ts)}>
                    <ChatListRow row={r} draft={drafts.get(r.key) ?? ""} now={now} onPress={() => { if (r.target.kind === "outreach") onPick({ kind: "chat", route: r.target }); }} />
                  </SwipeRow>
                </View>
              ))}
            </View>
          </Fold>
        ) : null}

        {ws !== null && staff.length > 0 ? (
          <Text style={{ fontSize: 13, color: c.mutedForeground, textAlign: "center", padding: space.md }}>
            {busySummary(staff.map((a) => workspaceAgentWhere(activity.rows, ws.id, a.agentId, now)?.activity ?? null))}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** 底下那一行：「3 只 · 1 在忙」；都闲着写「3 只 · 都空闲」 */
export function busySummary(states: readonly (AgentActivity | null)[]): string {
  const busy = states.filter((s) => s !== null && s !== "idle").length;
  return `${states.length} 只 · ${busy === 0 ? "都空闲" : `${busy} 在忙`}`;
}
