// 「聊天」页签（#1386，spec §5.1，demo 的 chatsRoot）：标题「聊天(n)」+ 右上 ⊕；搜索条；没有主场时一张订阅卡；
// 一列会话按最近一句降序——判据在 shared/wechatInbox.ts。
// #1566（维护者 2026-10-04）：**主页只留人↔人与群**（朋友私聊 / 主场群 / 团队群 / 别人拉我进的群）；智能体的行
// 收进顶上一格「智能体」（进 AgentChatsScreen；别人的智能体再收一层抽屉）。搜索时不分家：搜到哪行列哪行。
// 每一行左滑「删除」= 只从这台手机的列表里拿掉（hiddenStore），有新话再冒出来。
//
// · 进门几态照搬 rosterGate（A1 定的，原样成立）：还没查到 / 正在建主场 → 不下结论、不劝订阅；没订阅 / 档位不带 →
//   一张订阅卡（朋友私聊与团队群照常在下面，demo 同款）；建失败 → 原因 + 重试钮、不自动重试；
//   有主场就进得去、不再看档位。
// · ⊕：新建智能体 / 发起群聊（有主场才有这两样）/ 添加朋友。两个浮层不叠着出场：菜单收完再开弹窗。
// · 刷新：进这一页、回到前台。不轮询（朋友那条有 realtime）。
import { useFocusEffect, useNavigation, useScrollToTop } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { rosterGate, type RosterGate } from "../../../src/shared/agentRoster.js";
import { CHAT_GROUP_CREATE_MIN } from "../../../src/shared/chatRoster.js";
import { mixedGroupName } from "../../../src/shared/chatGuests.js";
import { agentFolderSummary, filterInbox, listTimeLabel, splitInbox, type InboxRow } from "../../../src/shared/wechatInbox.js";
import { workspaceAgentActivity } from "../../../src/shared/agentActivityRows.js";
import { useActivity } from "../activity/activityStore.js";
import { hideChat } from "../inbox/hiddenStore.js";
import { CountBadge, DotBadge } from "../wx/Badge.js";
import { SwipeRow } from "../wx/SwipeRow.js";
import { workspaceAccess } from "../../../src/shared/workspaceAccess.js";
import { NewAgentDialog } from "../agent/NewAgentDialog.js";
import { cloudClient } from "../cloud/cloudClient.js";
import { AddFriendDialog } from "../friends/AddFriendDialog.js";
import { refreshFriends, useFriends } from "../friends/friendsStore.js";
import { PickAgentsDialog } from "../group/PickAgentsDialog.js";
import { friendPeople } from "../group/people.js";
import { ensureHome, refreshHome, refreshHomeAfterWrite, useHome } from "../home/homeStore.js";
import { useSeenStore } from "../inbox/seenStore.js";
import { refreshTeams, useTeams } from "../inbox/teamsStore.js";
import { useInbox } from "../inbox/useInbox.js";
import { syncDeviceTimezone } from "../me/profileStore.js";
import { space, usePalette } from "../theme.js";
import { Button, Note, Spinner, useNow } from "../ui.js";
import { Icon } from "../wx/Icon.js";
import { PlusMenu, type MenuItem } from "../wx/Menu.js";
import { SearchBar } from "../wx/SearchBar.js";
import { HeaderIconButton, TabHeader } from "../wx/TabHeader.js";
import { ChatListRow, CHAT_ROW_AVATAR, CHAT_ROW_SEP } from "./ChatListRow.js";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { GRID_MAX, type GridCell } from "../../../src/shared/wechatInbox.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { SpecAvatar } from "../wx/Avatar.js";

export function refreshAll(): void {
  void refreshHome().then(() => refreshTeams());
  void refreshFriends();
  // 进页与回前台都走这里：设备时区变了才写（runtime 建定时任务时 tz 省略就用账号上的）
  void syncDeviceTimezone();
}

