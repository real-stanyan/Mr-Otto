// 聊天信息（#1386，spec §5.3，demo 的 infoPage）：聊天页右上「···」进来。四种：
// · 智能体私聊：它的头像 +「建群」；它的那几行（AgentRows，点开改一格）；删掉这只（管理员没有：新建与派活都靠它）。
// · 主场群：成员格（我 + 我拉进来的朋友 + 智能体，#1393）+ 拉人（智能体或朋友）+ 移出；群聊名称（改）；群主（我）；
//   没 @ 谁的时候；解散（= 删除，不可恢复）。
// · 别人拉我进去的群（#1393）：成员格（群主 + 群里的人 + 智能体）+ 拉朋友（只拉得了我自己的朋友）；群聊名称、群主（只看）；
//   退出群聊（群主可以再把我拉回来）。
// · 团队群（有真人的群）：成员格（人 + 智能体，只看）；群聊名称、群主（只看）；注脚说清成员由群主在电脑上管
//   （拉一个人进来其实是拉进整个团队，spec §2）。
// · 朋友私聊：朋友的头像；邮箱；删除朋友。
// 确认用居中弹窗，真的会删东西的那颗是实底红（#1362）。删 / 解散之后回列表（这条线没了，退回聊天页只会看见一条连不上的线）。
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Share, Text, View } from "react-native";
import { partialExportText, type PartialChoice } from "../../../src/shared/chatLogExport.js";
import { exportChatLog, type ExportTarget } from "./exportLog.js";
import { deleteAgentEverywhere, type AgentDeleteDeps } from "../../../src/shared/agentAdmin.js";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { chatViewOf, groupRows } from "../../../src/shared/agentRoster.js";
import { mixedGroupName, withGuests, type ChatPerson } from "../../../src/shared/chatGuests.js";
import { CHAT_GROUP_MAX, CHAT_HUMANS_MAX, CHAT_NAME_MAX, chatHumansNow, narrowRoster } from "../../../src/shared/chatRoster.js";
import { clampChatName, withAgent, withoutAgent } from "../../../src/shared/groupEdit.js";
import { deleteAgentRow, listAgentChats } from "../../../src/shared/supabaseWorkspacesApi.js";
import { friendName, teamChatTitle } from "../../../src/shared/wechatInbox.js";
import { agentPagePath } from "../../../src/shared/wiki.js";
import { ADMIN_AGENT_ID } from "../../../src/shared/workspaceAgents.js";
import { agentNameOf, labelOf } from "../../../src/shared/workspaceView.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { AgentRows } from "../agent/AgentRows.js";
import { cloudClient } from "../cloud/cloudClient.js";
import { useChatStore } from "../cloud/chatStore.js";
import { Dialog, DialogFooter, DialogLead, DialogTitle } from "../dialog.js";
import { drop, useFriends } from "../friends/friendsStore.js";
import { PickAgentsDialog } from "../group/PickAgentsDialog.js";
import { friendPeople } from "../group/people.js";
import { refreshHomeAfterWrite, useHome } from "../home/homeStore.js";
import { refreshTeams, useTeams } from "../inbox/teamsStore.js";
import { supabase } from "../supabase.js";
import type { RootStackParams } from "../nav/types.js";
import { useMyName } from "../tabs/MeScreen.js";
import { usePalette } from "../theme.js";
import { Group, Note, Row } from "../ui.js";
import { FaceTile, PersonTile } from "../wx/Avatar.js";
import { EditTextDialog } from "../wx/EditTextDialog.js";
import { Icon, type IconName } from "../wx/Icon.js";

type Props = NativeStackScreenProps<RootStackParams, "ChatInfo">;

const deleteDeps: AgentDeleteDeps = {
  listAgentChats,
  deleteAgentRow,
  removeCloudSession: (w, s) => cloudClient.remove(w, s),
  updateChatRoster: (w, s, agentIds) => cloudClient.chatUpdate(w, s, { agentIds }),
  removeAgentPage: (w, agentId) => cloudClient.workspaceWikiWrite(w, { op: "remove", path: agentPagePath(agentId) }).then(() => undefined),
};

