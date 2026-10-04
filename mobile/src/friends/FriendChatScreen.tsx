// 和朋友私聊（#1386，spec §5.7）：messages 表（0001），不是云会话——所以是另一张页，气泡、时刻、输入栏与智能体那几种
// 同一套样子。一次拉最近 50 条，往上翻再拉；realtime 推新消息，通道哑了降级成轮询（friendsStore）。
// 桌面发来的「分享会话」是一段 JSON 信封：画成一张卡（shareCardView：邀请码不上屏），手机上打不开会话包，只说去哪儿做。
// 删了好友的那个人：库里 RLS 不许再发（messages_insert_accepted_friend），输入栏换成一句实话。
// 图片与视频（#1443 P1）：＋ 里「相册」「拍摄」；挑好的先就地处理（prepareMedia），图片攒一条、视频一条一个，
// 每条先挂一个本地气泡报进度，传完换成真消息。纯媒体消息的正文是占位「[图片]」/「[视频]」，带着媒体时不画字。
// 带了智能体之后打一个 @ 弹选人（#1493）：名单是我带进来的那几只 + 朋友公开给我的那几只（朋友不在里面——@ 朋友没有去处），
// 挑中了经 ref.mention 插回光标处，判据与群聊页同一份（agentMentionInput / MentionSheet）。
// 名片（#1524）：＋ 里「名片」挑我的智能体 / 别的朋友发给 TA；收到的卡画成 ContactCardBubble（加为朋友 / 发消息 / 接受）。
// 公开智能体（#1533）：标题栏电话钮 → 给本人（二期）/ 给 TA 的公开智能体（先替 TA 开车道、再把聊天页以客人身份开在那条上拨出去）；
// @ 名单里先列 TA 的公开智能体，车道还没有时第一次 @ 就开。
// @ 我主场里还没带进来的那只（#1544）：先带进车道再发——接受来的名片智能体不用先去 ＋ 里「带上」。
// 车道的朝向（#1523）：我带进来的可以「仅我可见」或「公开给 TA」（横幅上的那颗标签 / 聊天信息页能切）；
// 朋友公开给我的那条用第二条连接读（peerLane.ts），画成另一种底色的虚线气泡，@ 它说的话走朋友那条车道。
import { allowsPair } from "../../../src/shared/friendTier.js";
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppState, FlatList, Pressable, Text, View } from "react-native";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { chatHumansNow, chatRosterNow } from "../../../src/shared/chatRoster.js";
import type { SessionEvent } from "../../../src/session/events.js";
import { AUDIO_MAX_MS, mediaBodyHidden, planMediaMessages, type PreparedMedia } from "../../../src/shared/chatMedia.js";
import type { DirectMessage } from "../../../src/shared/friends.js";
import { LANE_FACING_LABEL, laneItemsOf, lanePending, laneTargets, mergePairView, pairFacingOf, pairPresenceText, type LaneItem, type PairFacing } from "../../../src/shared/pairChat.js";
import { PRESENCE_TEXT } from "../../../src/shared/presence.js";
import { agentNameOf } from "../../../src/shared/workspaceView.js";
import { chatSessionOf, closeChatIf, openChat, sendText, useChatStore } from "../cloud/chatStore.js";
import { PickAgentsDialog } from "../group/PickAgentsDialog.js";
import { bringAgents, loadPairLane, loadPairPresence, setLaneFacing, usePairLane, usePairPresence } from "./pairLane.js";
import { closePeerLane, ensurePeerLane, openPeerLane, sayToPeerLane, usePeerLane } from "./peerLane.js";
import { CallPickDialog } from "./CallPickDialog.js";
import { startHumanCall } from "../call/humanCall.js";
import { LaneFacingDialog } from "./LaneFacingDialog.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { readUpTo, receiptLabel } from "../../../src/shared/readReceipt.js";
import { decodeEnvelope } from "../../../src/shared/sessionPackageCodec.js";
import { CARD_TOO_BIG, decodeContactCard, encodeContactCard, type ContactCard } from "../../../src/shared/contactCard.js";
import { ContactCardBubble } from "./ContactCardBubble.js";
import { shareCardView } from "../../../src/shared/shareCard.js";
import { friendName, needsTimeRow, timelineTimeLabel } from "../../../src/shared/wechatInbox.js";
import { MentionSheet } from "../chat/MentionSheet.js";
import { DispatchDialog } from "../chat/DispatchDialog.js";
import { dispatchOpening, quoteWindow, type QuoteLine } from "../../../src/shared/dispatchQuote.js";
import { mediaPlaceholder } from "../../../src/shared/chatMedia.js";
import { WxComposer, type ComposerHandle, type HoldState } from "../chat/WxComposer.js";
import { NewGroupDialog } from "../group/NewGroupDialog.js";
import { useHome } from "../home/homeStore.js";
import { markSeen, setOpenKey } from "../inbox/seenStore.js";
import { useInbox } from "../inbox/useInbox.js";
import { MediaBubble, PendingMediaBubble } from "../media/MediaBubble.js";
import { pickFromCamera, pickFromLibrary, pickedKind, prepareAsset, type PickedAsset } from "../media/prepareMedia.js";
import type { RootStackParams } from "../nav/types.js";
import { useMyName } from "../tabs/MeScreen.js";
import { usePalette, withAlpha } from "../theme.js";
import { Spinner, useKeyboardInset } from "../ui.js";
import { dictationUsable, startDictation, startVoiceRecording, stopDictation, stopVoiceRecording, useVoice } from "../voice/voiceStore.js";
import { FaceTile, PersonTile } from "../wx/Avatar.js";
import { Icon } from "../wx/Icon.js";
import { HeaderIconButton } from "../wx/TabHeader.js";
import { toast } from "../wx/toast.js";
import {
  dropMediaSend, loadOlderThread, openThread, retryMediaSend, sendMediaToFriend, sendToFriend, useFriends, type PendingMedia,
} from "./friendsStore.js";
import { usePresence } from "./presenceStore.js";
import { loadPeerRead, markFriendRead, usePeerRead } from "./readReceipts.js";

type Props = NativeStackScreenProps<RootStackParams, "FriendChat">;
type Item =
  | { kind: "time"; key: string; label: string }
  | { kind: "msg"; key: string; m: DirectMessage }
  | { kind: "pending"; key: string; p: PendingMedia }
  /** 车道里的一行（#1461）：我的车道，或朋友公开给我的那条（`peer`，#1523） */
  | { kind: "lane"; key: string; item: LaneRow };

/** 车道的一行 + 它来自哪条车道（#1523）。两条车道的行合在同一条时间线上，画法不同 */
type LaneRow = LaneItem & { peer: boolean };