/** 没有主场时，列表顶上那一张（demo 的 .mgate）。只说实话：给得出去处才给钮 */
export function GateCard({ gate, ensureError, onSubscribe }: { gate: RosterGate; ensureError: string | null; onSubscribe: () => void }) {
  const { c } = usePalette();
  const card = (title: string, body: string, action: string, onPress: () => void) => (
    <View style={{ marginHorizontal: 12, marginBottom: 12, padding: 16, borderRadius: 14, backgroundColor: c.card, gap: 8 }}>
      <Text style={{ fontSize: 16, fontWeight: "600", color: c.foreground }}>{title}</Text>
      <Text style={{ fontSize: 14, lineHeight: 21, color: c.mutedForeground }}>{body}</Text>
      <View style={{ alignItems: "flex-start", marginTop: 2 }}>
        <Button size="sm" variant="primary" label={action} onPress={onPress} />
      </View>
    </View>
  );
  switch (gate) {
    case "no_subscription":
      return card("订阅 Pro，就能有自己的智能体", "它们有名字、有职责，能私聊、拉群、打电话。朋友的私聊和你在的群照样能聊。", "看看订阅", onSubscribe);
    case "plan_too_low":
      return card("你现在的档位建不了智能体", "Pro 或 Max 才行。朋友的私聊和你在的群照样能聊。", "去换档", onSubscribe);
    case "failed":
      return card("没能建好你的智能体空间", ensureError ?? "再试一次看看。", "重试", () => void ensureHome());
    default:
      return null;
  }
}

/** 「智能体」那一格（#1566）：长得像一行聊天（头像 48 是前几只的脸拼的九宫格、右上角未读数），第二行写
    「N 只 · M 在忙」+ 最近一句；右边时间 + 箭头。点进 AgentChatsScreen */
function AgentFolderRow({ ws, unread, mention, preview, ts, now, onPress }: {
  ws: WorkspaceSnapshot;
  unread: number;
  mention: boolean;
  preview: string;
  ts: number;
  now: number;
  onPress: () => void;
}) {
  const { c } = usePalette();
  const activity = useActivity();
  const cells = ws.agents.slice(0, GRID_MAX).map((a): GridCell => ({ kind: "face", id: a.agentId, slot: agentFaceSlot(ws, a.agentId) }));
  const busy = ws.agents.filter((a) => {
    const s = workspaceAgentActivity(activity.rows, ws.id, a.agentId, now);
    return s !== null && s !== "idle";
  }).length;
  const count = `${ws.agents.length} 只${busy > 0 ? ` · ${busy} 在忙` : ""}`;
  const time = ts > 0 ? listTimeLabel(ts, now) : "";
  return (
    <View style={{ backgroundColor: c.card }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`智能体，${count}${unread > 0 ? `，${unread} 条聊天有新消息` : ""}${preview !== "" ? `，${preview}` : ""}`}
        onPress={onPress}
        style={({ pressed }) => [
          { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 72, paddingHorizontal: 16 },
          pressed && { backgroundColor: c.press },
        ]}
      >
        <View>
          {cells.length > 0 ? (
            <SpecAvatar spec={{ kind: "grid", cells }} size={CHAT_ROW_AVATAR} />
          ) : (
            <View style={{ width: CHAT_ROW_AVATAR, height: CHAT_ROW_AVATAR, borderRadius: 7, backgroundColor: c.secondary, alignItems: "center", justifyContent: "center" }}>
              <Icon name="sparkles" size={24} color={c.mutedForeground} />
            </View>
          )}
          {unread > 0 ? (
            <View style={{ position: "absolute", top: -6, right: -7 }}>
              <CountBadge n={unread} ring={c.card} />
            </View>
          ) : mention ? (
            <View style={{ position: "absolute", top: -3, right: -3 }}>
              <DotBadge ring={c.card} />
            </View>
          ) : null}
        </View>
        <View style={{ flex: 1, minWidth: 0, paddingVertical: 12, gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 17, color: c.foreground }}>智能体</Text>
            {time !== "" ? <Text style={{ fontSize: 12, color: c.faint, fontVariant: ["tabular-nums"] }}>{time}</Text> : null}
          </View>
          <Text numberOfLines={1} style={{ fontSize: 14, color: c.mutedForeground }}>
            <Text style={{ color: busy > 0 ? c.brand : c.mutedForeground }}>{count}</Text>
            {preview !== "" ? ` · ${preview}` : ""}
          </Text>
        </View>
        <Icon name="chevron-right" size={18} stroke={1.8} color={c.faint} />
      </Pressable>
      <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: CHAT_ROW_SEP }} />
    </View>
  );
}

/** 第一次装上（没有本机快照）时，最多等三份到齐这么久，过了就有什么先画什么 */
const FIRST_PAINT_CAP_MS = 2_500;