/** 成员格里的一格（demo 的 .mmember）：头像 52 + 名字 */
function Member({ avatar, name, onPress }: { avatar: React.ReactNode; name: string; onPress?: () => void }) {
  const { c } = usePalette();
  const body = (
    <View style={{ alignItems: "center", gap: 5, width: "100%" }}>
      {avatar}
      <Text numberOfLines={1} style={{ fontSize: 12, color: c.mutedForeground, maxWidth: "100%" }}>{name}</Text>
    </View>
  );
  return (
    <View style={{ width: "20%", alignItems: "center", paddingHorizontal: 2 }}>
      {onPress === undefined ? body : (
        <Pressable accessibilityRole="button" accessibilityLabel={name} onPress={onPress} style={({ pressed }) => [{ width: "100%" }, pressed && { opacity: 0.6 }]}>{body}</Pressable>
      )}
    </View>
  );
}

/** 「拉人」「移出」「建群」那一格：虚线方框 + 一个符号 */
function MemberAction({ icon, label, onPress, disabled = false }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean }) {
  const { c } = usePalette();
  return (
    <View style={{ width: "20%", alignItems: "center", opacity: disabled ? 0.4 : 1 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => [{ alignItems: "center", gap: 5 }, pressed && { opacity: 0.6 }]}>
        <View style={{ width: 52, height: 52, borderRadius: 9, borderWidth: 1.5, borderStyle: "dashed", borderColor: c.border, alignItems: "center", justifyContent: "center" }}>
          <Icon name={icon} size={22} color={c.mutedForeground} />
        </View>
        <Text style={{ fontSize: 12, color: c.mutedForeground }}>{label}</Text>
      </Pressable>
    </View>
  );
}

function Members({ children }: { children: React.ReactNode }) {
  const { c } = usePalette();
  return <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 14, paddingHorizontal: 14, paddingTop: 16, paddingBottom: 14, backgroundColor: c.card }}>{children}</View>;
}

function DangerRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Group>
      <Row label={label} align="center" tone="destructive" onPress={onPress} />
    </Group>
  );
}

/** 「导出聊天记录」（#1446）：整段原始事件 → jsonl 文件 → 系统分享单。
    自己是一个组件：信息页有好几处提前 return，状态（忙 / 进度 / 没翻齐的弹窗）不能挂在它身上。
    三个 iOS 细节：忙时整行禁用（防二次启动）；没翻齐的弹窗**选完、退场放完**才继续——分享单是系统界面，
    不许叠在一个正在退场的 Modal 上，叠了悄悄不出来（同 wx/ActionSheet）；关掉分享单不是错误 */
function ExportLogRow({ target }: { target: ExportTarget }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState<{ text: string; visible: boolean } | null>(null);
  const choice = useRef<PartialChoice>("retry");
  const resolver = useRef<((c: PartialChoice) => void) | null>(null);
  // 同步闸：setState 要下一次渲染才生效，连点两下能挤进两次导出
  const running = useRef(false);

  const pick = (c: PartialChoice): void => {
    choice.current = c;
    setPartial((p) => (p === null ? p : { ...p, visible: false }));
  };

  const start = (): void => {
    if (running.current) return;
    running.current = true;
    setError(null);
    setBusy(0);
    void (async () => {
      try {
        const r = await exportChatLog(target, {
          onProgress: (n) => setBusy(n),
          askPartial: (p) =>
            new Promise<PartialChoice>((resolve) => {
              choice.current = "retry";
              resolver.current = resolve;
              setPartial({ text: partialExportText(p.count, p.message), visible: true });
            }),
        });
        if (!r.ok) {
          setError(r.message);
          return;
        }
        await Share.share({ url: r.uri });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        running.current = false;
        setBusy(null);
      }
    })();
  };

  return (
    <>
      <Group>
        <Row label="导出聊天记录" {...(busy === null ? {} : { value: `已读 ${busy} 条…` })} chevron disabled={busy !== null} onPress={start} />
      </Group>
      {error !== null ? <View style={{ paddingHorizontal: 16 }}><Note tone="error">{error}</Note></View> : null}
      {partial !== null ? (
        <Dialog
          visible={partial.visible}
          onExited={() => {
            const r = resolver.current;
            resolver.current = null;
            setPartial(null);
            r?.(choice.current);
          }}
        >
          <DialogTitle>只读到一部分</DialogTitle>
          <DialogLead>{partial.text}</DialogLead>
          <DialogFooter left={{ label: "重试", onPress: () => pick("retry") }} right={{ label: "就导出这些", onPress: () => pick("export") }} />
        </Dialog>
      ) : null}
    </>
  );
}

