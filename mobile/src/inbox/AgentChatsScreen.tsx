// 「智能体」那一页（#1566，维护者 2026-10-04）：聊天页主页只留人↔人与群，我的智能体收在这里——
// 主场里的每一只一行（聊过的带最后一句 + 未读，没聊过的写职责），每一行带**此刻的状态**：空闲 / 档位 ·
// 在〈哪个群〉（agent_activity 跨会话取最要紧的那条，判据 agentActivityRows.workspaceAgentWhere）。
// 底下一格抽屉「别人的智能体」：别人的智能体跟我的对话（外联会话，#1441），默认收着——那是最次级的。
// 所有聊过的行左滑删除（同聊天页：只从这台手机的列表里拿掉，有新话再冒出来，hiddenStore）。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { agentStatusText, workspaceAgentWhere } from "../../../src/shared/agentActivityRows.js";
import type { AgentActivity } from "../../../src/shared/agentActivity.js";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { splitInbox } from "../../../src/shared/wechatInbox.js";
import { ActivityFace } from "../activity/ActivityFace.js";
import { useActivity } from "../activity/activityStore.js";
import { useHome } from "../home/homeStore.js";
import type { RootStackParams } from "../nav/types.js";
import { ChatListRow, CHAT_ROW_SEP } from "../tabs/ChatListRow.js";
import { ContactRow } from "../tabs/ContactsScreen.js";
import { space, usePalette } from "../theme.js";
import { useNow } from "../ui.js";
import { Fold } from "../wx/Fold.js";
import { SwipeRow } from "../wx/SwipeRow.js";
import { hideChat } from "./hiddenStore.js";
import { useSeenStore } from "./seenStore.js";
import { useInbox } from "./useInbox.js";

type Props = NativeStackScreenProps<RootStackParams, "AgentChats">;

export function AgentChatsScreen({ navigation }: Props) {
  const { c } = usePalette();
  const home = useHome();
  const inbox = useInbox();
  const activity = useActivity();
  const { drafts } = useSeenStore();
  const now = useNow(30_000);
  const ws = home.home;
  const split = useMemo(() => splitInbox(inbox.rows), [inbox.rows]);
  /** 聊过的那几只：agentId → 它那一行 */
  const chatted = useMemo(() => new Map(split.agents.map((r) => [r.target.kind === "agent" ? r.target.agentId : "", r])), [split.agents]);
  /** 群名（在忙的那条会话是个群时写进状态里）：私聊不算——那一行本身就是那条私聊 */
  const groupTitle = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of split.main) if (r.target.kind !== "friend" && r.target.kind !== "agent") m.set(r.target.sessionId, r.title);
    return (sid: string): string | null => m.get(sid) ?? null;
  }, [split.main]);
  const agents = ws?.agents ?? [];
  const sep = <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: CHAT_ROW_SEP }} />;
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ paddingTop: 8, paddingBottom: 40 }}>
        {ws === null ? (
          <Text style={{ fontSize: 14, color: c.mutedForeground, paddingHorizontal: 16, paddingVertical: 8 }}>订阅之后才有自己的智能体。</Text>
        ) : agents.length === 0 ? (
          <Text style={{ fontSize: 14, color: c.mutedForeground, paddingHorizontal: 16, paddingVertical: 8 }}>还没有智能体。去聊天页右上角建一只。</Text>
        ) : (
          <View style={{ backgroundColor: c.card }}>
            {agents.map((a, i) => {
              const where = workspaceAgentWhere(activity.rows, ws.id, a.agentId, now);
              const status = agentStatusText(where, groupTitle);
              const row = chatted.get(a.agentId);
              const busy = where !== null && where.activity !== "idle";
              const statusLine = (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: busy ? c.brand : c.faint }} />
                  <Text numberOfLines={1} style={{ fontSize: 12, color: busy ? c.brand : c.faint }}>{status}</Text>
                </View>
              );
              if (row === undefined) {
                // 没聊过：职责 + 状态；点进去就是那条还没建的私聊（ChatScreen 按 agentId 建草稿线）
                return (
                  <View key={a.agentId}>
                    {i === 0 ? null : sep}
                    <ContactRow
                      first
                      avatar={<ActivityFace slot={agentFaceSlot(ws, a.agentId)} size={48} activity={where?.activity ?? null} ring={c.card} badgeSize={10} />}
                      name={a.name}
                      sub={a.description === "" ? status : `${a.description} · ${status}`}
                      onPress={() => navigation.navigate("Chat", { kind: "agent", agentId: a.agentId })}
                    />
                  </View>
                );
              }
              return (
                <View key={a.agentId}>
                  {i === 0 ? null : sep}
                  <SwipeRow onDelete={() => hideChat(row.key, row.ts)}>
                    <ChatListRow row={row} draft={drafts.get(row.key) ?? ""} now={now} onPress={() => navigation.navigate("Chat", { kind: "agent", agentId: a.agentId })} status={statusLine} />
                  </SwipeRow>
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
                    <ChatListRow row={r} draft={drafts.get(r.key) ?? ""} now={now} onPress={() => { if (r.target.kind === "outreach") navigation.navigate("Chat", r.target); }} />
                  </SwipeRow>
                </View>
              ))}
            </View>
          </Fold>
        ) : null}

        {ws !== null && agents.length > 0 ? (
          <Text style={{ fontSize: 13, color: c.mutedForeground, textAlign: "center", padding: space.md }}>
            {busySummary(agents.map((a) => workspaceAgentWhere(activity.rows, ws.id, a.agentId, now)?.activity ?? null))}
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