export function ChatsScreen() {
  const { c } = usePalette();
  const navigation = useNavigation();
  const home = useHome();
  const teams = useTeams();
  const inbox = useInbox();
  const friends = useFriends();
  const friendsRows = friends.rows;
  const [waitedEnough, setWaitedEnough] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaitedEnough(true), FIRST_PAINT_CAP_MS);
    return () => clearTimeout(t);
  }, []);
  const { drafts } = useSeenStore();
  const now = useNow(60_000);
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<{ kind: "agent" | "group" | "friend"; key: number; visible: boolean } | null>(null);
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  /** 建成的那一条：弹窗退场放完、名册刷新收尾之后再推它（名册里还没有它时推进去是一页「已经不在了」） */
  const created = useRef<{ kind: "agent"; agentId: string; refresh: Promise<void> } | { kind: "group"; sessionId: string } | null>(null);
  const list = useRef<FlatList<InboxRow>>(null);
  useScrollToTop(list);

  useFocusEffect(useCallback(() => refreshAll(), []));
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") refreshAll();
    });
    return () => sub.remove();
  }, []);

  const access = workspaceAccess({ signedIn: true, billing: home.billing });
  const gate: RosterGate = home.loaded ? rosterGate({ access, home: home.home, ensure: home.ensure }) : "unknown";
  useEffect(() => {
    if (gate === "ensuring" && home.ensure === "idle") void ensureHome();
  }, [gate, home.ensure]);

  const ws = home.home;
  const searching = q.trim() !== "";
  // 主页只留人与群（#1566）；搜索时把智能体的行也列进来——搜到的那一行不该被收进文件夹藏起来
  const split = useMemo(() => splitInbox(inbox.rows), [inbox.rows]);
  const rows = useMemo(() => (searching ? filterInbox(inbox.rows, q) : split.main), [searching, inbox.rows, q, split.main]);
  const folder = useMemo(() => agentFolderSummary(split.agents, split.others), [split.agents, split.others]);
  /** 发起群聊时能拉的朋友（#1393）：你的智能体和朋友可以在同一个群里 */
  const invitable = useMemo(() => friendPeople(friends.rows, new Set([home.selfUid ?? ""])), [friends.rows, home.selfUid]);
  const items: MenuItem[] = [
    ...(ws !== null
      ? [
        { key: "agent", icon: "sparkles", label: "新建智能体" } as MenuItem,
        ...(ws.agents.length + invitable.length >= CHAT_GROUP_CREATE_MIN ? [{ key: "group", icon: "users-round", label: "发起群聊" } as MenuItem] : []),
      ]
      : []),
    { key: "friend", icon: "user-round-plus", label: "添加朋友" },
  ];

  const open = (row: InboxRow): void => {
    const t = row.target;
    if (t.kind === "friend") navigation.navigate("FriendChat", { uid: t.uid });
    else navigation.navigate("Chat", t);
  };
  const closeDialog = (): void => setDialog((d) => (d === null ? d : { ...d, visible: false }));
  const onDialogExited = async (): Promise<void> => {
    setDialog(null);
    const next = created.current;
    created.current = null;
    if (next === null) return;
    if (next.kind === "agent") await next.refresh;
    // 这几秒里人可能已经离开了这一页：不隔着别的屏硬推一条聊天
    if (!navigation.isFocused()) return;
    navigation.navigate("Chat", next.kind === "agent" ? { kind: "agent", agentId: next.agentId } : { kind: "group", sessionId: next.sessionId });
  };

  const createGroup = async (picked: string[], name: string, pickedPeople: string[]): Promise<void> => {
    if (ws === null) return;
    setGroupBusy(true);
    setGroupError(null);
    const people = invitable.filter((p) => pickedPeople.includes(p.uid)).map((p) => ({ name: p.name }));
    const r = await cloudClient.create(ws.id, {
      kind: "group",
      name: mixedGroupName(ws, picked, people, name),
      agentIds: picked,
      ...(pickedPeople.length > 0 ? { humans: pickedPeople } : {}),
    });
    if (!r.ok) {
      setGroupBusy(false);
      setGroupError(r.message);
      return;
    }
    await refreshHomeAfterWrite();
    setGroupBusy(false);
    created.current = { kind: "group", sessionId: r.value.sessionId };
    closeDialog();
  };

  const title = inbox.unreadChats > 0 ? `聊天(${inbox.unreadChats})` : "聊天";
  // 三份（主场 / 团队群 / 朋友）都到了才一起画，不然列表先画一部分、再一行一行插进来（#1471）。
  // 本机快照开机就把三份一起铺上，所以通常不用等；第一次装上没有快照时最多等 FIRST_PAINT_CAP_MS
  const allIn = home.loaded && teams.loaded && friendsRows !== null;
  const loading = !home.loaded || (!allIn && !waitedEnough);
  const error = home.loadError ?? teams.loadError;
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <TabHeader
        title={title}
        right={
          <HeaderIconButton label="新建" onPress={() => setMenu(true)}>
            <Icon name="circle-plus" size={25} stroke={1.6} color={c.foreground} />
          </HeaderIconButton>
        }
      />
      <FlatList
        ref={list}
        data={loading ? [] : rows}
        keyExtractor={(r) => r.key}
        renderItem={({ item }) => (
          <SwipeRow onDelete={() => hideChat(item.key, item.ts)}>
            <ChatListRow row={item} draft={drafts.get(item.key) ?? ""} now={now} onPress={() => open(item)} />
          </SwipeRow>
        )}
        ItemSeparatorComponent={() => (
          <View style={{ backgroundColor: c.card }}>
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: CHAT_ROW_SEP }} />
          </View>
        )}
        ListHeaderComponent={
          <>
            <SearchBar value={q} onChange={setQ} />
            {error !== null ? (
              <View style={{ paddingHorizontal: space.md, paddingBottom: space.sm, gap: space.sm }}>
                <Note tone="warn">{error}</Note>
              </View>
            ) : null}
            <GateCard gate={gate} ensureError={home.ensureError} onSubscribe={() => navigation.navigate("Subscription")} />
            {/* 「智能体」那一格（#1566）：有主场才有；搜索时不画（搜到的行已经铺在下面） */}
            {!loading && !searching && ws !== null ? (
              <AgentFolderRow
                ws={ws}
                unread={folder.unread}
                mention={folder.mention}
                preview={folder.preview}
                ts={folder.ts}
                now={now}
                onPress={() => navigation.navigate("AgentChats")}
              />
            ) : null}
          </>
        }
        ListEmptyComponent={
          loading ? (
            <View style={{ paddingTop: space.xl }}><Spinner /></View>
          ) : searching ? (
            <Text style={{ fontSize: 15, color: c.mutedForeground, textAlign: "center", marginTop: space.xl }}>{`没有找到「${q.trim()}」`}</Text>
          ) : (
            <View style={{ alignItems: "center", marginTop: 56, gap: 6, paddingHorizontal: space.xl }}>
              <Text style={{ fontSize: 16, color: c.foreground }}>还没有和人的聊天</Text>
              <Text style={{ fontSize: 14, lineHeight: 21, color: c.mutedForeground, textAlign: "center" }}>
                {ws !== null ? "加个朋友，或者拉几只智能体建个群。和智能体的私聊在上面那一格里。" : "加个朋友，或者订阅之后建一只智能体。"}
              </Text>
            </View>
          )
        }
        contentContainerStyle={{ paddingBottom: space.xl }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      />

      <PlusMenu
        visible={menu}
        items={items}
        onClose={() => setMenu(false)}
        onPick={(key) => {
          setGroupError(null);
          setDialog({ kind: key === "agent" ? "agent" : key === "group" ? "group" : "friend", key: Date.now(), visible: true });
        }}
      />
      {dialog?.kind === "agent" && ws !== null && home.selfUid !== null ? (
        <NewAgentDialog
          key={dialog.key}
          visible={dialog.visible}
          ws={ws}
          selfUid={home.selfUid}
          onClose={closeDialog}
          onCreated={(agentId) => {
            created.current = { kind: "agent", agentId, refresh: refreshHomeAfterWrite() };
            closeDialog();
          }}
          onExited={() => void onDialogExited()}
        />
      ) : null}
      {dialog?.kind === "group" && ws !== null ? (
        <PickAgentsDialog
          key={dialog.key}
          visible={dialog.visible}
          ws={ws}
          title="发起群聊"
          lead="拉几位进来（智能体或朋友），凑够 2 位就能建。朋友让智能体动手要等你批。"
          options={ws.agents.map((a) => a.agentId)}
          min={CHAT_GROUP_CREATE_MIN}
          people={invitable}
          okLabel="建群"
          withName
          busy={groupBusy}
          error={groupError}
          onOk={(picked, name, pickedPeople) => void createGroup(picked, name, pickedPeople)}
          onClose={closeDialog}
          onExited={() => void onDialogExited()}
        />
      ) : null}
      {dialog?.kind === "friend" ? <AddFriendDialog key={dialog.key} visible={dialog.visible} onClose={closeDialog} onExited={() => void onDialogExited()} /> : null}
    </View>
  );
}