function Confirm({ visible, title, lead, ok, busy, error, onOk, onCancel, onExited }: {
  visible: boolean; title: string; lead: string; ok: string; busy: boolean; error: string | null;
  onOk: () => void; onCancel: () => void; onExited?: () => void;
}) {
  return (
    <Dialog visible={visible} {...(onExited === undefined ? {} : { onExited })}>
      <DialogTitle>{title}</DialogTitle>
      <DialogLead>{lead}</DialogLead>
      {error !== null ? <View style={{ paddingHorizontal: 20 }}><Note tone="error">{error}</Note></View> : null}
      <DialogFooter left={{ label: "取消", onPress: onCancel, disabled: busy }} right={{ label: busy ? "正在做…" : ok, onPress: onOk, disabled: busy, tone: "destructive" }} />
    </Dialog>
  );
}

export function ChatInfoScreen({ route, navigation }: Props) {
  const target = route.params;
  const { c } = usePalette();
  const home = useHome();
  const teams = useTeams();
  const friends = useFriends();
  const chat = useChatStore();
  const me = useMyName();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ key: number; visible: boolean } | null>(null);
  const [picker, setPicker] = useState<{ kind: "add" | "remove" | "group" | "invite"; key: number; visible: boolean } | null>(null);
  const [pickBusy, setPickBusy] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  /** 删 / 解散成了：确认弹窗退场放完再回列表（弹窗还在的时候跳页，它会压在滑走的那一页上） */
  const done = useRef(false);
  /** 从私聊「建群」建成的那个群：弹窗退场放完再去 */
  const newGroup = useRef<string | null>(null);

  const ws = home.home;
  const closePicker = (): void => setPicker((p) => (p === null ? p : { ...p, visible: false }));

  // ── 朋友私聊 ──
  if (target.kind === "friend") {
    const row = friends.rows?.find((r) => r.profile.id === target.uid) ?? null;
    if (row === null) return <View style={{ flex: 1, backgroundColor: c.background }} />;
    const name = friendName(row.profile);
    return (
      <View style={{ flex: 1, backgroundColor: c.background }}>
        <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 40 }}>
          <Members>
            <Member avatar={<PersonTile name={name} url={row.profile.avatarUrl} size={52} radius={9} />} name={name} onPress={() => navigation.navigate("Friend", { uid: target.uid })} />
          </Members>
          <Group>
            <Row label="邮箱" value={row.profile.email} />
          </Group>
          <DangerRow label="删除朋友" onPress={() => { setError(null); setConfirm(true); }} />
        </ScrollView>
        <Confirm
          visible={confirm}
          title={`删除「${name}」？`}
          lead="你们的私聊记录还在库里，但从此发不了消息；借给 TA 用的应用一起收回。"
          ok="删除"
          busy={busy}
          error={error}
          onCancel={() => setConfirm(false)}
          onOk={() => {
            setBusy(true);
            drop(row.friendshipId)
              .then(() => { done.current = true; setConfirm(false); })
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(false));
          }}
          onExited={() => { if (done.current) navigation.popToTop(); }}
        />
      </View>
    );
  }

  // ── 团队群 ──
  if (target.kind === "team") {
    const team = teams.teams.find((t) => t.ws.id === target.workspaceId) ?? null;
    const s = team?.sessions.find((x) => x.id === target.sessionId) ?? null;
    if (team === null || s === null) return <View style={{ flex: 1, backgroundColor: c.background }} />;
    const agents = narrowRoster(team.ws.agents, s.chatKind === null ? null : s.agentIds);
    const owner = team.ws.ownerUid;
    return (
      <View style={{ flex: 1, backgroundColor: c.background }}>
        <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 40 }}>
          <Members>
            {team.ws.members.map((m) => (
              <Member key={m.uid} avatar={<PersonTile name={m.label} url={m.avatarUrl} size={52} radius={9} me={m.uid === (chat.session?.selfUid ?? "")} />} name={m.label} />
            ))}
            {agents.map((a) => (
              <Member key={a.agentId} avatar={<FaceTile slot={agentFaceSlot(team.ws, a.agentId)} size={52} radius={9} />} name={a.name} onPress={() => navigation.navigate("Agent", { agentId: a.agentId, workspaceId: team.ws.id })} />
            ))}
          </Members>
          <Group footer="成员和智能体由群主在电脑上管。群里的智能体干活走群主的额度。">
            <Row label="群聊名称" value={teamChatTitle(team.ws, s)} />
            <Row label="群主" value={labelOf(team.ws, owner)} />
            <Row label="没 @ 谁的时候" value={agents.length > 0 ? "智能体按职责自己接" : "等人回"} />
          </Group>
          <ExportLogRow target={{ kind: "session", sessionId: target.sessionId }} />
        </ScrollView>
      </View>
    );
  }

  // ── 别人拉我进去的群（#1393） ──
  if (target.kind === "guest") {
    const g = teams.guests.find((x) => x.ws.id === target.workspaceId && x.session.id === target.sessionId) ?? null;
    if (g === null) return <View style={{ flex: 1, backgroundColor: c.background }} />;
    const selfUid = chat.session?.selfUid || home.selfUid || "";
    // 名单优先读底下那条聊天的日志（同主场群那条纪律），头像从清单那一行补
    // 连接中（provisional）不读：events 里可能是缓存，缓存里的名单可能比清单投影还旧，
    // 而 chat_update 发的是完整名单，拿旧的发出去会把别的设备上的改动悄悄撤销（#1426）
    const open = chat.session !== null && chat.session.sessionId === g.session.id && chat.session.chat && !chat.session.provisional ? chat.session : null;
    const dbPeople = g.session.humans ?? [];
    const people: ChatPerson[] = open !== null && open.chat
      ? chatHumansNow(open.events, open.chat.humans).map((h) => ({ uid: h.uid, name: h.name, avatarUrl: dbPeople.find((p) => p.uid === h.uid)?.avatarUrl ?? "" }))
      : dbPeople;
    const gws = withGuests(g.ws, people);
    const live = open !== null && open.chat ? chatViewOf(gws, open.chat, open.events, g.session.title) : null;
    const agentIds = live?.agentIds ?? g.session.agentIds;
    const title = live?.title || g.session.title || [...agentIds.map((id) => agentNameOf(gws, id)), ...people.map((p) => p.name)].join("、");
    const owner = gws.members.find((m) => m.uid === gws.ownerUid);
    const invitable = friendPeople(friends.rows, new Set([selfUid, gws.ownerUid, ...people.map((p) => p.uid)]));
    const canInvite = invitable.length > 0 && people.length < CHAT_HUMANS_MAX;
    const leave = (): void => {
      setBusy(true);
      cloudClient
        .chatUpdate(g.ws.id, g.session.id, { humans: people.map((p) => p.uid).filter((u) => u !== selfUid) })
        .then(async (r) => {
          if (!r.ok) throw new Error(r.message);
          done.current = true;
          setConfirm(false);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false));
    };
    return (
      <View style={{ flex: 1, backgroundColor: c.background }}>
        <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 40 }}>
          <Members>
            {owner !== undefined ? <Member avatar={<PersonTile name={owner.label} url={owner.avatarUrl} size={52} radius={9} />} name={owner.label} /> : null}
            {people.map((p) => (
              <Member key={p.uid} avatar={<PersonTile name={p.name} url={p.avatarUrl} size={52} radius={9} me={p.uid === selfUid} />} name={p.uid === selfUid ? me.name : p.name} />
            ))}
            {agentIds.map((id) => (
              <Member key={id} avatar={<FaceTile slot={agentFaceSlot(gws, id)} size={52} radius={9} />} name={agentNameOf(gws, id)} onPress={() => navigation.navigate("Agent", { agentId: id, workspaceId: g.ws.id })} />
            ))}
            {canInvite ? <MemberAction icon="plus" label="拉朋友" onPress={() => { setPickError(null); setPicker({ kind: "invite", key: Date.now(), visible: true }); }} /> : null}
          </Members>
          <Group footer="群里的智能体归群主管，干活走群主的额度。你让它们动手（读文件、跑命令、用应用……）要等群主批。">
            <Row label="群聊名称" value={title} />
            <Row label="群主" value={owner?.label ?? ""} />
            <Row label="没 @ 谁的时候" value={agentIds.length > 0 ? "智能体按职责自己接" : "等人回"} />
          </Group>
          <ExportLogRow target={{ kind: "session", sessionId: target.sessionId }} />
          <DangerRow label="退出群聊" onPress={() => { setError(null); setConfirm(true); }} />
        </ScrollView>
        {picker !== null ? (
          <PickAgentsDialog
            key={picker.key}
            visible={picker.visible}
            ws={gws}
            title="拉朋友进群"
            lead="只能拉你自己的朋友。群里的智能体归群主管。"
            options={[]}
            min={1}
            people={invitable}
            maxPeople={CHAT_HUMANS_MAX - people.length}
            okLabel="拉进来"
            busy={pickBusy}
            error={pickError}
            onOk={(_picked, _name, pickedPeople) => {
              setPickBusy(true);
              setPickError(null);
              cloudClient
                .chatUpdate(g.ws.id, g.session.id, { humans: [...people.map((p) => p.uid), ...pickedPeople] })
                .then(async (r) => {
                  if (!r.ok) throw new Error(r.message);
                  await refreshTeams();
                  closePicker();
                })
                .catch((e: unknown) => setPickError(e instanceof Error ? e.message : String(e)))
                .finally(() => setPickBusy(false));
            }}
            onClose={closePicker}
            onExited={() => setPicker(null)}
          />
        ) : null}
        <Confirm
          visible={confirm}
          title={`退出「${title}」？`}
          lead="退出之后这个群就不在你的列表里了，里面的聊天也看不到了。群主可以再把你拉回来。"
          ok="退出"
          busy={busy}
          error={error}
          onCancel={() => setConfirm(false)}
          onOk={leave}
          onExited={() => {
            if (!done.current) return;
            navigation.popToTop();
            void refreshTeams();
          }}
        />
      </View>
    );
  }

  if (ws === null) return <View style={{ flex: 1, backgroundColor: c.background }} />;

  // ── 智能体私聊 ──
  if (target.kind === "agent") {
    const agent = ws.agents.find((a) => a.agentId === target.agentId) ?? null;
    if (agent === null) return <View style={{ flex: 1, backgroundColor: c.background }} />;
    const isAdmin = agent.agentId === ADMIN_AGENT_ID;
    // 建群时也能拉朋友（#1393）
    const invitable = friendPeople(friends.rows, new Set([home.selfUid ?? ""]));
    return (
      <View style={{ flex: 1, backgroundColor: c.background }}>
        <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 40 }}>
          <Members>
            <Member avatar={<FaceTile slot={agentFaceSlot(ws, agent.agentId)} size={52} radius={9} />} name={agent.name} onPress={() => navigation.navigate("Agent", { agentId: agent.agentId })} />
            {ws.agents.length >= 2 || invitable.length > 0 ? <MemberAction icon="plus" label="建群" onPress={() => { setPickError(null); setPicker({ kind: "group", key: Date.now(), visible: true }); }} /> : null}
          </Members>
          <AgentRows ws={ws} agent={agent} />
          <ExportLogRow target={{ kind: "agent", agentId: agent.agentId }} />
          {isAdmin ? (
            <Text style={{ fontSize: 13, lineHeight: 19, color: c.mutedForeground, paddingHorizontal: 16 }}>管理员删不掉：新建智能体、派活都靠它。</Text>
          ) : (
            <DangerRow label="删除这只智能体" onPress={() => { setError(null); setConfirm(true); }} />
          )}
        </ScrollView>
        <Confirm
          visible={confirm}
          title={`删掉「${agent.name}」？`}
          lead="它的私聊一起删掉；它待过的群还在，只是少了它；它自己那页记忆一起删掉。删了找不回来。"
          ok="删除"
          busy={busy}
          error={error}
          onCancel={() => setConfirm(false)}
          onOk={() => {
            setBusy(true);
            deleteAgentEverywhere(deleteDeps, supabase, ws.id, agent.agentId)
              .then(() => refreshHomeAfterWrite())
              .then(() => { done.current = true; setConfirm(false); })
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(false));
          }}
          onExited={() => { if (done.current) navigation.popToTop(); }}
        />
        {picker !== null ? (
          <PickAgentsDialog
            key={picker.key}
            visible={picker.visible}
            ws={ws}
            title="拉人建群"
            lead="带上它，再拉几位（智能体或朋友），凑够 2 位就能建。"
            options={ws.agents.map((a) => a.agentId)}
            preset={[agent.agentId]}
            min={2}
            people={invitable}
            okLabel="建群"
            withName
            busy={pickBusy}
            error={pickError}
            onOk={(picked, name, pickedPeople) => {
              setPickBusy(true);
              setPickError(null);
              const people = invitable.filter((x) => pickedPeople.includes(x.uid)).map((x) => ({ name: x.name }));
              cloudClient
                .create(ws.id, {
                  kind: "group",
                  name: mixedGroupName(ws, picked, people, name),
                  agentIds: picked,
                  ...(pickedPeople.length > 0 ? { humans: pickedPeople } : {}),
                })
                .then(async (r) => {
                  if (!r.ok) throw new Error(r.message);
                  await refreshHomeAfterWrite();
                  newGroup.current = r.value.sessionId;
                  closePicker();
                })
                .catch((e: unknown) => setPickError(e instanceof Error ? e.message : String(e)))
                .finally(() => setPickBusy(false));
            }}
            onClose={closePicker}
            onExited={() => {
              setPicker(null);
              const sid = newGroup.current;
              newGroup.current = null;
              if (sid !== null) {
                navigation.popToTop();
                navigation.navigate("Chat", { kind: "group", sessionId: sid });
              }
            }}
          />
        ) : null}
      </View>
    );
  }

  // ── 主场群 ──
  const row = groupRows(ws, home.chats).find((g) => g.sessionId === target.sessionId) ?? null;
  if (row === null) return <View style={{ flex: 1, backgroundColor: c.background }} />;
  // 名单优先读底下那条聊天的日志（A3 那条纪律：投影一陈旧，下一次完整名单会把上一次的改动覆盖回去）
  // 连接中（provisional）不读日志：缓存里的名单可能比清单投影还旧，chat_update 发的是完整名单（#1426）
  const live = chat.session !== null && chat.session.sessionId === row.sessionId && chat.session.chat && !chat.session.provisional
    ? chatViewOf(ws, chat.session.chat, chat.session.events, row.name)
    : null;
  const agentIds = live?.agentIds ?? row.agentIds;
  // 我拉进来的朋友（#1393）：日志里那份是事实（开着这条聊天时），否则读清单那一行的投影；头像从投影补
  const dbPeople = home.chats.find((x) => x.id === row.sessionId)?.humans ?? [];
  const openChat = chat.session !== null && chat.session.sessionId === row.sessionId && chat.session.chat && !chat.session.provisional ? chat.session : null;
  const people: ChatPerson[] = openChat !== null && openChat.chat
    ? chatHumansNow(openChat.events, openChat.chat.humans).map((h) => ({ uid: h.uid, name: h.name, avatarUrl: dbPeople.find((p) => p.uid === h.uid)?.avatarUrl ?? "" }))
    : dbPeople;
  const selfUid = home.selfUid ?? "";
  const invitable = friendPeople(friends.rows, new Set([selfUid, ...people.map((p) => p.uid)]));
  const canAdd = (agentIds.length < CHAT_GROUP_MAX && ws.agents.some((a) => !agentIds.includes(a.agentId))) || (invitable.length > 0 && people.length < CHAT_HUMANS_MAX);
  const isFriend = (uid: string): boolean => friends.rows?.some((r) => r.status === "accepted" && r.profile.id === uid) === true;
  const onPick = (picked: string[], pickedPeople: string[]): void => {
    if (picker === null) return;
    let next = agentIds;
    for (const id of picked) next = picker.kind === "add" ? withAgent(ws, next, id) : withoutAgent(ws, next, id);
    const nextPeople = picker.kind === "add"
      ? [...people.map((p) => p.uid), ...pickedPeople]
      : people.map((p) => p.uid).filter((u) => !pickedPeople.includes(u));
    setPickBusy(true);
    setPickError(null);
    cloudClient
      .chatUpdate(ws.id, row.sessionId, {
        ...(picked.length > 0 ? { agentIds: next } : {}),
        ...(pickedPeople.length > 0 ? { humans: nextPeople } : {}),
      })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.message);
        await refreshHomeAfterWrite();
        closePicker();
      })
      .catch((e: unknown) => setPickError(e instanceof Error ? e.message : String(e)))
      .finally(() => setPickBusy(false));
  };
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 40 }}>
        <Members>
          <Member avatar={<PersonTile name={me.name} url={me.avatar} size={52} radius={9} me />} name={me.name} />
          {people.map((p) => (
            <Member
              key={p.uid}
              avatar={<PersonTile name={p.name} url={p.avatarUrl} size={52} radius={9} />}
              name={p.name}
              {...(isFriend(p.uid) ? { onPress: () => navigation.navigate("Friend", { uid: p.uid }) } : {})}
            />
          ))}
          {agentIds.map((id) => (
            <Member key={id} avatar={<FaceTile slot={agentFaceSlot(ws, id)} size={52} radius={9} />} name={agentNameOf(ws, id)} onPress={() => navigation.navigate("Agent", { agentId: id })} />
          ))}
          <MemberAction icon="plus" label="拉人" disabled={!canAdd} onPress={() => { setPickError(null); setPicker({ kind: "add", key: Date.now(), visible: true }); }} />
          {agentIds.length > 0 || people.length > 0 ? <MemberAction icon="x" label="移出" onPress={() => { setPickError(null); setPicker({ kind: "remove", key: Date.now(), visible: true }); }} /> : null}
        </Members>
        <Group footer={people.length > 0 ? "群里的智能体归你管，干活走你的额度。朋友让它们动手（读文件、跑命令、用应用……）要等你批。" : "群里的智能体归群主管，干活走群主的额度。"}>
          <Row label="群聊名称" value={row.name} chevron onPress={() => setRenaming({ key: Date.now(), visible: true })} />
          <Row label="群主" value="我" />
          <Row label="没 @ 谁的时候" value={agentIds.length > 0 ? "智能体按职责自己接" : "没人接"} />
        </Group>
        <ExportLogRow target={{ kind: "session", sessionId: row.sessionId }} />
        <DangerRow label="解散群聊" onPress={() => { setError(null); setConfirm(true); }} />
      </ScrollView>

      {renaming !== null ? (
        <EditTextDialog
          key={renaming.key}
          visible={renaming.visible}
          title="群聊名称"
          lead="改完大家看到的就是这个名字。"
          initial={row.name}
          maxLength={CHAT_NAME_MAX}
          onSave={async (v) => {
            const r = await cloudClient.chatUpdate(ws.id, row.sessionId, { name: clampChatName(v) });
            if (!r.ok) throw new Error(r.message);
            await refreshHomeAfterWrite();
            setRenaming((x) => (x === null ? x : { ...x, visible: false }));
          }}
          onClose={() => setRenaming((x) => (x === null ? x : { ...x, visible: false }))}
          onExited={() => setRenaming(null)}
        />
      ) : null}
      {picker !== null ? (
        <PickAgentsDialog
          key={picker.key}
          visible={picker.visible}
          ws={ws}
          title={picker.kind === "add" ? "拉人进群" : "移出群聊"}
          lead={picker.kind === "remove" ? "移出去的智能体还在，它们各自的私聊一个字不少。" : "朋友进来之后，他们让智能体动手要等你批。"}
          options={picker.kind === "add" ? ws.agents.map((a) => a.agentId).filter((id) => !agentIds.includes(id)) : agentIds}
          min={1}
          max={picker.kind === "add" ? CHAT_GROUP_MAX - agentIds.length : agentIds.length}
          people={picker.kind === "add" ? invitable : people.map((p) => ({ uid: p.uid, name: p.name, url: p.avatarUrl }))}
          peopleLabel={picker.kind === "add" ? "朋友" : "群里的人"}
          maxPeople={picker.kind === "add" ? CHAT_HUMANS_MAX - people.length : people.length}
          okLabel={picker.kind === "add" ? "拉进来" : "移出"}
          busy={pickBusy}
          error={pickError}
          onOk={(picked, _name, pickedPeople) => onPick(picked, pickedPeople)}
          onClose={closePicker}
          onExited={() => setPicker(null)}
        />
      ) : null}
      <Confirm
        visible={confirm}
        title={`解散「${row.name}」？`}
        lead="聊天记录一起删掉，不可恢复。里面的智能体都还在，通讯录里照样找得到。"
        ok="解散"
        busy={busy}
        error={error}
        onCancel={() => setConfirm(false)}
        onOk={() => {
          setBusy(true);
          cloudClient
            .remove(ws.id, row.sessionId)
            .then(async (r) => {
              if (!r.ok) throw new Error(r.message);
              done.current = true;
              setConfirm(false);
            })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
        }}
        onExited={() => {
          if (!done.current) return;
          navigation.popToTop();
          void refreshHomeAfterWrite();
        }}
      />
    </View>
  );
}
