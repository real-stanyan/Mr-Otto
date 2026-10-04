// 聊天页（#1386，spec §5.2，demo 的 chatPage）。私聊、主场群、团队群（= 有真人的群）同一张页；朋友私聊是另一张
// （FriendChatScreen：messages 表，不是云会话）。
//
// · 原生导航条（照微信）：标题（群带人数）+ 第二行状态（等你处理 / 正在输入 / 正在干活 / 正在查资料 / 正在想 / 排队中 / 正在重连，nowRowOf 推）；
//   右边「···」进聊天信息；返回键后面带别的聊天的未读数。
// · 时间线：倒置列表（最新一条贴底）；往上翻到顶取更早一页（尾巴模式），失败给一颗要人点的钮（A1 原样）。
//   气泡、时刻、旁白见 Bubbles.tsx；「此刻」那一行是它那边一个打字的气泡 + 一颗「停」。
// · 草稿：私聊还没建时是同一张页、还没有会话，第一句发出去那一刻才建（A1 原样）。
// · 输入栏（WxComposer）：按住说话 ⇄ 键盘、表情、⊕（语音通话 / 拉人建群 / 拉人 / @ 谁）；群里打一个 @ 就弹选人。
// · 团队群：有审批（卡在时间线里，发起人或群主批）；@ 到的人发提醒（memberMentions，ADR-0256）；进来 = 那里面 @ 我的都看过了。
// · 有朋友的群（#1393）：我主场里的群可以拉朋友进来；别人主场里拉我进去的群也是这一页（target.kind = "guest"）。
//   客人点起的那一轮要动手时等群主批（审批卡上写「等 X 批」）；客人能拉自己的朋友，智能体归群主管。
// · 外联会话（#1441，target.kind = "outreach"）：别人的智能体给我打电话的地方。只有来电记录（正在响的能接，未接的只看）
//   与通话卡，输入栏换成一句说明，没有电话钮 / 按住说话 / @ / 聊天信息。数据与客人那一条路同源（teams.guests）。
// · 通话：点「语音通话」整屏升起（CallOverlay）；收起回到这里、头部下面一颗胶囊（点它回去）；离开这一页 = 这台停听、
//   通话还在（A4 原样）。
// · 已读：这一页开着时列表不给它画未读；离开时游标推到此刻（seenStore）。
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { activityFoldOf } from "../../../src/shared/agentActivity.js";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { roleChipsAnchor } from "../../../src/shared/agentOnboarding.js";
import { resolveSendMentions } from "../../../src/shared/agentMentionInput.js";
import { chatViewOf } from "../../../src/shared/agentRoster.js";
import { systemAudioReady } from "../../../src/shared/callKitBridge.js";
import { mixedGroupName, othersInGroup, withGuests, type ChatPerson } from "../../../src/shared/chatGuests.js";
import { CHAT_GROUP_CREATE_MIN, CHAT_GROUP_MAX, CHAT_HUMANS_MAX, chatHumansNow, chatRosterNow, narrowRoster } from "../../../src/shared/chatRoster.js";
import { cloudDeniedText } from "../../../src/shared/cloudSessionState.js";
import { withAgent } from "../../../src/shared/groupEdit.js";
import { callBarMode, callFace, callMicOn, joinBlockedText, phoneOffered, waveMode } from "../../../src/shared/mobileCall.js";
import { chatCentre, chatRows, liveRows, nowRowOf, outreachComposer, resolveChatTarget, screenOwnsSession, type ChatRow, type NowRow } from "../../../src/shared/mobileChat.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import type { CsChatInfo } from "../../../src/shared/remote/cloudSession.js";
import { parseMemberMentions, parseMentions } from "../../../src/shared/remote/agentMention.js";
import { outreachCallerName } from "../../../src/shared/outreach.js";
import { openTurns } from "../../../src/shared/turnLedger.js";
import { voiceCallOf } from "../../../src/shared/voiceCall.js";
import { teamChatTitle } from "../../../src/shared/wechatInbox.js";
import { agentNameOf } from "../../../src/shared/workspaceView.js";
import { isHomeWorkspace, type WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import type { SessionEvent } from "../../../src/session/events.js";
import { useCallKit } from "../call/callKit.js";
import { settleAnswer } from "../call/ringStore.js";
import { cloudClient } from "../cloud/cloudClient.js";
import {
  chatSessionOf, closeChatOwned, dropUnsent, loadOlder, openChat, resendUnsent, sendText, startDm, stopTurn, useChatStore, type OutboxLine,
} from "../cloud/chatStore.js";
import { useFriends } from "../friends/friendsStore.js";
import { PickAgentsDialog } from "../group/PickAgentsDialog.js";
import { friendPeople } from "../group/people.js";
import { refreshHomeAfterWrite, useHome } from "../home/homeStore.js";
import { peerLaneGuestChat } from "../friends/peerLane.js";
import { markSeen, setOpenKey } from "../inbox/seenStore.js";
import { readTeamMentions, refreshTeams, useTeams } from "../inbox/teamsStore.js";
import { useInbox } from "../inbox/useInbox.js";
import type { RootStackParams } from "../nav/types.js";
import { useMyName } from "../tabs/MeScreen.js";
import { usePalette, withAlpha } from "../theme.js";
import { Button, Spinner, useKeyboardInset } from "../ui.js";
import { CallOverlay, CallPill } from "../voice/CallOverlay.js";
import { CallSheet } from "../voice/CallSheet.js";
import {
  dictationUsable, hangUp, joinCall, nativeSpeech, refreshVoiceBilling, setMic, startCall, startDictation, stopDictation, useVoice, voiceUsable,
} from "../voice/voiceStore.js";
import { FaceTile, GridTile, PersonTile } from "../wx/Avatar.js";
import { Icon } from "../wx/Icon.js";
import { HeaderIconButton } from "../wx/TabHeader.js";
import { toast } from "../wx/toast.js";
import { ChatRowView, PendingMineRow, TypingRow } from "./Bubbles.js";
import { planMediaMessages, type PreparedMedia } from "../../../src/shared/chatMedia.js";
import { sendCloudMedia } from "../../../src/shared/chatMediaCloud.js";
import { uploadMediaFile } from "../friends/friendsApi.js";
import { fileSizeOf, sha256OfFile } from "../media/hash.js";
import { PendingMediaBubble } from "../media/MediaBubble.js";
import { pickFromCamera, pickFromLibrary, pickedKind, prepareAsset, type PickedAsset } from "../media/prepareMedia.js";
import { MentionSheet } from "./MentionSheet.js";
import { DispatchDialog } from "./DispatchDialog.js";
import { dispatchOpening, quoteLinesFromRows, quoteWindow } from "../../../src/shared/dispatchQuote.js";
import { RoleChips } from "./RoleChips.js";
import { WxComposer, type ComposerHandle, type HoldState, type PlusItem } from "./WxComposer.js";

const EMPTY_EVENTS: SessionEvent[] = [];
const EMPTY_GROUP_TEXT = "这个群里没有智能体了，说的话没人接。去聊天信息里拉一只进来。";
const PHASE_STATUS: Record<NowRow["phase"], string> = {
  waiting: "等你处理…",
  solving: "正在输入…",
  working: "正在干活…",
  searching: "正在查资料…",
  composing: "正在想…",
  queued: "排队中…",
};
/** 正在传 / 传失败的一组图或一段视频（#1491 P3）：只活在这一页的内存里，同私聊的 PendingMedia */
interface PendingCloudMedia { key: number; items: PreparedMedia[]; state: "sending" | "failed"; progress: number; error: string | null }
type Item = { kind: "row"; row: ChatRow } | { kind: "outbox"; line: OutboxLine } | { kind: "media"; p: PendingCloudMedia } | { kind: "now"; now: NowRow } | { kind: "roles" };
type Props = NativeStackScreenProps<RootStackParams, "Chat">;

interface Resolved {
  kind: "dm" | "group";
  sessionId: string | null;
  agentIds: string[];
  title: string;
  /** 打开这条线时给 `chat` 种的那一格；团队会话是 null（ADR-0302：null = 不是聊天） */
  seed: CsChatInfo | null;
}

function Gap() {
  return <View style={{ height: 16 }} />;
}

/** 倒置列表不满一屏时贴顶（#1424），用法见 FlatList 那一处 */
const CHAT_LIST_TOP = { flexGrow: 1, justifyContent: "flex-end", paddingBottom: 8 } as const;

function Line({ tone, children }: { tone: "muted" | "warn" | "error"; children: ReactNode }) {
  const { c } = usePalette();
  const color = tone === "error" ? c.destructive : tone === "warn" ? c.warn : c.mutedForeground;
  return <Text style={{ fontSize: 13, lineHeight: 18, color, flexShrink: 1 }}>{children}</Text>;
}

/** 导航条正中那两行：名字（群带人数）+ 此刻在干什么 */
function ChatTitle({ title, count, status }: { title: string; count: number; status: string }) {
  const { c } = usePalette();
  return (
    <View accessible accessibilityRole="header" accessibilityLabel={`${title}${count > 0 ? `，${count} 人` : ""}${status !== "" ? `，${status}` : ""}`} style={{ alignItems: "center", maxWidth: 220 }}>
      <Text numberOfLines={1} style={{ fontSize: 17, fontWeight: "600", letterSpacing: -0.2, color: c.foreground }}>
        {title}
        {count > 0 ? `(${count})` : ""}
      </Text>
      {status !== "" ? <Text numberOfLines={1} style={{ fontSize: 11.5, color: c.mutedForeground, marginTop: -1 }}>{status}</Text> : null}
    </View>
  );
}

/** 顶上那一格（倒置列表里 ListFooterComponent 画在最上面）：翻页的三态 */
function OlderRow({ hasOlder, older }: { hasOlder: boolean; older: "idle" | "loading" | "failed" }) {
  const { c } = usePalette();
  return (
    <View style={{ paddingTop: 12, paddingBottom: 4, alignItems: "center" }}>
      {!hasOlder ? null : older === "failed" ? (
        <Pressable accessibilityRole="button" hitSlop={8} onPress={() => void loadOlder()} style={({ pressed }) => [pressed && { opacity: 0.6 }]}>
          <Text style={{ fontSize: 13, color: c.mutedForeground }}>
            没读到更早的消息 · <Text style={{ color: c.brand }}>重试</Text>
          </Text>
        </Pressable>
      ) : older === "loading" ? (
        <Spinner />
      ) : null}
    </View>
  );
}

/** 刚进来、一句都还没说时的那一屏 */
function Hello({ ws, kind, agentIds, title, people }: { ws: WorkspaceSnapshot; kind: "dm" | "group"; agentIds: string[]; title: string; people: readonly ChatPerson[] }) {
  const { c } = usePalette();
  const first = agentIds[0];
  if (kind === "dm" && first !== undefined) {
    const a = ws.agents.find((x) => x.agentId === first);
    return (
      <View style={{ alignItems: "center", gap: 8, paddingHorizontal: 32 }}>
        <FaceTile slot={agentFaceSlot(ws, first)} size={72} state="alive" phase={facePhase(first)} />
        <Text style={{ fontSize: 17, fontWeight: "600", color: c.foreground }}>{title}</Text>
        {a !== undefined && a.description !== "" ? <Text style={{ fontSize: 14, lineHeight: 20, color: c.mutedForeground, textAlign: "center" }}>{a.description}</Text> : null}
        <Text style={{ fontSize: 13, color: c.faint }}>说第一句话就开始了。</Text>
      </View>
    );
  }
  if (agentIds.length === 0 && people.length === 0) return <Text style={{ fontSize: 14, color: c.mutedForeground, textAlign: "center", paddingHorizontal: 32 }}>{EMPTY_GROUP_TEXT}</Text>;
  // 有朋友的群（#1393）：人在前、智能体在后，同列表里那张拼图
  const cells = [
    ...people.map((p) => ({ kind: "person" as const, name: p.name, url: p.avatarUrl })),
    ...agentIds.map((id) => ({ kind: "face" as const, id, slot: agentFaceSlot(ws, id) })),
  ].slice(0, 9);
  const names = [...people.map((p) => p.name), ...agentIds.map((id) => agentNameOf(ws, id))];
  return (
    <View style={{ alignItems: "center", gap: 10, paddingHorizontal: 32 }}>
      <GridTile cells={cells} size={72} />
      <Text style={{ fontSize: 14, lineHeight: 20, color: c.mutedForeground, textAlign: "center" }}>
        {`${names.join("、")}都在。说第一句话就开始了。`}
      </Text>
    </View>
  );
}

/** 按住说话时屏幕正中那一块（demo 的 .talk）：听到的字 + 松开发送 / 上划取消 */
function HoldOverlay({ state, text }: { state: HoldState; text: string }) {
  const { c } = usePalette();
  if (state.phase !== "down") return null;
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: "30%", alignItems: "center" }}>
      <View style={{ width: 188, minHeight: 168, borderRadius: 20, padding: 16, backgroundColor: "rgba(20, 20, 22, 0.88)", alignItems: "center", justifyContent: "center", gap: 12 }}>
        <Icon name="mic" size={40} stroke={1.6} color={state.cancel ? "rgba(255,255,255,0.4)" : "#5ac8fa"} />
        <Text numberOfLines={4} style={{ fontSize: 14, lineHeight: 20, color: "#ffffff", textAlign: "center" }}>{text === "" ? "在听…" : text}</Text>
        <View style={{ paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6, backgroundColor: state.cancel ? c.destructive : "transparent" }}>
          <Text style={{ fontSize: 13, color: "#ffffff" }}>{state.cancel ? "松开手指，取消发送" : "松开 发送 · 上划 取消"}</Text>
        </View>
      </View>
    </View>
  );
}

