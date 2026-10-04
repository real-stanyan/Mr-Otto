// 「通讯录」页签（#1386，spec §5.4，demo 的 contactsRoot）：标题 + 右上「添加朋友」；搜索；「新的朋友」「群聊」两格入口；
// 可折叠的「智能体」（段头右边「新建」）与「朋友」两段（维护者 2026-09-27：各能折叠，看得清楚）；底部「N 只智能体 · M 位朋友」。
// 智能体按名册顺序（通讯录不是会话列表，A1 那条判据原样），朋友按名字排。没有主场时「智能体」段里是那张订阅卡。
import { useFocusEffect, useNavigation, useScrollToTop } from "@react-navigation/native";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { workspaceAgentActivity } from "../../../src/shared/agentActivityRows.js";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { rosterGate, type RosterGate } from "../../../src/shared/agentRoster.js";
import { friendName, groupList, sortFriends } from "../../../src/shared/wechatInbox.js";
import { workspaceAccess } from "../../../src/shared/workspaceAccess.js";
import { ActivityFace } from "../activity/ActivityFace.js";
import { useActivity } from "../activity/activityStore.js";
import { NewAgentDialog } from "../agent/NewAgentDialog.js";
import { AddFriendDialog } from "../friends/AddFriendDialog.js";
import { useFriends } from "../friends/friendsStore.js";
import { refreshHomeAfterWrite, useHome } from "../home/homeStore.js";
import { useTeams } from "../inbox/teamsStore.js";
import { useInbox } from "../inbox/useInbox.js";
import { usePalette } from "../theme.js";
import { useNow } from "../ui.js";
import { FriendAvatar } from "../friends/FriendAvatar.js";
import { CountBadge } from "../wx/Badge.js";
import { Fold } from "../wx/Fold.js";
import { Icon, type IconName } from "../wx/Icon.js";
import { SearchBar } from "../wx/SearchBar.js";
import { HeaderIconButton, TabHeader } from "../wx/TabHeader.js";
import { GateCard, refreshAll } from "./ChatsScreen.js";

/** 通讯录里的一行（demo 的 .mrow.small）：头像 40 + 名字（+ 一行小字） */
export function ContactRow({ avatar, name, sub, right, onPress, first }: {
  avatar: React.ReactNode;
  name: string;
  sub?: string;
  right?: React.ReactNode;
  onPress: () => void;
  first?: boolean;
}) {
  const { c } = usePalette();
  return (
    <View style={{ backgroundColor: c.card }}>
      {first === true ? null : <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: 68 }} />}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={sub !== undefined && sub !== "" ? `${name}，${sub}` : name}
        onPress={onPress}
        style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingHorizontal: 16 }, pressed && { backgroundColor: c.press }]}
      >
        {avatar}
        <View style={{ flex: 1, minWidth: 0, gap: 2, paddingVertical: 8 }}>
          <Text numberOfLines={1} style={{ fontSize: 17, color: c.foreground }}>{name}</Text>
          {sub !== undefined && sub !== "" ? <Text numberOfLines={1} style={{ fontSize: 13, color: c.mutedForeground }}>{sub}</Text> : null}
        </View>
        {right}
      </Pressable>
    </View>
  );
}

function EntryTile({ icon }: { icon: IconName }) {
  const { c } = usePalette();
  return (
    <View style={{ width: 40, height: 40, borderRadius: 7, backgroundColor: c.secondary, alignItems: "center", justifyContent: "center" }}>
      <Icon name={icon} size={21} color={c.mutedForeground} />
    </View>
  );
}

