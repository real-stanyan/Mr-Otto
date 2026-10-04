// 和朋友私聊（#1386，spec §5.7）：messages 表（0001），不是云会话——所以是另一张页，气泡、时刻、输入栏与智能体那几种
// 同一套样子。一次拉最近 50 条，往上翻再拉；realtime 推新消息，通道哑了降级成轮询（friendsStore）。
// 桌面发来的「分享会话」是一段 JSON 信封：画成一张卡（shareCardView：邀请码不上屏），手机上打不开会话包，只说去哪儿做。
// 删了好友的那个人：库里 RLS 不许再发（messages_insert_accepted_friend），输入栏换成一句实话。
// 图片与视频（#1443 P1）：＋ 里「相册」「拍摄」；挑好的先就地处理（prepareMedia），图片攒一条、视频一条一个，
// 每条先挂一个本地气泡报进度，传完换成真消息。纯媒体消息的正文是占位「[图片]」/「[视频]」，带着媒体时不画字。
// 带了智能体之后打一个 @ 弹选人（#1493）：名单只有我带进来的那几只（朋友不在里面——@ 朋友没有去处），
// 挑中了经 ref.mention 插回光标处，判据与群聊页同一份（agentMentionInput / MentionSheet）。
import { allowsPair } from "../../../src/shared/friendTier.js";
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppState, FlatList, Pressable, Text, View } from "react-native";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { chatRosterNow } from "../../../src/shared/chatRoster.js";
import type { SessionEvent } from "../../../src/session/events.js";
import { AUDIO_MAX_MS, mediaBodyHidden, planMediaMessages, type PreparedMedia } from "../../../src/shared/chatMedia.js";
import type { DirectMessage } from "../../../src/shared/friends.js";
import { laneItemsOf, lanePending, laneTargets, mergePairView, pairPresenceText, type LaneItem } from "../../../src/shared/pairChat.js";
import { PRESENCE_TEXT } from "../../../src/shared/presence.js";
import { agentNameOf } from "../../../src/shared/workspaceView.js";
import { chatSessionOf, closeChatIf, openChat, sendText, useChatStore } from "../cloud/chatStore.js";
import { PickAgentsDialog } from "../group/PickAgentsDialog.js";
import { bringAgents, loadPairLane, loadPairPresence, usePairLane, usePairPresence } from "./pairLane.js";
import { readUpTo, receiptLabel } from "../../../src/shared/readReceipt.js";
import { decodeEnvelope } from "../../../src/shared/sessionPackageCodec.js";
import { shareCardView } from "../../../src/shared/shareCard.js";
import { friendName, needsTimeRow, timelineTimeLabel } from "../../../src/shared/wechatInbox.js";
import { MentionSheet } from "../chat/MentionSheet.js";
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
  /** 我私密车道里的一行（#1461）：只有我看得到 */
  | { kind: "lane"; key: string; item: LaneItem };

/** 私密车道的一行（#1461 P1）：我对智能体说的话靠右、智能体的回复靠左，气泡描一圈虚线、底下一行「仅你可见」——
    它与人话混排在同一条时间线上，必须一眼分得出「这句朋友看不到」 */