/** 车道的一行（#1461 P1；#1523 多了朋友说的与朋友的车道）：我说的靠右、智能体与朋友说的靠左，气泡描一圈虚线、
    底下一行说这句谁看得到——它与人话混排在同一条时间线上，必须一眼分得出「这句朋友看不看得到」。
    朋友公开给我的那条（peer）底色用朋友气泡那一色，与我自己的车道分得开 */
function LaneBubble({ item, name, slot, meName, meAvatar, friendName: fname, friendAvatar, footer, peer }: {
  item: LaneItem; name: string; slot: number; meName: string; meAvatar: string; friendName: string; friendAvatar: string;
  /** 底下那一行：仅你可见 / 你和 TA 都看得到 / TA 的智能体 · 两人都看得到 */
  footer: string;
  peer: boolean;
}) {
  const { c } = usePalette();
  const mine = item.who === "me";
  const tint = peer ? c.foreground : c.brand;
  return (
    <View style={{ flexDirection: mine ? "row-reverse" : "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 12 }}>
      {mine ? <PersonTile name={meName} url={meAvatar} size={40} me /> : item.who === "friend" ? <PersonTile name={fname} url={friendAvatar} size={40} /> : <FaceTile slot={slot} size={40} />}
      <View style={{ flexShrink: 1, maxWidth: "76%", alignItems: mine ? "flex-end" : "flex-start", gap: 4 }}>
        {mine ? null : <Text style={{ fontSize: 12, color: c.mutedForeground }}>{item.who === "friend" ? fname : name}</Text>}
        <View
          style={{
            paddingVertical: 9, paddingHorizontal: 12, borderRadius: 12, ...(mine ? { borderTopRightRadius: 4 } : { borderTopLeftRadius: 4 }),
            backgroundColor: withAlpha(tint, 0.06), borderWidth: 1, borderStyle: "dashed", borderColor: withAlpha(tint, 0.35),
          }}
        >
          <Text selectable style={{ fontSize: 16, lineHeight: 24, color: c.foreground }}>{item.text}</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          <Icon name={peer || footer !== "仅你可见" ? "users-round" : "lock-keyhole"} size={11} stroke={2} color={c.faint} />
          <Text style={{ fontSize: 11, color: c.faint }}>{footer}</Text>
        </View>
      </View>
    </View>
  );
}

function Bubble({ m, mine, name, avatar, meName, meAvatar, onLongPress, onOpenChat }: { m: DirectMessage; mine: boolean; name: string; avatar: string; meName: string; meAvatar: string; onLongPress?: () => void; onOpenChat: (uid: string) => void }) {
  const { c } = usePalette();
  const env = decodeEnvelope(m.body);
  // 名片（#1524）：整段 body 是一张卡；认不出才往下走分享信封 / 正文
  const card = decodeContactCard(m.body);
  const body = card !== null ? (
    <ContactCardBubble card={card} mine={mine} fromName={name} onOpenChat={onOpenChat} />
  ) : env !== null ? (
    (() => {
      const v = shareCardView(env, { mine, fromName: name });
      return (
        <View style={{ padding: 12, borderRadius: 12, backgroundColor: c.card, borderWidth: 0.5, borderColor: c.border, gap: 4, maxWidth: 260 }}>
          <Text style={{ fontSize: 13, color: c.mutedForeground }}>{v.heading}</Text>
          {v.title !== null ? <Text style={{ fontSize: 16, fontWeight: "600", color: c.foreground }}>{`《${v.title}》`}</Text> : null}
          {v.message !== null ? <Text style={{ fontSize: 14, color: c.foreground }}>{v.message}</Text> : null}
          <Text style={{ fontSize: 12, color: c.faint }}>{v.meta}</Text>
          {v.grant !== null ? <Text style={{ fontSize: 13, color: c.mutedForeground }}>{v.grant}</Text> : null}
          <Text style={{ fontSize: 12, color: c.mutedForeground, marginTop: 2 }}>{v.hint}</Text>
        </View>
      );
    })()
  ) : (
    <View style={{ gap: 6, alignItems: mine ? "flex-end" : "flex-start" }}>
      {m.media !== undefined ? <MediaBubble media={m.media} mine={mine} /> : null}
      {mediaBodyHidden(m.body, m.media ?? null) ? null : (
        <View style={{ paddingVertical: 9, paddingHorizontal: 12, borderRadius: 12, ...(mine ? { borderTopRightRadius: 4 } : { borderTopLeftRadius: 4 }), backgroundColor: mine ? c.bubbleMe : c.bubbleThem }}>
          <Text selectable style={{ fontSize: 16, lineHeight: 24, color: c.foreground }}>{m.body}</Text>
        </View>
      )}
    </View>
  );
  return (
    <View style={{ flexDirection: mine ? "row-reverse" : "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 12 }}>
      {mine ? <PersonTile name={meName} url={meAvatar} size={40} me /> : <PersonTile name={name} url={avatar} size={40} />}
      <Pressable disabled={onLongPress === undefined} onLongPress={onLongPress} delayLongPress={350} style={({ pressed }) => [{ flexShrink: 1, maxWidth: "76%" }, pressed && onLongPress !== undefined && { opacity: 0.85 }]}>{body}</Pressable>
    </View>
  );
}

const EMPTY_LANE: readonly SessionEvent[] = [];

function FriendTitle({ uid, name }: { uid: string; name: string }) {
  const { c } = usePalette();
  const presence = usePresence(uid);
  return (
    <View style={{ alignItems: "center" }}>
      <Text numberOfLines={1} style={{ fontSize: 17, fontWeight: "600", color: c.foreground }}>{name}</Text>
      {presence !== null ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: presence === "online" ? c.ok : c.destructive }} />
          <Text style={{ fontSize: 11, color: c.mutedForeground }}>{PRESENCE_TEXT[presence]}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function FriendChatScreen({ route, navigation }: Props) {
  const { uid } = route.params;
  const { c } = usePalette();
  const friends = useFriends();
  const inbox = useInbox();
  const me = useMyName();
  const voice = useVoice();
  // 键盘让位自己量(#1490):不再靠 KAV + useHeaderHeight,见 ui.tsx 的 useKeyboardInset
  const kb = useKeyboardInset(() => {});
  const [note, setNote] = useState<string | null>(null);
  const [hold, setHold] = useState<HoldState>({ phase: "idle" });
  const [holdText, setHoldText] = useState("");
  const home = useHome();
  const [grouping, setGrouping] = useState<{ key: number; visible: boolean } | null>(null);
  // 名片（#1524）：＋ 里「名片」挑我的智能体 / 别的朋友，每挑一张发一条
  const [carding, setCarding] = useState<{ key: number; visible: boolean } | null>(null);
  const [cardBusy, setCardBusy] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const createdGroup = useRef<string | null>(null);
  // 打 @ 弹选人（#1493）：挑中的名字先存着，等抽屉的 Modal 退场完再插——同 ChatScreen
  const composer = useRef<ComposerHandle>(null);
  const [mentioning, setMentioning] = useState(false);
  const pendingMention = useRef<string | null>(null);
  // 长按一句话派智能体（#1505）：只在好友权限到「可带智能体」时给（让我的智能体读你们的话，和带它进私聊是同一件事）
  const [dispatching, setDispatching] = useState<{ key: number; visible: boolean; m: DirectMessage } | null>(null);
  const row = friends.rows?.find((r) => r.profile.id === uid) ?? null;
  const name = row !== null ? friendName(row.profile) : "";
  const friend = row?.status === "accepted";
  const thread = friends.threads.get(uid);
  const key = `f:${uid}`;
  const others = inbox.unreadChats;

  // ── 私密车道（#1461 P1）：我带进这条私聊的智能体，只有我看得到、只听我的 ───────────────
  const homeWs = home.home;
  const homeId = homeWs?.id ?? null;
  const lane = usePairLane(uid);
  const laneSid = lane.status === "ready" ? lane.sessionId : null;
  const presence = usePairPresence(uid);
  const chat = useChatStore();
  const [bringing, setBringing] = useState<{ key: number; visible: boolean } | null>(null);
  const [bringBusy, setBringBusy] = useState(false);
  const [bringError, setBringError] = useState<string | null>(null);
  // 朝向（#1523）：第一次带上时挑好的那几只先存着、再问给谁看（create）；之后横幅上那颗标签直接切（edit）
  const [facingPick, setFacingPick] = useState<{ key: number; visible: boolean; mode: "create" | "edit"; picked: string[] } | null>(null);
  const [facingBusy, setFacingBusy] = useState(false);
  const [facingError, setFacingError] = useState<string | null>(null);
  // 朋友公开给我的那条车道（#1523）：第二条连接，进这一页 / 回到这一页时找一次，离开时断掉
  const peer = usePeerLane(uid);
  useFocusEffect(
    useCallback(() => {
      if (friend) void openPeerLane(uid, { name, avatarUrl: row?.profile.avatarUrl ?? "" });
      // 名字 / 头像只是快照，变了不重连
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [uid, friend]),
  );
  // 电话钮（#1533）：给本人（二期）/ 给 TA 的公开智能体——后者把聊天页以客人身份开在 TA 那条车道上、房间一好就拨
  const [calling, setCalling] = useState<{ key: number; visible: boolean } | null>(null);
  const [callBusy, setCallBusy] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const publicAgent = peer?.publicAgent ?? null;
  useEffect(() => () => closePeerLane(), []);
  useEffect(() => {
    if (homeId !== null && friend) void loadPairLane(homeId, uid);
  }, [homeId, uid, friend]);
  // 朋友带没带私人智能体：只给一个数，进来时、回到这一页时各问一次
  useFocusEffect(
    useCallback(() => {
      if (friend) void loadPairPresence(uid);
    }, [uid, friend]),
  );
  // 连上车道。手机同一时刻只连得上一条云会话：回到这一页时连接可能被别的页面拿走了，再进一次房
  useFocusEffect(
    useCallback(() => {
      if (homeId === null || laneSid === null) return;
      if (chatSessionOf(laneSid) === null) {
        void openChat(homeId, laneSid, { kind: "pair", agentIds: [...lane.agentIds], humans: [], pair: { peerUid: uid, facing: lane.facing } });
      }
      // 只跟「是哪一条」走：名单 / 朝向变了不重连
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [homeId, laneSid, uid]),
  );
  // 离开这一页才关，而且只在连接此刻还归这条车道时才关（closeChatIf）：私聊里拉人建群会 replace 成群聊页，
  // 那一页正在接手这条连接
  const laneRef = useRef<string | null>(null);
  laneRef.current = laneSid;
  useEffect(() => () => {
    if (laneRef.current !== null) closeChatIf(laneRef.current);
  }, []);
  const laneSession = laneSid !== null && chat.session?.sessionId === laneSid ? chat.session : null;
  const laneEvents = laneSession?.events ?? EMPTY_LANE;
  // 名单：连上之后以日志为准（chatRosterNow），没连上之前退回清单那一份
  const brought = useMemo<string[]>(() => {
    const fallback = laneSession?.chat?.agentIds ?? lane.agentIds;
    return [...(chatRosterNow(laneSession?.provisional === true ? EMPTY_LANE : laneEvents, fallback) ?? fallback)];
  }, [laneSession, laneEvents, lane.agentIds]);
  const broughtNames = useMemo(
    () => (homeWs === null ? [] : brought.filter((id) => homeWs.agents.some((a) => a.agentId === id)).map((id) => ({ agentId: id, name: agentNameOf(homeWs, id) }))),
    [homeWs, brought],
  );
  const selfUid = friends.uid ?? "";
  // 我的车道的朝向（#1523）：连上之后以日志里的客人名单为准（朋友在里面 = 公开），没连上之前退回清单那一列
  const laneFacing: PairFacing = laneSession !== null
    ? pairFacingOf(chatHumansNow(laneSession.provisional === true ? EMPTY_LANE : laneEvents, laneSession.chat?.humans ?? []), uid)
    : lane.facing;
  const laneItems = useMemo<LaneRow[]>(
    () => [...laneItemsOf(laneEvents, selfUid), ...lanePending(laneEvents, laneSession !== null ? chat.streaming : {})].map((item) => ({ ...item, peer: false })),
    [laneEvents, laneSession, chat.streaming, selfUid],
  );
  // 朋友公开给我的那条（#1523）：名单以日志为准，名字从 guest_chat_agents 那份表拿
  const peerEvents = peer?.session?.events ?? EMPTY_LANE;
  const peerAgentIds = useMemo<string[]>(() => {
    if (peer === null || peer.session === null) return [];
    const fallback = peer.session.chat?.agentIds ?? [];
    return [...(chatRosterNow(peerEvents, fallback) ?? fallback)];
  }, [peer, peerEvents]);
  const peerNames = useMemo(() => {
    if (peer === null) return [];
    const inLane = peerAgentIds.filter((id) => peer.agents.some((a) => a.agentId === id)).map((id) => ({ agentId: id, name: peer.agents.find((a) => a.agentId === id)?.name ?? id }));
    // 车道还没有 / 公开智能体还没进名单（#1533）：@ 名单里先列它，第一次 @ 时再替 TA 开车道
    if (peer.publicAgent !== null && !inLane.some((a) => a.agentId === peer.publicAgent!.agentId)) inLane.push({ agentId: peer.publicAgent.agentId, name: peer.publicAgent.name });
    return inLane;
  }, [peer, peerAgentIds]);
  const peerItems = useMemo<LaneRow[]>(
    () => (peer === null || peer.session === null ? [] : [...laneItemsOf(peerEvents, selfUid), ...lanePending(peerEvents, peer.streaming)].map((item) => ({ ...item, peer: true }))),
    [peer, peerEvents, selfUid],
  );
  // @ 选人与画脸要一份快照：我的主场 + 朋友公开给我的那几只（只有名字 / 职责 / 头像，0043 的 RPC 给的）
  const mentionWs = useMemo<WorkspaceSnapshot | null>(() => {
    const theirs = peer === null ? [] : [...peer.agents];
    // 公开智能体（#1533）还没进车道名单时也要画得出脸 / 名字：RPC 给的几格拼一行
    if (peer?.publicAgent && !theirs.some((a) => a.agentId === peer.publicAgent!.agentId)) {
      const p = peer.publicAgent;
      theirs.push({ agentId: p.agentId, name: p.name, description: p.description, instructions: "", models: [], tools: [], createdBy: uid, updatedTs: 0, avatarSlot: p.avatarSlot });
    }
    if (homeWs === null) return theirs.length > 0 ? { id: peer?.session?.workspaceId ?? "", name: "", ownerUid: uid, members: [], connectors: [], sessions: [], agents: theirs, sandboxApproval: null, kind: "home" } : null;
    return theirs.length === 0 ? homeWs : { ...homeWs, agents: [...homeWs.agents, ...theirs.filter((a) => !homeWs.agents.some((b) => b.agentId === a.agentId))] };
  }, [homeWs, peer, uid]);
  const presenceText = pairPresenceText(presence);

  useEffect(() => {
    void openThread(uid);
  }, [uid]);
  useFocusEffect(
    useCallback(() => {
      setOpenKey(key);
      return () => {
        setOpenKey(null);
        markSeen(key, Date.now());
      };
    }, [key]),
  );
  const last = thread?.messages[thread.messages.length - 1];
  useEffect(() => {
    if (last !== undefined) markSeen(key, Date.parse(last.createdAt) || Date.now());
  }, [key, last]);
  // 已读回执（#1442）：对方读到哪了进来时拉一次（之后 realtime 推）；我读到哪了，这一页一拉下来、来了新的都报一次
  useEffect(() => {
    void loadPeerRead(uid);
  }, [uid]);
  const loaded = thread !== undefined && !thread.loading;
  const upTo = loaded ? readUpTo(thread.messages, uid) : null;
  // 只在人真看着的时候报：页面在栈顶（聊天信息页叠上来时它还挂着）且 App 在前台（后台时 realtime 可能还在送）
  const focused = useIsFocused();
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => setActive(st === "active"));
    return () => sub.remove();
  }, []);
  // 车道连接没了、这一页又在前台：自己接回来（#1461 车道卡在「连接中」）。上面的 useFocusEffect 只在「进这一页 /
  // 回到这一页」那一下跑，页面一直在前台时连接被别处断掉（例：刚退出来的那一页卸载得晚、在这之后才断连接），
  // 它不会再跑，横幅就永远停在「连接中」。只在**谁都没占着**时接：别的页面正开着另一条是正当的接手，不抢；
  // 上一次进房失败（error）也不接，免得连不上时一圈一圈地重试——横幅照实说没连上，回到这一页时再试
  const laneDropped = chat.session === null && chat.error === null;
  useEffect(() => {
    if (!focused || homeId === null || laneSid === null || !laneDropped) return;
    void openChat(homeId, laneSid, { kind: "pair", agentIds: [...lane.agentIds], humans: [], pair: { peerUid: uid, facing: lane.facing } });
    // 只跟「是哪一条」与「此刻有没有连接」走：名单 / 朝向变了不重连
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, homeId, laneSid, laneDropped, uid]);
  useEffect(() => {
    if (upTo !== null && friend && focused && active) markFriendRead(uid, upTo);
  }, [uid, upTo, friend, focused, active]);
  const peerRead = usePeerRead(uid);
  const receipt = useMemo(() => (thread === undefined ? null : receiptLabel(thread.messages, selfUid, peerRead)), [thread?.messages, selfUid, peerRead]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: name,
      // 名字底下一行在线状态（#1460）。对方从没报过时只有名字
      headerTitle: () => <FriendTitle uid={uid} name={name} />,
      headerRight: () => (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          {friend ? (
            // 打电话（#1533）：给本人（二期）/ 给 TA 的公开智能体
            <HeaderIconButton label="打电话" onPress={() => { setCallError(null); setCalling({ key: Date.now(), visible: true }); }}>
              <Icon name="phone" size={22} stroke={2} color={c.foreground} />
            </HeaderIconButton>
          ) : null}
          <HeaderIconButton label="聊天信息" onPress={() => navigation.navigate("ChatInfo", { kind: "friend", uid })}>
            <Icon name="ellipsis" size={24} stroke={2} color={c.foreground} />
          </HeaderIconButton>
        </View>
      ),
      ...(others > 0 ? { headerBackTitle: String(others), headerBackButtonDisplayMode: "default" as const } : { headerBackButtonDisplayMode: "minimal" as const }),
    });
  }, [navigation, name, uid, others, c.foreground, friend]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    let prev: number | null = null;
    const now = Date.now();
    // 私聊 ∪ 我的车道 ∪ 朋友公开给我的车道，按服务器时间合成一条（shared/pairChat 的 mergePairView）
    for (const r of mergePairView(thread?.messages ?? [], [...laneItems, ...peerItems])) {
      const ts = r.ts;
      const tkey = r.kind === "dm" ? `t${r.m.id}` : `t${r.item.peer ? "p" : ""}${r.item.key}`;
      if (ts !== Number.MAX_SAFE_INTEGER && needsTimeRow(prev, ts)) out.push({ kind: "time", key: tkey, label: timelineTimeLabel(ts, now) });
      if (ts !== Number.MAX_SAFE_INTEGER) prev = ts;
      out.push(r.kind === "dm" ? { kind: "msg", key: `m${r.m.id}`, m: r.m } : { kind: "lane", key: `l${r.item.peer ? "p" : ""}${r.item.key}`, item: r.item });
    }
    // 还没发出去的排在最底下（最新），按排队先后
    for (const p of thread?.pending ?? []) out.push({ kind: "pending", key: p.localId, p });
    return out.reverse();
  }, [thread?.messages, thread?.pending, laneItems, peerItems]);

  /** 这句话 @ 了哪条车道里的谁（#1523）：先看我带进来的，再看朋友公开给我的；都没有 = 发给朋友 */
  // 我主场里还没带进来的那几只（#1544）：@ 名单里也列它们，@ 了就先带进车道再发——接受来的名片智能体、刚建的那只，不用先去 ＋ 里「带上」
  const otherMine = useMemo(
    () => (homeWs === null ? [] : homeWs.agents.filter((a) => !brought.includes(a.agentId)).map((a) => ({ agentId: a.agentId, name: a.name }))),
    [homeWs, brought],
  );
  const laneTargetsOf = (text: string): { lane: "mine" | "peer" | "bring"; ids: string[] } | null => {
    const mine = laneTargets(text, broughtNames);
    if (mine !== null) return { lane: "mine", ids: mine };
    const theirs = laneTargets(text, peerNames);
    if (theirs !== null) return { lane: "peer", ids: theirs };
    const unbrought = laneTargets(text, otherMine);
    return unbrought !== null ? { lane: "bring", ids: unbrought } : null;
  };
  /** 等车道连上（带进来那一下 openChat 是异步的）：最多等 8 秒 */
  const waitLaneReady = async (sid: string): Promise<boolean> => {
    for (let i = 0; i < 40; i++) {
      if (chatSessionOf(sid)?.state === "ready") return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  };
  const send = async (text: string): Promise<boolean> => {
    setNote(null);
    // @ 了我带进来的智能体 → 进我的车道（不写进 messages）；@ 了朋友公开给我的 → 进朋友那条（第二条连接）；否则照旧发给朋友
    const targets = laneTargetsOf(text);
    if (targets !== null && targets.lane === "peer") {
      if (peer?.session === null || peer?.session === undefined) {
        // 第一次 @ TA 的公开智能体（#1533）：先替 TA 开车道（runtime 核对朋友关系 / 档位 / 设了哪只）
        const opened = await ensurePeerLane(uid);
        if (!opened.ok) {
          setNote(opened.message);
          return false;
        }
      } else if (peer.session.state !== "ready") {
        setNote(`${name}的智能体还没连上，稍等一下再发。`);
        return false;
      }
      const r = await sayToPeerLane(text, targets.ids);
      if (r.ok) return true;
      if (r.unknown) {
        setNote(`这句话不确定有没有交给${name}的智能体，没看到回复的话再说一遍。`);
        return true;
      }
      setNote(r.message);
      return false;
    }
    if (targets !== null && targets.lane === "bring") {
      // @ 了还没带进来的那只（#1544）：先带进车道（沿用此刻的朝向；没有车道就建一条），连上了再发
      if (homeWs === null) return false;
      const b = await bringAgents(homeWs.id, uid, [...brought, ...targets.ids], laneFacing);
      if (!b.ok) {
        setNote(b.message);
        return false;
      }
      if (!(await waitLaneReady(b.sessionId))) {
        setNote("已经带进来了，车道还没连上，稍等一下再发。");
        return false;
      }
      const r = await sendText(text, targets.ids);
      if (r.ok) return true;
      if (r.unknown) {
        setNote("这句话不确定有没有交给私人智能体，没看到回复的话再说一遍。");
        return true;
      }
      setNote(r.message);
      return false;
    }
    if (targets !== null && laneSid !== null) {
      if (chatSessionOf(laneSid)?.state !== "ready") {
        setNote("私人智能体还没连上，稍等一下再发。");
        return false;
      }
      const r = await sendText(text, targets.ids);
      if (r.ok) return true;
      if (r.unknown) {
        setNote("这句话不确定有没有交给私人智能体，没看到回复的话再说一遍。");
        return true;
      }
      setNote(r.message);
      return false;
    }
    try {
      await sendToFriend(uid, text);
      return true;
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  // 挑好的就地处理：HEIC 转 JPEG、原图缩到 2048、视频查时长大小抽封面。一样处理不了只说那一样，别的照发
  const [preparing, setPreparing] = useState(false);
  const sendPicked = async (pick: () => Promise<PickedAsset[]>): Promise<void> => {
    setNote(null);
    let assets: PickedAsset[];
    try {
      assets = await pick();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
      return;
    }
    if (assets.length === 0) return;
    setPreparing(true);
    const ready: PreparedMedia[] = [];
    const problems: string[] = [];
    for (const a of assets) {
      try {
        ready.push(await prepareAsset(a));
      } catch (e) {
        problems.push(`${pickedKind(a) === "video" ? "视频" : "图片"}：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setPreparing(false);
    for (const group of planMediaMessages(ready)) sendMediaToFriend(uid, group);
    if (problems.length > 0) setNote(problems.length === 1 ? (problems[0] ?? "") : `有 ${problems.length} 样没发：${problems[0] ?? ""}`);
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View ref={kb.root.ref} onLayout={kb.root.onLayout} style={{ flex: 1, paddingBottom: kb.keyboard }}>
        {presenceText !== null ? (
          // 朋友带了私人智能体（#1461）：只说有几只，内容我看不到
          <Text style={{ fontSize: 12, color: c.mutedForeground, textAlign: "center", paddingVertical: 6, backgroundColor: c.side }}>{presenceText}</Text>
        ) : null}
        {broughtNames.length > 0 ? (
          // 我带进来的那几只（#1461）：点一下改名单；右边那颗标签是朝向（#1523），点一下切「仅我可见 / 公开给 TA」
          <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: withAlpha(c.brand, 0.06) }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setBringing({ key: Date.now(), visible: true })}
              style={({ pressed }) => [{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingLeft: 16, paddingRight: 8 }, pressed && { opacity: 0.6 }]}
            >
              <Icon name={laneFacing === "both" ? "users-round" : "lock-keyhole"} size={12} stroke={2} color={c.mutedForeground} />
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: c.mutedForeground }}>
                {`带着 ${broughtNames.map((a) => `@${a.name}`).join(" ")}${laneSession?.state === "ready" ? "" : laneSession === null && chat.session === null && chat.error !== null ? "（没连上，退出再进来试试）" : "（连接中）"}`}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="带进来的智能体给谁看"
              onPress={() => { setFacingError(null); setFacingPick({ key: Date.now(), visible: true, mode: "edit", picked: [] }); }}
              style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 6, paddingLeft: 8, paddingRight: 16 }, pressed && { opacity: 0.6 }]}
            >
              <Text style={{ fontSize: 12, color: c.brand }}>{LANE_FACING_LABEL[laneFacing]}</Text>
              <Icon name="chevron-right" size={14} stroke={2} color={c.faint} />
            </Pressable>
          </View>
        ) : null}
        {peerNames.length > 0 ? (
          // 朋友公开给我的那几只（#1523）：只读一行，@ 它们说的话走朋友那条车道、TA 那边每一步都要 TA 批
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingHorizontal: 16, backgroundColor: withAlpha(c.foreground, 0.04) }}>
            <Icon name="users-round" size={12} stroke={2} color={c.mutedForeground} />
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: c.mutedForeground }}>
              {`${name}带着 ${peerNames.map((a) => `@${a.name}`).join(" ")} · 你也能 @${peer?.session?.state === "ready" ? "" : "（连接中）"}`}
            </Text>
          </View>
        ) : null}
        <View style={{ flex: 1 }}>
          {thread === undefined || thread.loading ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Spinner /></View>
          ) : items.length === 0 ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8 }}>
              {row !== null ? <PersonTile name={name} url={row.profile.avatarUrl} size={64} /> : null}
              <Text style={{ fontSize: 14, color: c.mutedForeground }}>{friend ? "说第一句话吧。" : ""}</Text>
            </View>
          ) : (
            <FlatList
              inverted
              // 不满一屏时贴顶（#1424）：inverted 翻转了上下，内容坐标的「尾」是屏幕上的「顶」，
              // 同 chat/ChatScreen.tsx 那一处
              contentContainerStyle={{ flexGrow: 1, justifyContent: "flex-end", paddingBottom: 8 }}
              data={items}
              keyExtractor={(it) => it.key}
              renderItem={({ item }) =>
                item.kind === "time" ? (
                  <Text style={{ alignSelf: "center", fontSize: 11.5, color: c.faint, fontVariant: ["tabular-nums"] }}>{item.label}</Text>
                ) : item.kind === "lane" ? (
                  <LaneBubble
                    item={item.item}
                    name={mentionWs !== null && item.item.agentId !== undefined ? agentNameOf(mentionWs, item.item.agentId) : "智能体"}
                    slot={mentionWs !== null && item.item.agentId !== undefined ? agentFaceSlot(mentionWs, item.item.agentId) : 0}
                    meName={me.name}
                    meAvatar={me.avatar}
                    friendName={name}
                    friendAvatar={row?.profile.avatarUrl ?? ""}
                    footer={item.item.peer ? `${name}的智能体 · 两人都看得到` : laneFacing === "both" ? "你和 TA 都看得到" : "仅你可见"}
                    peer={item.item.peer}
                  />
                ) : item.kind === "pending" ? (
                  <View style={{ flexDirection: "row-reverse", alignItems: "flex-start", gap: 10, paddingHorizontal: 12 }}>
                    <PersonTile name={me.name} url={me.avatar} size={40} me />
                    <View style={{ flexShrink: 1, maxWidth: "76%" }}>
                      <PendingMediaBubble
                        items={item.p.items}
                        state={item.p.state}
                        progress={item.p.progress}
                        error={item.p.error}
                        onRetry={() => retryMediaSend(uid, item.p.localId)}
                        onDrop={() => dropMediaSend(uid, item.p.localId)}
                      />
                    </View>
                  </View>
                ) : (
                  <View>
                    <Bubble
                      m={item.m}
                      mine={item.m.sender !== uid}
                      name={name}
                      avatar={row?.profile.avatarUrl ?? ""}
                      meName={me.name}
                      meAvatar={me.avatar}
                      onOpenChat={(target) => navigation.push("FriendChat", { uid: target })}
                      {...(homeWs !== null && homeWs.agents.length > 0 && (row === null || allowsPair(row.tiers.effective))
                        ? { onLongPress: () => setDispatching({ key: Date.now(), visible: true, m: item.m }) }
                        : {})}
                    />
                    {receipt !== null && receipt.messageId === item.m.id ? (
                      <Text style={{ alignSelf: "flex-end", marginRight: 62, marginTop: 4, fontSize: 12, color: receipt.read ? c.faint : c.mutedForeground }}>
                        {receipt.read ? "已读" : "未读"}
                      </Text>
                    ) : null}
                  </View>
                )
              }
              ItemSeparatorComponent={() => <View style={{ height: 16 }} />}
              ListHeaderComponent={<View style={{ height: 14 }} />}
              ListFooterComponent={
                thread.hasOlder ? (
                  <View style={{ paddingVertical: 12, alignItems: "center" }}>
                    {thread.older === "failed" ? (
                      <Pressable accessibilityRole="button" onPress={() => void loadOlderThread(uid)} style={({ pressed }) => [pressed && { opacity: 0.6 }]}>
                        <Text style={{ fontSize: 13, color: c.mutedForeground }}>没读到更早的消息 · <Text style={{ color: c.brand }}>重试</Text></Text>
                      </Pressable>
                    ) : thread.older === "loading" ? <Spinner /> : null}
                  </View>
                ) : null
              }
              onEndReached={() => {
                if (thread.hasOlder && thread.older === "idle") void loadOlderThread(uid);
              }}
              onEndReachedThreshold={0.5}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
            />
          )}
          {hold.phase === "down" ? (
            <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: "30%", alignItems: "center" }}>
              <View style={{ width: 188, minHeight: 150, borderRadius: 20, padding: 16, backgroundColor: "rgba(20, 20, 22, 0.88)", alignItems: "center", justifyContent: "center", gap: 12 }}>
                <Icon name="mic" size={40} stroke={1.6} color={hold.cancel ? "rgba(255,255,255,0.4)" : "#5ac8fa"} />
                <Text numberOfLines={4} style={{ fontSize: 14, color: "#ffffff", textAlign: "center" }}>{holdText === "" ? "在听…" : holdText}</Text>
                <Text style={{ fontSize: 13, color: "#ffffff", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: hold.cancel ? c.destructive : "transparent" }}>
                  {hold.cancel ? "松开手指，取消发送" : "松开 发送 · 上划 取消"}
                </Text>
              </View>
            </View>
          ) : null}
        </View>
        {preparing ? (
          <Text style={{ fontSize: 13, color: c.mutedForeground, paddingHorizontal: 16, paddingBottom: 6 }}>正在准备图片和视频…</Text>
        ) : null}
        {note !== null || thread?.error ? (
          <Text style={{ fontSize: 13, color: c.destructive, paddingHorizontal: 16, paddingBottom: 6 }}>{note ?? `没拉到最新的消息（${thread?.error ?? ""}）`}</Text>
        ) : null}
        {friend ? (
          <WxComposer
            ref={composer}
            draftKey={key}
            placeholder=""
            canSend
            sessionId={null}
            onSend={send}
            {...(broughtNames.length > 0 || peerNames.length > 0 || otherMine.length > 0 ? { onAt: () => setMentioning(true) } : {})}
            plus={[
              // 图片 / 视频（#1443）：相册一次最多挑 9 样；拍摄是拍照或录一段（≤60 秒）
              { key: "album", icon: "image", label: "相册", onPress: () => void sendPicked(pickFromLibrary) },
              { key: "camera", icon: "camera", label: "拍摄", onPress: () => void sendPicked(pickFromCamera) },
              // 名片（#1524）：推一位朋友给 TA，或把我的一只智能体发给 TA（TA 接受就复制进 TA 的智能体库）
              { key: "card", icon: "user-round", label: "名片", onPress: () => { setCardError(null); setCarding({ key: Date.now(), visible: true }); } },
              // 拉人建群（#1393）：带上 TA，再拉几位——群建在我的主场里
              ...(home.home !== null
                ? [{ key: "group", icon: "users-round" as const, label: "拉人建群", onPress: () => setGrouping({ key: Date.now(), visible: true }) }]
                : []),
              // 带上我的智能体（#1461 P1）：住在我主场的私密车道里，朋友看不到；车道还读不到时不给（不劝人再带一次）
              // 好友权限（#1494）：两边取最小值到不了「可带智能体」就不给入口（服务端 pairCreateProblem 是真正的闸）
              ...(home.home !== null && (lane.status === "ready" || lane.status === "none") && (row === null || allowsPair(row.tiers.effective))
                ? [{ key: "bring", icon: "sparkles" as const, label: "带上我的智能体", onPress: () => setBringing({ key: Date.now(), visible: true }) }]
                : []),
            ]}
            {...(dictationUsable(voice)
              ? {
                hold: {
                  onDown: () => {
                    setHoldText("");
                    startDictation(setHoldText, (m) => setNote(m));
                    startVoiceRecording();
                  },
                  onChange: setHold,
                  onUp: (ok: boolean) => {
                    void (async () => {
                      const text = await stopDictation(ok);
                      const rec = await stopVoiceRecording(ok);
                      setHoldText("");
                      if (!ok) return;
                      const trimmed = text.trim();
                      // 语音消息（#1492，ADR-0351）：录到了就发语音条、转写随消息走；@ 了带进来的智能体那句仍发文字
                      // 给车道（智能体只收字，维护者拍板）；老原生包录不了（rec === null）退回发文字
                      if (rec !== null && rec.durationMs >= 1000 && laneTargetsOf(trimmed) === null) {
                        sendMediaToFriend(uid, [{
                          kind: "audio", uri: rec.uri, mediaType: "audio/mp4", bytes: rec.bytes, width: 0, height: 0,
                          durationMs: Math.min(rec.durationMs, AUDIO_MAX_MS), ...(trimmed !== "" ? { transcript: trimmed } : {}),
                        }]);
                        return;
                      }
                      if (trimmed === "") {
                        toast(rec !== null && rec.durationMs < 1000 ? "说话时间太短" : "没听清，按住再说一遍");
                        return;
                      }
                      await send(trimmed);
                    })();
                  },
                },
              }
              : {})}
          />
        ) : (
          <View style={{ padding: 16, paddingBottom: 32, backgroundColor: c.side, borderTopWidth: 0.5, borderTopColor: withAlpha(c.foreground, 0.12) }}>
            <Text style={{ fontSize: 14, color: c.mutedForeground, textAlign: "center" }}>
              {row === null ? "你们已经不是朋友了，发不了消息。" : "对方还没同意加你为朋友，发不了消息。"}
            </Text>
          </View>
        )}
      </View>
      {dispatching !== null && homeWs !== null ? (
        <DispatchDialog
          key={dispatching.key}
          visible={dispatching.visible}
          ws={homeWs}
          agentIds={homeWs.agents.map((a) => a.agentId)}
          preview={dispatching.m.body}
          onOk={(agentId, prompt) => {
            const lines: QuoteLine[] = (thread?.messages ?? []).map((m) => ({
              key: String(m.id),
              who: m.sender === uid ? name : me.name,
              text: m.media !== undefined && mediaBodyHidden(m.body, m.media) ? mediaPlaceholder(m.media) : m.body,
            }));
            const window = quoteWindow(lines, String(dispatching.m.id));
            setDispatching((d) => (d === null ? d : { ...d, visible: false }));
            if (window === null) return;
            navigation.push("Chat", { kind: "agent", agentId, dispatch: dispatchOpening({ prompt, source: `和${name}的私聊`, lines: window }) });
          }}
          onClose={() => setDispatching((d) => (d === null ? d : { ...d, visible: false }))}
          onExited={() => setDispatching(null)}
        />
      ) : null}
      {mentionWs !== null && (broughtNames.length > 0 || peerNames.length > 0 || otherMine.length > 0) ? (
        <MentionSheet
          visible={mentioning}
          ws={mentionWs}
          agentIds={[...broughtNames.map((a) => a.agentId), ...peerNames.map((a) => a.agentId), ...otherMine.map((a) => a.agentId)]}
          humans={[]}
          footer={laneFacing === "both" || peerNames.length > 0 ? `@ 了智能体的那句进它的车道，不 @ 谁就是发给${name}。` : `@ 了它的那句只有你看得到，${name}收不到；不 @ 谁就是发给${name}。`}
          onPick={(picked) => {
            pendingMention.current = picked;
            setMentioning(false);
          }}
          onClose={() => setMentioning(false)}
          onExited={() => {
            const picked = pendingMention.current;
            pendingMention.current = null;
            // 抽屉的 Modal 要等这一拍提交之后才真的收起：等一帧再插，不然输入框拿不到焦点
            if (picked !== null) requestAnimationFrame(() => composer.current?.mention(picked));
          }}
        />
      ) : null}
      {bringing !== null && homeWs !== null ? (
        <PickAgentsDialog
          key={bringing.key}
          visible={bringing.visible}
          ws={homeWs}
          title="带上我的智能体"
          lead={laneSid === null ? `挑几只带进和${name}的私聊，下一步选给谁看。它们会读你们最近的聊天来帮你。` : `@ 它们说的话进它们的车道；给谁看在横幅上那颗标签里改。`}
          options={homeWs.agents.map((a) => a.agentId)}
          preset={brought}
          min={laneSid === null ? 1 : 0}
          okLabel={laneSid === null ? "下一步" : "好"}
          busy={bringBusy}
          error={bringError}
          onOk={(picked) => {
            // 第一次带上（#1523）：先收起这张单子，再问朝向——建车道那一帧要带 facing
            if (laneSid === null) {
              setBringing((b) => (b === null ? b : { ...b, visible: false }));
              setFacingError(null);
              setFacingPick({ key: Date.now(), visible: true, mode: "create", picked });
              return;
            }
            void (async () => {
              setBringBusy(true);
              setBringError(null);
              const r = await bringAgents(homeWs.id, uid, picked);
              setBringBusy(false);
              if (!r.ok) {
                setBringError(r.message);
                return;
              }
              setBringing((b) => (b === null ? b : { ...b, visible: false }));
            })();
          }}
          onClose={() => setBringing((b) => (b === null ? b : { ...b, visible: false }))}
          onExited={() => {
            setBringing(null);
            setBringError(null);
          }}
        />
      ) : null}
      {calling !== null ? (
        <CallPickDialog
          key={calling.key}
          visible={calling.visible}
          friendName={name}
          agentName={publicAgent?.name ?? null}
          busy={callBusy}
          error={callError}
          onPerson={() => {
            // 人与人（#1534）：先进通话页再拨——runtime 推来电、回 ICE 清单，对方接起来就通
            setCalling((d) => (d === null ? d : { ...d, visible: false }));
            void startHumanCall(uid);
            navigation.push("HumanCall", { callId: "", friendUid: uid, incoming: false });
          }}
          onAgent={() => {
            if (publicAgent === null) return;
            void (async () => {
              setCallBusy(true);
              setCallError(null);
              const r = await ensurePeerLane(uid);
              setCallBusy(false);
              if (!r.ok) {
                setCallError(r.message);
                return;
              }
              setCalling((d) => (d === null ? d : { ...d, visible: false }));
              // 只拉公开的那一只进通话（#1550）：车道里可能还带着对方别的智能体
              navigation.push("Chat", { kind: "guest", workspaceId: r.workspaceId, sessionId: r.sessionId, autoCall: true, callAgentId: publicAgent.agentId });
            })();
          }}
          onClose={() => setCalling((d) => (d === null ? d : { ...d, visible: false }))}
          onExited={() => {
            setCalling(null);
            setCallError(null);
          }}
        />
      ) : null}
      {facingPick !== null && homeWs !== null ? (
        <LaneFacingDialog
          key={facingPick.key}
          visible={facingPick.visible}
          title="带进来的智能体给谁看"
          lead={facingPick.mode === "create" ? `带进和${name}的私聊。之后在横幅上那颗标签里随时改。` : `你带进和${name}私聊的智能体，给谁看。`}
          initial={facingPick.mode === "create" ? "self" : laneFacing}
          okLabel={facingPick.mode === "create" ? "带上" : "保存"}
          busy={facingBusy}
          error={facingError}
          onOk={(facing) => {
            void (async () => {
              setFacingBusy(true);
              setFacingError(null);
              const r = facingPick.mode === "create" ? await bringAgents(homeWs.id, uid, facingPick.picked, facing) : await setLaneFacing(homeWs.id, uid, facing);
              setFacingBusy(false);
              if (!r.ok) {
                setFacingError(r.message);
                return;
              }
              setFacingPick((f) => (f === null ? f : { ...f, visible: false }));
            })();
          }}
          onClose={() => setFacingPick((f) => (f === null ? f : { ...f, visible: false }))}
          onExited={() => {
            setFacingPick(null);
            setFacingError(null);
          }}
        />
      ) : null}
      {carding !== null ? (
        <PickAgentsDialog
          key={carding.key}
          visible={carding.visible}
          ws={homeWs ?? { id: "", name: "", ownerUid: "", members: [], connectors: [], sessions: [], agents: [], sandboxApproval: null, kind: "home" }}
          title="发名片"
          lead={`挑要发给${name}的：你的智能体（TA 接受就存进 TA 的智能体库），或别的朋友（TA 可以一键加好友）。`}
          options={homeWs?.agents.map((a) => a.agentId) ?? []}
          people={(friends.rows ?? []).filter((r) => r.status === "accepted" && r.profile.id !== uid).map((r) => ({ uid: r.profile.id, name: friendName(r.profile), url: r.profile.avatarUrl }))}
          peopleLabel="朋友"
          min={1}
          okLabel="发送"
          busy={cardBusy}
          error={cardError}
          onOk={(agentIds, _n, people) => {
            void (async () => {
              setCardBusy(true);
              setCardError(null);
              const cards: ContactCard[] = [];
              for (const id of agentIds) {
                const a = homeWs?.agents.find((x) => x.agentId === id);
                if (a === undefined) continue;
                cards.push({
                  kind: "agent", agentId: a.agentId, name: a.name, description: a.description, instructions: a.instructions, avatarSlot: a.avatarSlot,
                  ...(a.voice !== undefined ? { voice: a.voice } : {}), from: { uid: selfUid, name: me.name },
                });
              }
              for (const p of people) {
                const r = friends.rows?.find((x) => x.profile.id === p);
                if (r !== undefined) cards.push({ kind: "person", uid: r.profile.id, name: friendName(r.profile), avatarUrl: r.profile.avatarUrl, email: r.profile.email });
              }
              try {
                for (const card of cards) await sendToFriend(uid, encodeContactCard(card));
                setCarding((d) => (d === null ? d : { ...d, visible: false }));
              } catch (e) {
                setCardError(e instanceof Error ? (e.message === CARD_TOO_BIG ? CARD_TOO_BIG : e.message) : String(e));
              } finally {
                setCardBusy(false);
              }
            })();
          }}
          onClose={() => setCarding((d) => (d === null ? d : { ...d, visible: false }))}
          onExited={() => {
            setCarding(null);
            setCardError(null);
          }}
        />
      ) : null}
      {grouping !== null && home.home !== null ? (
        <NewGroupDialog
          key={grouping.key}
          visible={grouping.visible}
          ws={home.home}
          selfUid={home.selfUid ?? ""}
          title="拉人建群"
          lead={`带上${name}，再拉几位（你的智能体或朋友），凑够 2 位就能建。朋友让智能体动手要等你批。`}
          presetPeople={[uid]}
          onClose={() => setGrouping((g) => (g === null ? g : { ...g, visible: false }))}
          onCreated={(sid) => {
            createdGroup.current = sid;
            setGrouping((g) => (g === null ? g : { ...g, visible: false }));
          }}
          onExited={() => {
            setGrouping(null);
            const sid = createdGroup.current;
            createdGroup.current = null;
            // 换成那个新群（返回回到列表，不回到这条私聊），同智能体私聊里的「拉人建群」
            if (sid !== null && navigation.isFocused()) navigation.replace("Chat", { kind: "group", sessionId: sid });
          }}
        />
      ) : null}
    </View>
  );
}