export function ContactsScreen() {
  const { c } = usePalette();
  const activity = useActivity();
  const now = useNow(30_000);
  const navigation = useNavigation();
  const home = useHome();
  const teams = useTeams();
  const friends = useFriends();
  const inbox = useInbox();
  const [q, setQ] = useState("");
  const [dialog, setDialog] = useState<{ kind: "agent" | "friend"; key: number; visible: boolean } | null>(null);
  const created = useRef<{ agentId: string; refresh: Promise<void> } | null>(null);
  const scroll = useRef<ScrollView>(null);
  useScrollToTop(scroll);
  useFocusEffect(useCallback(() => refreshAll(), []));

  const ws = home.home;
  const access = workspaceAccess({ signedIn: true, billing: home.billing });
  const gate: RosterGate = home.loaded ? rosterGate({ access, home: ws, ensure: home.ensure }) : "unknown";
  const term = q.trim().toLowerCase();
  const match = (...hay: string[]): boolean => term === "" || hay.some((h) => h.toLowerCase().includes(term));
  const agents = (ws?.agents ?? []).filter((a) => match(a.name, a.description));
  const accepted = useMemo(() => sortFriends((friends.rows ?? []).filter((r) => r.status === "accepted")), [friends.rows]);
  const shownFriends = accepted.filter((r) => match(friendName(r.profile), r.profile.email));
  const groupCount = useMemo(
    () => groupList({ selfUid: inbox.selfUid, home: ws === null ? null : { ws, chats: home.chats, lasts: home.lasts }, teams: teams.teams }).length,
    [inbox.selfUid, ws, home.chats, home.lasts, teams.teams],
  );
  const searching = term !== "";

  const close = (): void => setDialog((d) => (d === null ? d : { ...d, visible: false }));
  const onExited = async (): Promise<void> => {
    setDialog(null);
    const next = created.current;
    created.current = null;
    if (next === null) return;
    await next.refresh;
    if (!navigation.isFocused()) return;
    // 建好就去它那条线上（它先开口问你要它干什么，ADR-0319）
    navigation.navigate("Chat", { kind: "agent", agentId: next.agentId });
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <TabHeader
        title="通讯录"
        right={
          <HeaderIconButton label="添加朋友" onPress={() => setDialog({ kind: "friend", key: Date.now(), visible: true })}>
            <Icon name="user-round-plus" size={23} stroke={1.7} color={c.foreground} />
          </HeaderIconButton>
        }
      />
      <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingBottom: 24 }}>
        <SearchBar value={q} onChange={setQ} />
        {searching ? null : (
          <>
            <ContactRow
              first
              avatar={<EntryTile icon="user-round-plus" />}
              name="新的朋友"
              right={inbox.incoming > 0 ? <CountBadge n={inbox.incoming} /> : undefined}
              onPress={() => navigation.navigate("Requests")}
            />
            <ContactRow
              avatar={<EntryTile icon="users-round" />}
              name="群聊"
              right={<Text style={{ fontSize: 14, color: c.faint, fontVariant: ["tabular-nums"] }}>{groupCount}</Text>}
              onPress={() => navigation.navigate("Groups")}
            />
          </>
        )}

        <Fold
          id="agents"
          label="智能体"
          count={agents.length}
          forceOpen={searching}
          action={
            ws !== null && home.selfUid !== null ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="新建智能体"
                hitSlop={6}
                onPress={() => setDialog({ kind: "agent", key: Date.now(), visible: true })}
                style={({ pressed }) => [{ paddingHorizontal: 6, height: 30, justifyContent: "center" }, pressed && { opacity: 0.45 }]}
              >
                <Text style={{ fontSize: 15, fontWeight: "500", color: c.brand }}>新建</Text>
              </Pressable>
            ) : undefined
          }
        >
          {ws === null ? (
            <GateCard gate={gate} ensureError={home.ensureError} onSubscribe={() => navigation.navigate("Subscription")} />
          ) : (
            agents.map((a, i) => (
              <ContactRow
                key={a.agentId}
                first={i === 0}
                avatar={
                  <ActivityFace
                    slot={agentFaceSlot(ws, a.agentId)}
                    size={40}
                    activity={workspaceAgentActivity(activity.rows, ws.id, a.agentId, now)}
                    ring={c.card}
                    badgeSize={9}
                  />
                }
                name={a.name}
                sub={a.description}
                onPress={() => navigation.navigate("Agent", { agentId: a.agentId })}
              />
            ))
          )}
        </Fold>

        <Fold id="friends" label="朋友" count={shownFriends.length} forceOpen={searching}>
          {friends.rows === null ? null : shownFriends.length === 0 && !searching ? (
            <Text style={{ fontSize: 14, color: c.mutedForeground, paddingHorizontal: 16, paddingVertical: 8 }}>还没有朋友。右上角加一个。</Text>
          ) : (
            shownFriends.map((r, i) => (
              <ContactRow
                key={r.profile.id}
                first={i === 0}
                avatar={<FriendAvatar uid={r.profile.id} name={friendName(r.profile)} url={r.profile.avatarUrl} size={40} ring={c.card} dot={8} />}
                name={friendName(r.profile)}
                sub={r.profile.email}
                onPress={() => navigation.navigate("Friend", { uid: r.profile.id })}
              />
            ))
          )}
        </Fold>

        {searching ? null : (
          <Text style={{ fontSize: 13, color: c.mutedForeground, textAlign: "center", padding: 16 }}>
            {`${ws?.agents.length ?? 0} 只智能体 · ${accepted.length} 位朋友`}
          </Text>
        )}
      </ScrollView>

      {dialog?.kind === "agent" && ws !== null && home.selfUid !== null ? (
        <NewAgentDialog
          key={dialog.key}
          visible={dialog.visible}
          ws={ws}
          selfUid={home.selfUid}
          onClose={close}
          onCreated={(agentId) => {
            created.current = { agentId, refresh: refreshHomeAfterWrite() };
            close();
          }}
          onExited={() => void onExited()}
        />
      ) : null}
      {dialog?.kind === "friend" ? <AddFriendDialog key={dialog.key} visible={dialog.visible} onClose={close} onExited={() => setDialog(null)} /> : null}
    </View>
  );
}