export function ChatScreen({ route, navigation }: Props) {
  const target = route.params;
  const { c } = usePalette();
  const home = useHome();
  const teams = useTeams();
  const chat = useChatStore();
  const inbox = useInbox();
  const me = useMyName();
  // 键盘让位自己量(#1490):不再靠 KAV + useHeaderHeight,见 ui.tsx 的 useKeyboardInset
  const kb = useKeyboardInset(() => {});
  const insets = useSafeAreaInsets();
  const friends = useFriends();
  const isTeam = target.kind === "team";
  /** 别人主场里拉我进去的群（#1393）：快照只够这一条群用（成员 = 群主 + 客人，智能体 = 群里那几只） */
  const isOutreach = target.kind === "outreach";
  const isGuestChat = target.kind === "guest" || isOutreach;
  const team = target.kind === "team" ? (teams.teams.find((t) => t.ws.id === target.workspaceId) ?? null) : null;
  // 朋友公开给我的车道（#1533）不在 teams.guests 里（它画在私聊页、不是一条群）：给 TA 的智能体打电话时从 peerLane 拼一份快照
  const guest = target.kind === "guest" || target.kind === "outreach"
    ? (teams.guests.find((g) => g.ws.id === target.workspaceId && g.session.id === target.sessionId) ?? (target.kind === "guest" ? peerLaneGuestChat(target.sessionId) : null))
    : null;
  const baseWs: WorkspaceSnapshot | null = isTeam ? (team?.ws ?? null) : isGuestChat ? (guest?.ws ?? null) : home.home;
  const loaded = isTeam || isGuestChat ? teams.loaded : home.loaded;

  const resolved = useMemo<Resolved | null>(() => {
    if (target.kind === "team") {
      if (team === null) return null;
      const s = team.sessions.find((x) => x.id === target.sessionId);
      if (s === undefined) return null;
      const agentIds = narrowRoster(team.ws.agents, s.chatKind === null ? null : s.agentIds).map((a) => a.agentId);
      return { kind: "group", sessionId: s.id, agentIds, title: teamChatTitle(team.ws, s), seed: null };
    }
    if (target.kind === "outreach") {
      if (guest === null) return null;
      const agentId = guest.session.agentIds[0];
      const ownerName = guest.ws.members.find((m) => m.uid === guest.ws.ownerUid)?.label ?? "";
      return {
        kind: "dm", sessionId: guest.session.id, agentIds: guest.session.agentIds,
        title: outreachCallerName(ownerName, agentId === undefined ? "" : agentNameOf(guest.ws, agentId)),
        seed: { kind: "outreach", agentIds: [...guest.session.agentIds], humans: [], outreach: { ownerName, active: false } },
      };
    }
    if (target.kind === "guest") {
      if (guest === null) return null;
      const people = guest.session.humans ?? [];
      const title = guest.session.title.trim() !== ""
        ? guest.session.title
        : [...guest.session.agentIds.map((id) => agentNameOf(guest.ws, id)), ...people.map((p) => p.name)].join("、");
      return {
        kind: "group", sessionId: guest.session.id, agentIds: guest.session.agentIds, title,
        seed: { kind: "group", agentIds: [...guest.session.agentIds], humans: people.map((h) => ({ uid: h.uid, name: h.name })) },
      };
    }
    if (baseWs === null) return null;
    return resolveChatTarget(baseWs, home.chats, target);
  }, [target, team, guest, baseWs, home.chats]);
  const sessionId = resolved?.sessionId ?? null;
  const key =
    target.kind === "agent" ? `a:${target.agentId}`
      : target.kind === "group" ? `g:${target.sessionId}`
        : target.kind === "guest" ? `j:${target.sessionId}`
          : target.kind === "outreach" ? `o:${target.sessionId}`
            : `t:${target.sessionId}`;

  const [pageNote, setPageNote] = useState<{ text: string; tone: "muted" | "error" } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [mentioning, setMentioning] = useState(false);
  const pendingMention = useRef<string | null>(null);
  const [pendingMedia, setPendingMedia] = useState<PendingCloudMedia[]>([]);
  const pendingMediaSeq = useRef(0);
  // 长按一句话派智能体（#1505）：挑好那只、写一句提示 → 推一张它的私聊页，开场白经路由参数 dispatch 带过去
  const [dispatching, setDispatching] = useState<{ key: number; visible: boolean; row: ChatRow } | null>(null);
  const dispatched = useRef(false);
  const voice = useVoice();
  const [callOp, setCallOp] = useState<"start" | "hangup" | null>(null);
  const [callOpen, setCallOpen] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [openCallSeq, setOpenCallSeq] = useState<number | null>(null);
  const [callSheetOpen, setCallSheetOpen] = useState(false);
  const [holdState, setHoldState] = useState<HoldState>({ phase: "idle" });
  const [holdText, setHoldText] = useState("");
  const [picker, setPicker] = useState<{ kind: "group" | "add" | "invite"; key: number; visible: boolean } | null>(null);
  const [pickBusy, setPickBusy] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const composer = useRef<ComposerHandle>(null);

  useEffect(() => {
    void refreshVoiceBilling();
  }, []);

  // 这条线已经存在就进房；草稿什么都不做，第一句发出去才建
  useEffect(() => {
    if (baseWs === null || resolved === null || sessionId === null) return;
    void openChat(baseWs.id, sessionId, resolved.seed, resolved.title);
    // 只跟「是哪一条」走：resolved 每次刷新都是新对象
  }, [baseWs?.id, sessionId]);
  // 离开时只断归这一页的连接（#1461 车道卡在「连接中」）：退场动画放完才卸载，那时朋友私聊页可能已经开上了它的
  // 私密车道——无条件 closeChat 会把那条掐掉。认法同下面 screenOwnsSession（草稿认这只智能体的私聊）
  const ownRef = useRef({ sessionId, draftAgentId: resolved?.kind === "dm" ? (resolved.agentIds[0] ?? null) : null });
  ownRef.current = { sessionId, draftAgentId: resolved?.kind === "dm" ? (resolved.agentIds[0] ?? null) : null };
  useEffect(
    () => () =>
      closeChatOwned((s) => screenOwnsSession({ pageSessionId: ownRef.current.sessionId, draftAgentId: ownRef.current.draftAgentId, current: s })),
    [],
  );
  // 回到这一页时连接可能已经被别的页面拿走了（#1461：从群信息点进朋友私聊，那一页要连它自己的私密车道——
  // 手机同一时刻只连得上一条）。拿走了就再进一次房，本机缓存先画，毫秒级
  useFocusEffect(
    useCallback(() => {
      if (baseWs === null || resolved === null || sessionId === null) return;
      if (chatSessionOf(sessionId) === null) void openChat(baseWs.id, sessionId, resolved.seed, resolved.title);
      // 同上：只跟「是哪一条」走
    }, [baseWs?.id, sessionId]),
  );

  // 只认这一页自己那一条（#1461）：连接被叠在上面的朋友私聊页拿去连私密车道时，store 里是那条车道——
  // 不判的话这一页会在后台拿车道的事件画自己的时间线。草稿（还没有 sessionId）只认这只智能体的私聊（复审 M2）
  const session = screenOwnsSession({
    pageSessionId: sessionId,
    draftAgentId: resolved?.kind === "dm" ? (resolved.agentIds[0] ?? null) : null,
    current: chat.session,
  })
    ? chat.session
    : null;
  const events = session?.events ?? EMPTY_EVENTS;
  // 名单只读服务器给的：连接中 events 里可能是缓存，缓存里的名单可能比清单投影还旧，
  // 而 chat_update 发的是完整名单，拿旧的发出去会把别的设备上的改动悄悄撤销（#1426）。
  // 时间线照旧画缓存，只有这两处名单推导退回连接前的回落（种子 / 清单投影）
  const rosterEvents = session?.provisional === true ? EMPTY_EVENTS : events;
  const selfUid = session?.selfUid || inbox.selfUid || "";
  const draft = resolved !== null && resolved.sessionId === null && session === null;
  // 群里的真人（#1393）：welcome 之后日志里那份是事实；清单那一行的投影只补头像、以及 welcome 之前先画上
  const dbPeople = useMemo<ChatPerson[]>(
    () => (guest !== null ? (guest.session.humans ?? []) : target.kind === "group" ? (home.chats.find((x) => x.id === target.sessionId)?.humans ?? []) : []),
    [guest, target, home.chats],
  );
  const chatInfo = session?.chat ?? null;
  const people = useMemo<ChatPerson[]>(() => {
    if (isTeam || chatInfo === null) return dbPeople;
    return chatHumansNow(rosterEvents, chatInfo.humans).map((h) => ({ uid: h.uid, name: h.name, avatarUrl: dbPeople.find((p) => p.uid === h.uid)?.avatarUrl ?? "" }));
  }, [isTeam, chatInfo, rosterEvents, dbPeople]);
  // 名字、头像、「等 X 批」都按成员表查：把群里的人补进这一条群用的快照（团队群的成员表本来就全）
  const ws = useMemo(() => (baseWs === null || isTeam ? baseWs : withGuests(baseWs, people)), [baseWs, isTeam, people]);
  // 外联会话（#1441）只有一只智能体、名单不会变：头部那行直接用清单推出来的，不走 chatViewOf（那条把 outreach 当群）
  const view = isOutreach
    ? (resolved === null ? null : { kind: "dm" as const, agentIds: resolved.agentIds, title: resolved.title })
    : ws !== null && session !== null && session.chat ? chatViewOf(ws, session.chat, rosterEvents, resolved?.title ?? "") : null;
  const kind = view?.kind ?? resolved?.kind ?? "dm";
  const agentIds = view?.agentIds ?? resolved?.agentIds ?? [];
  const dmAgent = kind === "dm" ? (agentIds[0] ?? null) : null;
  const group = kind === "group";
  const title = (view?.title ?? resolved?.title ?? "") || (group ? people.map((p) => p.name).join("、") : "");
  /** 群里除了我之外的人：团队群 = 别的成员；有朋友的群 = 群主那一侧的客人，或客人那一侧的群主 + 别的客人 */
  const humans = useMemo(() => {
    if (ws === null) return [];
    if (isTeam) return ws.members.filter((m) => m.uid !== selfUid).map((m) => ({ uid: m.uid, name: m.label, url: m.avatarUrl }));
    if (!group) return [];
    return othersInGroup({ ws, humans: people, selfUid, guestView: isGuestChat }).map((p) => ({ uid: p.uid, name: p.name, url: p.avatarUrl }));
  }, [isTeam, isGuestChat, group, ws, people, selfUid]);
  /** 能拉进来的朋友：我的朋友里此刻不在群里的（群主也不算——他本来就在） */
  const invitable = useMemo(
    () => friendPeople(friends.rows, new Set([selfUid, baseWs?.ownerUid ?? "", ...people.map((p) => p.uid)])),
    [friends.rows, selfUid, baseWs?.ownerUid, people],
  );
  // 群主往群里拉了一只我这边还不认识的智能体（客人手上的快照只有当时那几只）：重拉一次，名字和脸才画得出来
  const unknownAgent = isGuestChat && baseWs !== null && chatInfo !== null &&
    (chatRosterNow(events, chatInfo.agentIds) ?? []).some((id) => !baseWs.agents.some((a) => a.agentId === id));
  useEffect(() => {
    if (unknownAgent) void refreshTeams();
  }, [unknownAgent]);

  // 已读：开着的这一条列表不画未读；离开 / 失焦时游标推到此刻。团队群里 @ 我的，进来就算看过了
  useFocusEffect(
    useCallback(() => {
      setOpenKey(key);
      return () => {
        setOpenKey(null);
        markSeen(key, Date.now());
      };
    }, [key]),
  );
  const lastTs = events.length > 0 ? events[events.length - 1]!.ts : 0;
  useEffect(() => {
    if (lastTs > 0) markSeen(key, lastTs);
  }, [key, lastTs]);
  useEffect(() => {
    if ((isTeam || group) && sessionId !== null) void readTeamMentions(sessionId);
  }, [isTeam, group, sessionId, lastTs]);

  const call = useMemo(() => voiceCallOf(events), [events]);
  const inCall = useMemo(() => (call === null ? null : new Set(call.participants.map((p) => p.agentId))), [call]);
  const rows = useMemo(
    () => (ws !== null ? chatRows({ events, ws, selfUid, now: Date.now(), ownerOnly: isHomeWorkspace(ws), ...(session?.ownerUid ? { ownerUid: session.ownerUid } : {}) }) : []),
    [ws, events, selfUid, session?.ownerUid],
  );
  const live = useMemo(
    () => (ws !== null ? liveRows({ streaming: chat.streaming, ws, now: Date.now(), ...(inCall === null ? {} : { hide: inCall }) }) : []),
    [ws, chat.streaming, inCall],
  );
  // 状态的折叠与欠着的几轮只跟 events 走：流式每来一片（每只最多 50 毫秒一片）只重算下面那一行，
  // 不把整份日志再过两遍
  const fold = useMemo(() => activityFoldOf(events), [events]);
  const turns = useMemo(() => openTurns(events), [events]);
  const nowRow = useMemo(
    () => (ws !== null ? nowRowOf({ events, streaming: chat.streaming, ws, fold, turns }) : null),
    [ws, events, chat.streaming, fold, turns],
  );
  const roleAnchor = useMemo(() => roleChipsAnchor(events), [events]);
  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    for (const row of [...rows, ...live]) {
      list.push({ kind: "row", row });
      if (roleAnchor !== null && row.key === `e${roleAnchor}`) list.push({ kind: "roles" });
    }
    // 发出去、回执还没回来的那几句（#1473）：先画在最底下。回执一到就从 outbox 摘掉——服务端先广播
    // 事件再回 say_result，两帧走同一条连接按序到，摘掉那一刻真的那条已经在 rows 里了
    const sid = session?.sessionId ?? null;
    for (const line of chat.outbox) if (line.sessionId === sid) list.push({ kind: "outbox", line });
    // 正在传的图 / 视频（#1491）：也在最底下，传完 say 的回执一到，真的那条已经在 rows 里
    for (const p of pendingMedia) list.push({ kind: "media", p });
    // 它已经在往外写字了（流式那一段画出来了）就不再画三个点
    if (nowRow !== null && !(nowRow.phase === "solving" && live.some((r) => r.kind === "agent" && r.agentId === nowRow.agentId))) {
      list.push({ kind: "now", now: nowRow });
    }
    return list.reverse();
  }, [rows, live, nowRow, roleAnchor, chat.outbox, pendingMedia, session?.sessionId]);

  const ready = session?.state === "ready";
  const canSend = draft || ready;

  const onSend = async (text: string): Promise<boolean> => {
    if (ws === null || resolved === null) return false;
    const candidates = agentIds.map((id) => ({ agentId: id, name: agentNameOf(ws, id) }));
    // 点得到的人：团队群 = 全体成员；有朋友的群（#1393）= 群里别的人。点到的人收到提醒（ADR-0256），不起 turn
    const memberCandidates = isTeam ? ws.members.map((m) => ({ agentId: m.uid, name: m.label })) : humans.map((h) => ({ agentId: h.uid, name: h.name }));
    const plan = resolveSendMentions({ text, parsed: parseMentions(text, candidates), refreshFailed: false, freshCandidates: candidates, memberCandidates });
    if (plan.kind === "block") {
      setPageNote({ text: plan.error, tone: "error" });
      return false;
    }
    setPageNote(null);
    if (draft && dmAgent !== null) {
      const r = await startDm(ws.id, dmAgent, text, plan.mentions);
      if (!r.ok) {
        setPageNote({ text: r.message, tone: "error" });
        return false;
      }
      void refreshHomeAfterWrite();
      return true;
    }
    const memberMentions = memberCandidates.length > 0 ? parseMemberMentions(text, candidates, memberCandidates).filter((uid) => uid !== selfUid) : [];
    const r = await sendText(text, plan.mentions, memberMentions);
    return r.ok || r.unknown === true;
  };

  // 别处长按派过来的开场白（#1505）：房间一能发就发（一次）。走 onSend：私聊还没建就 startDm 顺手建，建了就 sendText
  useEffect(() => {
    const text = route.params.dispatch;
    if (text === undefined || dispatched.current || !canSend || ws === null || resolved === null) return;
    dispatched.current = true;
    void onSend(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params.dispatch, canSend, ws, resolved]);

  // 图 / 视频（#1491 P3）：先传进 chat-media（按内容寻址），引用塞进 say 帧。点到谁与打字那条路同一份判据
  // （空正文 = 没 @ 谁；私聊里 resolveSendMentions 照样解出那一只），runtime 落盘时把正文写成占位「[图片]」
  const runMediaSend = (p: PendingCloudMedia): void => {
    if (ws === null || session === null) return;
    const wsId = ws.id;
    const sid = session.sessionId;
    const candidates = agentIds.map((id) => ({ agentId: id, name: agentNameOf(ws, id) }));
    const memberCandidates = isTeam ? ws.members.map((m) => ({ agentId: m.uid, name: m.label })) : humans.map((h) => ({ agentId: h.uid, name: h.name }));
    const plan = resolveSendMentions({ text: "", parsed: parseMentions("", candidates), refreshFailed: false, freshCandidates: candidates, memberCandidates });
    const mentions = plan.kind === "block" ? [] : plan.mentions;
    const patch = (f: (x: PendingCloudMedia) => PendingCloudMedia): void => setPendingMedia((list) => list.map((x) => (x.key === p.key ? f(x) : x)));
    patch((x) => ({ ...x, state: "sending", error: null, progress: 0 }));
    void sendCloudMedia(wsId, sid, p.items, {
      hash: sha256OfFile,
      fileSize: fileSizeOf,
      upload: (bucket, path, uri, mime) => uploadMediaFile(bucket, path, uri, mime, () => {}),
      send: (refs) => sendText("", mentions, [], refs),
      onProgress: (fraction) => patch((x) => ({ ...x, progress: fraction })),
    }).then(
      (r) => {
        if (r.ok || r.unknown === true) setPendingMedia((list) => list.filter((x) => x.key !== p.key));
        else patch((x) => ({ ...x, state: "failed", error: r.message }));
      },
      (e: unknown) => patch((x) => ({ ...x, state: "failed", error: e instanceof Error ? e.message : String(e) })),
    );
  };
  // 挑好的就地处理（同朋友私聊）：HEIC 转 JPEG、原图缩到 2048、视频查时长大小抽封面。一样处理不了只说那一样，别的照发
  const sendPicked = async (pick: () => Promise<PickedAsset[]>): Promise<void> => {
    setPageNote(null);
    let assets: PickedAsset[];
    try {
      assets = await pick();
    } catch (e) {
      setPageNote({ text: e instanceof Error ? e.message : String(e), tone: "error" });
      return;
    }
    if (assets.length === 0) return;
    const ready: PreparedMedia[] = [];
    const problems: string[] = [];
    for (const a of assets) {
      try {
        ready.push(await prepareAsset(a));
      } catch (e) {
        problems.push(`${pickedKind(a) === "video" ? "视频" : "图片"}：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const group of planMediaMessages(ready)) {
      const p: PendingCloudMedia = { key: ++pendingMediaSeq.current, items: group, state: "sending", progress: 0, error: null };
      setPendingMedia((list) => [...list, p]);
      runMediaSend(p);
    }
    if (problems.length > 0) setPageNote({ text: problems.length === 1 ? (problems[0] ?? "") : `有 ${problems.length} 样没发：${problems[0] ?? ""}`, tone: "error" });
  };

  const stop = async (seq: number): Promise<void> => {
    setStopping(true);
    const r = await stopTurn(seq);
    setStopping(false);
    if (!r.ok) setPageNote(r.unknown ? { text: "没有收到回执，不确定停下来没有", tone: "muted" } : { text: r.message, tone: "error" });
  };

  const decide = async (callId: string, decision: "approved" | "denied"): Promise<void> => {
    // 没连上之前画的可能是缓存里的审批卡（#1426）：不许批，钮也已经按住了，这里是第二道
    if (!ready) return;
    setDeciding(callId);
    const r = await cloudClient.approve(callId, decision);
    setDeciding(null);
    if (!r.ok) setPageNote(r.unknown ? { text: "没有收到回执，不确定批下去没有", tone: "muted" } : { text: r.message, tone: "error" });
  };

  // ── 通话 ──
  // 外联会话里好友听的语音记主人的账（票），他自己订没订阅与这通电话无关：只看这台有没有原生语音模块
  const usable = isOutreach ? nativeSpeech : voiceUsable(voice);
  const listen = voice.listen !== null && session !== null && voice.listen.sessionId === session.sessionId ? voice.listen : null;
  const starting = callOp === "start";
  const barMode = callBarMode({ call, listeningHere: listen !== null, starting });
  const offerPhone = phoneOffered({ voiceUsable: usable, ready, agentIds, call });
  useEffect(() => {
    if (call === null) setCallOpen(false);
  }, [call]);
  // 从智能体资料点「语音通话」进来：房间一 ready、打得了电话就打出去（只打一次，挂断之后不再自己拨）
  const autoCalled = useRef(false);
  const onStartCall = async (): Promise<void> => {
    if (session === null || agentIds.length === 0) return;
    setCallOp("start");
    setCallOpen(true);
    // 只打这一只（#1550）：私聊页「给 TA 的智能体打电话」进来的——车道里可能还带着别的智能体，它们不该一起接
    const only = route.params.callAgentId;
    const ids = only !== undefined && agentIds.includes(only) ? [only] : dmAgent !== null ? [dmAgent] : agentIds;
    const r = await startCall(session.sessionId, ids);
    setCallOp(null);
    if (!r.ok) {
      setCallOpen(false);
      setPageNote(r.unknown ? { text: "没有收到回执，不确定电话打出去没有", tone: "muted" } : { text: r.message, tone: "error" });
    }
  };
  // 从私聊页打给对方的智能体（#1550）：这页只是通话的载体，不是他要看的群聊——挂断就回私聊页，
  // 总结那段话会出现在那页里（车道的话本来就并在私聊里显示）
  const autoCallLive = useRef(false);
  useEffect(() => {
    if (route.params.callAgentId === undefined) return;
    if (call !== null) autoCallLive.current = true;
    else if (autoCallLive.current) {
      autoCallLive.current = false;
      navigation.goBack();
    }
  }, [route.params.callAgentId, call !== null]);
  const onHangUp = async (): Promise<void> => {
    setCallOp("hangup");
    const r = await hangUp();
    setCallOp(null);
    if (!r.ok) setPageNote(r.unknown ? { text: "没有收到回执，不确定挂断没有", tone: "muted" } : { text: r.message, tone: "error" });
  };
  const openCallCard = useMemo(() => {
    if (openCallSeq === null) return null;
    for (const r of rows) {
      if (r.kind === "call" && r.card.seq === openCallSeq) return r.card;
      // 回电接通开出来的那一场合在来电记录里（#1411）
      if (r.kind === "ring" && r.call !== null && r.call.seq === openCallSeq) return r.call;
      // 我的智能体打给朋友的那通（#1441）：转写抽屉与通话卡同一扇
      if (r.kind === "outreach" && r.card !== null && r.card.seq === openCallSeq) return r.card;
    }
    return null;
  }, [rows, openCallSeq]);

  // ── 拉人建群 / 拉人（主场里的智能体 + 我的朋友，#1393；客人只拉得了自己的朋友；团队群的成员在电脑上管，spec §2） ──
  const closePicker = (): void => setPicker((p) => (p === null ? p : { ...p, visible: false }));
  const afterPick = useRef<string | null>(null);
  const onPickOk = async (picked: string[], name: string, pickedPeople: string[]): Promise<void> => {
    if (ws === null || picker === null) return;
    setPickBusy(true);
    setPickError(null);
    if (picker.kind === "group") {
      const rowsPicked = invitable.filter((p) => pickedPeople.includes(p.uid)).map((p) => ({ name: p.name }));
      const r = await cloudClient.create(ws.id, {
        kind: "group",
        name: mixedGroupName(ws, picked, rowsPicked, name),
        agentIds: picked,
        ...(pickedPeople.length > 0 ? { humans: pickedPeople } : {}),
      });
      if (!r.ok) {
        setPickBusy(false);
        setPickError(r.message);
        return;
      }
      await refreshHomeAfterWrite();
      afterPick.current = r.value.sessionId;
    } else if (sessionId !== null) {
      let next = agentIds;
      for (const id of picked) next = withAgent(ws, next, id);
      const r = await cloudClient.chatUpdate(ws.id, sessionId, {
        ...(picked.length > 0 ? { agentIds: next } : {}),
        ...(pickedPeople.length > 0 ? { humans: [...people.map((p) => p.uid), ...pickedPeople] } : {}),
      });
      if (!r.ok) {
        setPickBusy(false);
        setPickError(r.message);
        return;
      }
      void (isGuestChat ? refreshTeams() : refreshHomeAfterWrite());
    }
    setPickBusy(false);
    closePicker();
  };

  useEffect(() => {
    if (route.params.autoCall !== true || autoCalled.current || !offerPhone) return;
    autoCalled.current = true;
    void onStartCall();
    // onStartCall 每次渲染都是新的；这里只跟「打得了没有」走
  }, [route.params.autoCall, offerPhone]);

  // 打给一只（#1411）：接回电、点聊天里那条来电 / 未接记录都走这里。通话本来就开着（锁屏没挂，ADR-0320）
  // 时把它并进现在的名单——runtime 认的是「发的名单里有没有正在给他响铃的那只」，没在响的就是普通的拉人。
  // 回 true = 这一帧有了回执、电话打出去了
  const callAgent = async (agentId: string): Promise<boolean> => {
    if (session === null) return false;
    if (!usable) {
      setPageNote({ text: "这台手机上打不了电话（要装开发版）", tone: "muted" });
      return false;
    }
    const ids = call === null ? [agentId] : [...new Set([...call.participants.map((p) => p.agentId), agentId])];
    setCallOp("start");
    setCallOpen(true);
    const r = await startCall(session.sessionId, ids);
    setCallOp(null);
    if (!r.ok) {
      setCallOpen(false);
      setPageNote(r.unknown ? { text: "没有收到回执，不确定接通了没有", tone: "muted" } : { text: r.message, tone: "error" });
    }
    return r.ok;
  };

  // 接回电（#1411 → #1428）：从系统来电界面接听进来——房间 ready、系统把音频会话交过来之后才把打电话的那只拉进
  // 通话（一次；先开麦会和 CallKit 抢会话）。打不了就当场收尾，页面上那一行说为什么
  const answeredRing = useRef<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const callKit = useCallKit();
  useEffect(() => {
    const ar = route.params.answerRing;
    if (ar === undefined || answeredRing.current === ar.ringId || !ready || session === null || !systemAudioReady(callKit, ar.ringId)) return;
    answeredRing.current = ar.ringId;
    setAnswering(ar.ringId);
    void callAgent(ar.agentId).then((ok) => {
      if (ok) return;
      setAnswering(null);
      settleAnswer(ar.ringId, "note");
    });
    // 只跟「房间好了没有」走（同 autoCall）；callAgent 每次渲染都是新的
  }, [route.params.answerRing, ready, session?.sessionId, callKit]);
  useEffect(() => {
    if (answering === null || call === null || !callOpen) return;
    settleAnswer(answering, "call");
    setAnswering(null);
  }, [answering, call !== null, callOpen]);

  const plus: PlusItem[] = [];
  // 图片 / 视频（#1491 P3）：相册一次最多挑 9 样；拍摄是拍照或录一段（≤60 秒）。要会话已经建好（草稿私聊的第一句先是字）、
  // 外联会话只读
  if (ready && session !== null && !isOutreach && ws !== null) {
    plus.push({ key: "album", icon: "image", label: "相册", onPress: () => void sendPicked(pickFromLibrary) });
    plus.push({ key: "camera", icon: "camera", label: "拍摄", onPress: () => void sendPicked(pickFromCamera) });
  }
  if (offerPhone) plus.push({ key: "call", icon: "phone", label: "语音通话", onPress: () => void onStartCall() });
  const openPicker = (kind: "group" | "add" | "invite"): void => {
    setPickError(null);
    setPicker({ kind, key: Date.now(), visible: true });
  };
  if (!isTeam && !isGuestChat && dmAgent !== null && ws !== null && (ws.agents.length >= CHAT_GROUP_CREATE_MIN || invitable.length > 0) && session !== null) {
    plus.push({ key: "group", icon: "users-round", label: "拉人建群", onPress: () => openPicker("group") });
  }
  const agentRoom = ws !== null && agentIds.length < CHAT_GROUP_MAX && ws.agents.some((a) => !agentIds.includes(a.agentId));
  const peopleRoom = invitable.length > 0 && people.length < CHAT_HUMANS_MAX;
  if (!isTeam && !isGuestChat && group && session !== null && ws !== null && (agentRoom || peopleRoom)) {
    plus.push({ key: "add", icon: "user-round-plus", label: "拉人", onPress: () => openPicker("add") });
  }
  if (isGuestChat && group && session !== null && peopleRoom) {
    plus.push({ key: "invite", icon: "user-round-plus", label: "拉朋友", onPress: () => openPicker("invite") });
  }
  if (group && session !== null && session.state !== "denied" && (agentIds.length > 0 || humans.length > 0)) {
    plus.push({ key: "at", icon: "at-sign", label: "@ 谁", onPress: () => setMentioning(true) });
  }

  // ── 头部 ──
  // 人数：团队群 = 全体成员 + 智能体；别的群 = 我 + 群里别的人 + 智能体
  const count = !group ? 0 : isTeam && ws !== null ? ws.members.length + agentIds.length : humans.length + 1 + agentIds.length;
  const status = session?.state === "gone" ? "正在重连…" : nowRow !== null ? PHASE_STATUS[nowRow.phase] : "";
  const others = inbox.unreadChats;
  const infoOk = !isOutreach && resolved !== null && (sessionId !== null || dmAgent !== null);
  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => <ChatTitle title={title} count={count} status={status} />,
      headerRight: () =>
        infoOk ? (
          <HeaderIconButton label="聊天信息" onPress={() => navigation.navigate("ChatInfo", target)}>
            <Icon name="ellipsis" size={24} stroke={2} color={c.foreground} />
          </HeaderIconButton>
        ) : null,
      ...(others > 0 ? { headerBackTitle: String(others), headerBackButtonDisplayMode: "default" as const } : { headerBackButtonDisplayMode: "minimal" as const }),
    });
  }, [navigation, title, count, status, others, infoOk, target, c.foreground]);

  const centre = chatCentre({
    session: session === null ? null : { state: session.state, eventCount: events.length },
    draft,
    openFailed: chat.error !== null,
    rowCount: items.length,
  });
  const emptyGroup = group && session !== null && agentIds.length === 0 && humans.length === 0;
  const holdOk = dictationUsable(voice) && canSend;
  // 外联会话（#1441）：输入栏换成一句说明。主人打开这条也只读（同一份说明判据：mobileChat.outreachComposer）
  const composerPlan = outreachComposer(chatInfo ?? resolved?.seed ?? null, (session?.ownerUid || baseWs?.ownerUid || "") === selfUid && selfUid !== "");
  const composerNote = composerPlan.kind === "note" ? composerPlan.text : null;

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View ref={kb.root.ref} onLayout={kb.root.onLayout} style={{ flex: 1, paddingBottom: kb.keyboard }}>
        <View style={{ flex: 1 }}>
          {ws !== null && resolved === null ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              {loaded ? <Text style={{ fontSize: 15, color: c.mutedForeground }}>这条聊天已经不在了。</Text> : <Spinner />}
            </View>
          ) : ws === null || centre === "loading" ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Spinner /></View>
          ) : centre === "hello" ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              {isOutreach ? (
                <Text style={{ fontSize: 14, lineHeight: 20, color: c.mutedForeground, textAlign: "center", paddingHorizontal: 32 }}>
                  {`${title}打来的电话会记在这里。`}
                </Text>
              ) : <Hello ws={ws} kind={kind} agentIds={agentIds} title={title} people={humans.map((h) => ({ uid: h.uid, name: h.name, avatarUrl: h.url }))} />}
            </View>
          ) : centre === "blank" ? (
            <View style={{ flex: 1 }} />
          ) : (
            <FlatList
              inverted
              // 不满一屏时贴顶（#1424，微信同款）：inverted 是整张列表上下翻转，内容坐标里的
              // 「尾」就是屏幕上的「顶」——撑满之后往尾部挤，画出来就是从顶往下排。满屏之后
              // flexGrow 不起作用，行为与改动前相同。paddingBottom 在屏幕上是顶上那一点留白
              contentContainerStyle={CHAT_LIST_TOP}
              data={items}
              keyExtractor={(it) => (it.kind === "row" ? it.row.key : it.kind === "now" ? it.now.key : it.kind === "outbox" ? `o${it.line.id}` : it.kind === "media" ? `m${it.p.key}` : "roles")}
              renderItem={({ item }) =>
                item.kind === "row" ? (
                  <ChatRowView
                    row={item.row}
                    ws={ws}
                    selfUid={selfUid}
                    selfName={me.name}
                    selfAvatar={me.avatar}
                    group={group}
                    outreachChat={isOutreach}
                    deciding={deciding}
                    decideReady={ready}
                    onDecide={(id, d) => void decide(id, d)}
                    onAgent={(agentId) => navigation.navigate("Agent", isTeam || isGuestChat ? { agentId, workspaceId: ws.id } : { agentId })}
                    {...(home.home !== null && home.home.agents.length > 0 && !isOutreach
                      ? { onLongPress: (r: ChatRow) => setDispatching({ key: Date.now(), visible: true, row: r }) }
                      : {})}
                    onCallAgent={(agentId) => {
                      if (ready) void callAgent(agentId);
                    }}
                    onOpenCall={(seq) => {
                      setOpenCallSeq(seq);
                      setCallSheetOpen(true);
                    }}
                  />
                ) : item.kind === "outbox" ? (
                  <PendingMineRow text={item.line.text} selfName={me.name} selfAvatar={me.avatar} />
                ) : item.kind === "media" ? (
                  <View style={{ flexDirection: "row-reverse", alignItems: "flex-start", gap: 10, paddingHorizontal: 12 }}>
                    <PersonTile name={me.name} url={me.avatar} size={40} me />
                    <View style={{ flexShrink: 1, maxWidth: "76%" }}>
                      <PendingMediaBubble
                        items={item.p.items}
                        state={item.p.state}
                        progress={item.p.progress}
                        error={item.p.error}
                        onRetry={() => runMediaSend(item.p)}
                        onDrop={() => setPendingMedia((list) => list.filter((x) => x.key !== item.p.key))}
                      />
                    </View>
                  </View>
                ) : item.kind === "now" ? (
                  <TypingRow
                    ws={ws}
                    agentId={item.now.agentId}
                    name={item.now.name}
                    face={item.now.face}
                    group={group}
                    canStop={item.now.canStop && ready}
                    stopping={stopping}
                    onStop={() => void stop(item.now.seq)}
                  />
                ) : (
                  <View style={{ paddingLeft: 62, paddingRight: 12 }}>
                    <RoleChips onPick={(text) => composer.current?.fill(text)} />
                  </View>
                )
              }
              ItemSeparatorComponent={Gap}
              onEndReached={() => {
                if (session?.hasOlder && session.older === "idle") void loadOlder();
              }}
              onEndReachedThreshold={0.5}
              ListHeaderComponent={<View style={{ height: 14 }} />}
              ListFooterComponent={<OlderRow hasOlder={session?.hasOlder ?? false} older={session?.older ?? "idle"} />}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
            />
          )}
          {call !== null && !callOpen && session !== null ? <CallPill sinceTs={call.sinceTs} onPress={() => setCallOpen(true)} /> : null}
          <HoldOverlay state={holdState} text={holdText} />
        </View>

        <View style={{ gap: 6, paddingHorizontal: 16, paddingBottom: 6 }}>
          {session?.state === "denied" ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Line tone="error">{cloudDeniedText(session.deniedCode, session.deniedServerVersion)}</Line>
              <Button size="auto" variant="plain" label="回列表" onPress={() => navigation.popToTop()} />
            </View>
          ) : null}
          {session?.gapNote ? <Line tone="warn">{session.gapNote}</Line> : null}
          {chat.notice ? <Line tone="muted">{chat.notice}</Line> : null}
          {chat.error ? <Line tone="error">{chat.error}</Line> : null}
          {chat.sendError ? <Line tone="error">{chat.sendError}</Line> : null}
          {pageNote ? <Line tone={pageNote.tone}>{pageNote.text}</Line> : null}
          {listen?.error ? <Line tone="error">{listen.error}</Line> : null}
          {chat.unsent !== null && chat.unsent.sessionId === session?.sessionId ? (
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
              <Line tone="muted">{chat.unsent.note}</Line>
              <Button size="auto" variant="plain" label="重新发送" disabled={!ready} onPress={() => void resendUnsent()} />
              <Button size="auto" variant="plain" label="放弃" onPress={dropUnsent} />
            </View>
          ) : null}
          {emptyGroup && centre !== "hello" ? <Line tone="muted">{EMPTY_GROUP_TEXT}</Line> : null}
        </View>

        {composerNote !== null ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: Math.max(insets.bottom, 12), borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border }}>
            <Text style={{ fontSize: 13, lineHeight: 18, color: c.mutedForeground, textAlign: "center" }}>{composerNote}</Text>
          </View>
        ) : (
        <WxComposer
          ref={composer}
          draftKey={key}
          placeholder={roleAnchor !== null ? "说一句它是干什么的…" : group ? "说点什么，输入 @ 点名" : ""}
          canSend={canSend}
          sessionId={session?.sessionId ?? null}
          onSend={onSend}
          {...(group ? { onAt: () => setMentioning(true) } : {})}
          plus={plus}
          {...(holdOk
            ? {
              hold: {
                onDown: () => {
                  setHoldText("");
                  startDictation(setHoldText, (m) => setPageNote({ text: m, tone: "error" }));
                },
                onChange: setHoldState,
                onUp: (send: boolean) => {
                  void (async () => {
                    const text = await stopDictation(send);
                    setHoldText("");
                    if (!send) return;
                    if (text.trim() === "") {
                      toast("没听清，按住再说一遍");
                      return;
                    }
                    await onSend(text.trim());
                  })();
                },
              },
            }
            : {})}
        />
        )}
      </View>

      {dispatching !== null && home.home !== null ? (
        <DispatchDialog
          key={dispatching.key}
          visible={dispatching.visible}
          ws={home.home}
          agentIds={home.home.agents.map((a) => a.agentId)}
          preview={dispatching.row.kind === "agent" ? dispatching.row.paragraphs.join(" ") : dispatching.row.kind === "mine" || dispatching.row.kind === "human" ? dispatching.row.text : ""}
          onOk={(agentId, prompt) => {
            const lines = quoteWindow(quoteLinesFromRows(rows, me.name), dispatching.row.key);
            setDispatching((d) => (d === null ? d : { ...d, visible: false }));
            if (lines === null) return;
            navigation.push("Chat", { kind: "agent", agentId, dispatch: dispatchOpening({ prompt, source: title, lines }) });
          }}
          onClose={() => setDispatching((d) => (d === null ? d : { ...d, visible: false }))}
          onExited={() => setDispatching(null)}
        />
      ) : null}
      {ws !== null ? (
        <MentionSheet
          visible={mentioning}
          ws={ws}
          agentIds={agentIds}
          humans={humans}
          onPick={(name) => {
            pendingMention.current = name;
            setMentioning(false);
          }}
          onClose={() => setMentioning(false)}
          onExited={() => {
            const name = pendingMention.current;
            pendingMention.current = null;
            // 抽屉的 Modal 要等这一拍提交之后才真的收起：等一帧再插，不然输入框拿不到焦点
            if (name !== null) requestAnimationFrame(() => composer.current?.mention(name));
          }}
        />
      ) : null}

      <CallSheet visible={callSheetOpen} card={openCallCard} onClose={() => setCallSheetOpen(false)} onExited={() => setOpenCallSeq(null)} />

      {call !== null && ws !== null && session !== null ? (
        (() => {
          const face = callFace({ call, speaking: listen?.speaking ?? null, open: turns });
          const micOn = callMicOn({ mic: listen?.mic.status ?? null, starting });
          const ids = call.participants.map((p) => p.agentId);
          const faces = dmAgent !== null || ids.length <= 1 ? (
            <FaceTile slot={agentFaceSlot(ws, face?.agentId ?? ids[0] ?? "")} size={168} radius={46} state={face?.state ?? "listening"} phase={facePhase(face?.agentId ?? "")} />
          ) : (
            <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 16, maxWidth: 220 }}>
              {ids.slice(0, 4).map((id) => (
                <FaceTile key={id} slot={agentFaceSlot(ws, id)} size={92} radius={26} state={face?.agentId === id ? face.state : "listening"} phase={facePhase(id)} />
              ))}
            </View>
          );
          const speaking = listen?.speaking ?? null;
          return (
            <CallOverlay
              visible={callOpen}
              mode={barMode === "idle" ? "idle" : "live"}
              title={title}
              faces={faces}
              status={barMode === "idle" ? "通话还开着" : speaking !== null ? `${agentNameOf(ws, speaking)} 正在说` : face?.state === "composing" || face?.state === "queued" ? "在想" : "在听"}
              sinceTs={call.sinceTs}
              wave={waveMode({ micOn, micActive: listen?.mic.active ?? false, agentSpeaking: listen !== null && listen.speaking !== null })}
              level={listen?.mic.level ?? 0}
              micOn={micOn}
              captionsOn={captionsOn}
              captions={{ agent: listen?.text ?? null, me: listen !== null && listen.mic.transcript !== "" ? listen.mic.transcript : null }}
              joinBlocked={joinBlockedText({ native: true, room: session.state, billing: voice.billing, ...(isOutreach ? { billingExempt: true } : {}) })}
              busy={callOp !== null}
              onMinimize={() => setCallOpen(false)}
              onToggleCaptions={() => setCaptionsOn((v) => !v)}
              onToggleMic={() => setMic(!micOn)}
              onHangUp={() => void onHangUp()}
              onJoin={() => joinCall(session.sessionId)}
            />
          );
        })()
      ) : null}

      {picker !== null && ws !== null ? (
        <PickAgentsDialog
          key={picker.key}
          visible={picker.visible}
          ws={ws}
          title={picker.kind === "group" ? "拉人建群" : picker.kind === "invite" ? "拉朋友进群" : "拉人进群"}
          lead={
            picker.kind === "group" ? "带上它，再拉几位（智能体或朋友），凑够 2 位就能建。"
              : picker.kind === "invite" ? "只能拉你自己的朋友。群里的智能体归群主管。"
                : `智能体最多 ${CHAT_GROUP_MAX} 只。朋友进来之后，他们让智能体动手要等你批。`
          }
          options={
            picker.kind === "invite" ? []
              : picker.kind === "group" ? ws.agents.map((a) => a.agentId)
                : ws.agents.map((a) => a.agentId).filter((id) => !agentIds.includes(id))
          }
          preset={picker.kind === "group" && dmAgent !== null ? [dmAgent] : []}
          min={picker.kind === "group" ? CHAT_GROUP_CREATE_MIN : 1}
          max={picker.kind === "group" ? CHAT_GROUP_MAX : CHAT_GROUP_MAX - agentIds.length}
          people={invitable}
          maxPeople={CHAT_HUMANS_MAX - (picker.kind === "group" ? 0 : people.length)}
          okLabel={picker.kind === "group" ? "建群" : "拉进来"}
          withName={picker.kind === "group"}
          busy={pickBusy}
          error={pickError}
          onOk={(picked, name, pickedPeople) => void onPickOk(picked, name, pickedPeople)}
          onClose={closePicker}
          onExited={() => {
            setPicker(null);
            const sid = afterPick.current;
            afterPick.current = null;
            // 从私聊拉人建群：换成那个新群（返回回到列表，不回到这条私聊）
            if (sid !== null && navigation.isFocused()) navigation.replace("Chat", { kind: "group", sessionId: sid });
          }}
        />
      ) : null}

      {/* 深色模式下给导航条一道细线的底色：原生那条在深色底上几乎看不见 */}
      <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: 0.5, backgroundColor: withAlpha(c.foreground, 0.08) }} />
    </View>
  );
}