function LaneBubble({ item, name, slot, meName, meAvatar }: { item: LaneItem; name: string; slot: number; meName: string; meAvatar: string }) {
  const { c } = usePalette();
  const mine = item.who === "me";
  return (
    <View style={{ flexDirection: mine ? "row-reverse" : "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 12 }}>
      {mine ? <PersonTile name={meName} url={meAvatar} size={40} me /> : <FaceTile slot={slot} size={40} />}
      <View style={{ flexShrink: 1, maxWidth: "76%", alignItems: mine ? "flex-end" : "flex-start", gap: 4 }}>
        {mine ? null : <Text style={{ fontSize: 12, color: c.mutedForeground }}>{name}</Text>}
        <View
          style={{
            paddingVertical: 9, paddingHorizontal: 12, borderRadius: 12, ...(mine ? { borderTopRightRadius: 4 } : { borderTopLeftRadius: 4 }),
            backgroundColor: withAlpha(c.brand, 0.06), borderWidth: 1, borderStyle: "dashed", borderColor: withAlpha(c.brand, 0.35),
          }}
        >
          <Text selectable style={{ fontSize: 16, lineHeight: 24, color: c.foreground }}>{item.text}</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          <Icon name="lock-keyhole" size={11} stroke={2} color={c.faint} />
          <Text style={{ fontSize: 11, color: c.faint }}>仅你可见</Text>
        </View>
      </View>
    </View>
  );
}

function Bubble({ m, mine, name, avatar, meName, meAvatar }: { m: DirectMessage; mine: boolean; name: string; avatar: string; meName: string; meAvatar: string }) {
  const { c } = usePalette();
  const env = decodeEnvelope(m.body);
  const body = env !== null ? (
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
      <View style={{ flexShrink: 1, maxWidth: "76%" }}>{body}</View>
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
  const createdGroup = useRef<string | null>(null);
  // 打 @ 弹选人（#1493）：挑中的名字先存着，等抽屉的 Modal 退场完再插——同 ChatScreen
  const composer = useRef<ComposerHandle>(null);
  const [mentioning, setMentioning] = useState(false);
  const pendingMention = useRef<string | null>(null);
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
        void openChat(homeId, laneSid, { kind: "pair", agentIds: [...lane.agentIds], humans: [], pair: { peerUid: uid, facing: "self" } });
      }
      // 只跟「是哪一条」走：名单变了不重连
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
  const laneItems = useMemo(() => [...laneItemsOf(laneEvents), ...lanePending(laneEvents, laneSession !== null ? chat.streaming : {})], [laneEvents, laneSession, chat.streaming]);
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
    void openChat(homeId, laneSid, { kind: "pair", agentIds: [...lane.agentIds], humans: [], pair: { peerUid: uid, facing: "self" } });
    // 只跟「是哪一条」与「此刻有没有连接」走：名单变了不重连
  }, [focused, homeId, laneSid, laneDropped, uid]);
  useEffect(() => {
    if (upTo !== null && friend && focused && active) markFriendRead(uid, upTo);
  }, [uid, upTo, friend, focused, active]);
  const peerRead = usePeerRead(uid);
  const selfUid = friends.uid ?? "";
  const receipt = useMemo(() => (thread === undefined ? null : receiptLabel(thread.messages, selfUid, peerRead)), [thread?.messages, selfUid, peerRead]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: name,
      // 名字底下一行在线状态（#1460）。对方从没报过时只有名字
      headerTitle: () => <FriendTitle uid={uid} name={name} />,
      headerRight: () => (
        <HeaderIconButton label="聊天信息" onPress={() => navigation.navigate("ChatInfo", { kind: "friend", uid })}>
          <Icon name="ellipsis" size={24} stroke={2} color={c.foreground} />
        </HeaderIconButton>
      ),
      ...(others > 0 ? { headerBackTitle: String(others), headerBackButtonDisplayMode: "default" as const } : { headerBackButtonDisplayMode: "minimal" as const }),
    });
  }, [navigation, name, uid, others, c.foreground]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    let prev: number | null = null;
    const now = Date.now();
    // 私聊 ∪ 我的私密车道，按服务器时间合成一条（shared/pairChat 的 mergePairView）
    for (const r of mergePairView(thread?.messages ?? [], laneItems)) {
      const ts = r.ts;
      const tkey = r.kind === "dm" ? `t${r.m.id}` : `t${r.item.key}`;
      if (ts !== Number.MAX_SAFE_INTEGER && needsTimeRow(prev, ts)) out.push({ kind: "time", key: tkey, label: timelineTimeLabel(ts, now) });
      if (ts !== Number.MAX_SAFE_INTEGER) prev = ts;
      out.push(r.kind === "dm" ? { kind: "msg", key: `m${r.m.id}`, m: r.m } : { kind: "lane", key: `l${r.item.key}`, item: r.item });
    }
    // 还没发出去的排在最底下（最新），按排队先后
    for (const p of thread?.pending ?? []) out.push({ kind: "pending", key: p.localId, p });
    return out.reverse();
  }, [thread?.messages, thread?.pending, laneItems]);

  const send = async (text: string): Promise<boolean> => {
    setNote(null);
    // @ 了我带进来的智能体 → 进私密车道（不写进 messages，朋友看不到）；否则照旧发给朋友
    const targets = laneTargets(text, broughtNames);
    if (targets !== null && laneSid !== null) {
      if (chatSessionOf(laneSid)?.state !== "ready") {
        setNote("私人智能体还没连上，稍等一下再发。");
        return false;
      }
      const r = await sendText(text, targets);
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
          // 我带进来的那几只（#1461）：点一下改名单。@ 它们说的话只有我看得到
          <Pressable
            accessibilityRole="button"
            onPress={() => setBringing({ key: Date.now(), visible: true })}
            style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingHorizontal: 16, backgroundColor: withAlpha(c.brand, 0.06) }, pressed && { opacity: 0.6 }]}
          >
            <Icon name="lock-keyhole" size={12} stroke={2} color={c.mutedForeground} />
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: c.mutedForeground }}>
              {`带着 ${broughtNames.map((a) => `@${a.name}`).join(" ")} · 只有你看得到${laneSession?.state === "ready" ? "" : laneSession === null && chat.session === null && chat.error !== null ? "（没连上，退出再进来试试）" : "（连接中）"}`}
            </Text>
            <Icon name="chevron-right" size={14} stroke={2} color={c.faint} />
          </Pressable>
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
                    name={homeWs !== null && item.item.agentId !== undefined ? agentNameOf(homeWs, item.item.agentId) : "智能体"}
                    slot={homeWs !== null && item.item.agentId !== undefined ? agentFaceSlot(homeWs, item.item.agentId) : 0}
                    meName={me.name}
                    meAvatar={me.avatar}
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
                    <Bubble m={item.m} mine={item.m.sender !== uid} name={name} avatar={row?.profile.avatarUrl ?? ""} meName={me.name} meAvatar={me.avatar} />
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
            {...(broughtNames.length > 0 ? { onAt: () => setMentioning(true) } : {})}
            plus={[
              // 图片 / 视频（#1443）：相册一次最多挑 9 样；拍摄是拍照或录一段（≤60 秒）
              { key: "album", icon: "image", label: "相册", onPress: () => void sendPicked(pickFromLibrary) },
              { key: "camera", icon: "camera", label: "拍摄", onPress: () => void sendPicked(pickFromCamera) },
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
                      if (rec !== null && rec.durationMs >= 1000 && laneTargets(trimmed, broughtNames) === null) {
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
      {homeWs !== null && broughtNames.length > 0 ? (
        <MentionSheet
          visible={mentioning}
          ws={homeWs}
          agentIds={broughtNames.map((a) => a.agentId)}
          humans={[]}
          footer={`@ 了它的那句只有你看得到，${name}收不到；不 @ 谁就是发给${name}。`}
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
          lead={`只有你看得到它们，${name}看不到。@ 它们说的话不会发给${name}；它们会读你们最近的聊天来帮你。`}
          options={homeWs.agents.map((a) => a.agentId)}
          preset={brought}
          min={laneSid === null ? 1 : 0}
          okLabel={laneSid === null ? "带上" : "好"}
          busy={bringBusy}
          error={bringError}
          onOk={(picked) => {
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
