// 聊天页时间线的各行（#1386，照微信，demo 的 timelineHTML）：我在右、别人在左带头像（群里头像上方写名字）；
// 时刻、旁白、名单变更、派活线、接力线是居中的一枚灰底小条；通话：私聊是一个「通话时长」气泡，群里是一行居中
// 可点的小条，点开是全文。回电（#1411）：私聊里是它那一侧的一个通话记录气泡，群里是居中灰条，接通的与那场通话合成一条。画哪一种由 shared/mobileChat.ts 的 ChatRow 决定，这里只管样子。
//
// · 它一次回复拆成的几段（ADR-0266）头像只画在第一段旁边，后面几段对齐缩进：读成一口气说的，不是几次；
// · 脸只画名册里查得到的那只（agentFaceIfKnown）：派生对陌生 id 也算得出一张脸，画上去等于宣称它还在；
//   查不到的退成首字方块；
// · 气泡：我那边是点缀色 18% 调进纸面（不是整块蓝——蓝色一屏只给一个主动作），别人那边是 raised；
//   靠头像那一角收尖（4pt），照微信的「说话方向」。
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Easing, Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { agentFaceIfKnown } from "../../../src/shared/agentAvatar.js";
import { APP_CONNECT_BUTTON, appConnectTitle, type AppConnectAction } from "../../../src/shared/appConnect.js";
import { catalogIcon } from "../../../src/shared/appIcon.js";
import { AppTile } from "../machine/AppTile.js";
import type { RosterLinePart } from "../../../src/shared/cloudTimeline.js";
import { callOffsetText } from "../../../src/shared/cloudTimeline.js";
import { ringRecordView, type ChatRow } from "../../../src/shared/mobileChat.js";
import { parseDispatchOpening, type DispatchCardView } from "../../../src/shared/dispatchQuote.js";
import { TASK_STATUS_TEXT } from "../../../src/shared/tasks.js";
import { CHAT_MEDIA_BUCKET, mediaBodyHidden, type ChatMediaItem } from "../../../src/shared/chatMedia.js";
import { MediaBubble } from "../media/MediaBubble.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import type { FaceState } from "../../../src/shared/ottoFace/index.js";
import { memberAvatarOf } from "../../../src/shared/workspaceView.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { usePalette, withAlpha } from "../theme.js";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParams } from "../nav/types.js";
import { Button, useReduceMotion } from "../ui.js";
import { FaceTile, PersonTile, tileRadius } from "../wx/Avatar.js";
import { Icon } from "../wx/Icon.js";

export const AVATAR = 40;
const RADIUS = 12;

/** 居中那一枚灰底小条（demo 的 .tl-sys）：旁白、派活、接力、名单变更、拒了的审批 */
export function SysPill({ children, tone = "muted", onPress }: { children: React.ReactNode; tone?: "muted" | "error"; onPress?: () => void }) {
  const { c } = usePalette();
  const body = (
    <View style={{ maxWidth: "80%", alignSelf: "center", paddingVertical: 3, paddingHorizontal: 10, borderRadius: 6, backgroundColor: withAlpha(c.foreground, 0.05) }}>
      <Text style={{ fontSize: 12, lineHeight: 18, textAlign: "center", color: tone === "error" ? c.destructive : c.mutedForeground }}>{children}</Text>
    </View>
  );
  if (onPress === undefined) return body;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [pressed && { opacity: 0.6 }]}>
      {body}
    </Pressable>
  );
}

function Bubble({ text, mine, agent, first }: { text: string; mine: boolean; agent: boolean; first: boolean }) {
  const { c } = usePalette();
  return (
    <View
      style={{
        paddingVertical: 9, paddingHorizontal: 12, borderRadius: RADIUS,
        ...(first ? (mine ? { borderTopRightRadius: 4 } : { borderTopLeftRadius: 4 }) : {}),
        backgroundColor: mine ? c.bubbleMe : agent ? c.bubbleAgent : c.bubbleThem,
      }}
    >
      <Text selectable style={{ fontSize: 16, lineHeight: 24, color: c.foreground }}>{text}</Text>
    </View>
  );
}

/** 一句话一行：左边（别人 / 它）或右边（我）。`name` 只在群里给 */
function MessageRow({ mine, agent = false, avatar, name, paragraphs, media, onAvatar, onLongPress }: {
  mine: boolean;
  /** 智能体说的（#1465：气泡换 bubbleAgent，与人的分开） */
  agent?: boolean;
  avatar: React.ReactNode;
  name: string | null;
  paragraphs: readonly string[];
  /** 这句带的图 / 视频（#1491，云会话的 chat-media）：正文是占位「[图片]」时只画图 */
  media?: ChatMediaItem[];
  onAvatar?: () => void;
  /** 长按这一句（#1505：派一只智能体去办）。缺席 = 这页不给 */
  onLongPress?: () => void;
}) {
  const { c } = usePalette();
  const texts = media !== undefined && paragraphs.length === 1 && mediaBodyHidden(paragraphs[0] ?? "", media) ? [] : paragraphs;
  const head = onAvatar === undefined ? avatar : (
    <Pressable accessibilityRole="button" accessibilityLabel={name ?? "资料"} onPress={onAvatar} hitSlop={4}>{avatar}</Pressable>
  );
  return (
    <View style={{ flexDirection: mine ? "row-reverse" : "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 12 }}>
      {head}
      <Pressable
        disabled={onLongPress === undefined}
        onLongPress={onLongPress}
        delayLongPress={350}
        accessibilityHint={onLongPress === undefined ? undefined : "长按派一只智能体去办"}
        style={({ pressed }) => [{ flexShrink: 1, maxWidth: "76%", gap: 6, alignItems: mine ? "flex-end" : "flex-start" }, pressed && onLongPress !== undefined && { opacity: 0.85 }]}
      >
        {name !== null ? <Text numberOfLines={1} style={{ fontSize: 12, color: c.mutedForeground, marginBottom: -3, paddingHorizontal: 2 }}>{name}</Text> : null}
        {media !== undefined ? <MediaBubble media={media} bucket={CHAT_MEDIA_BUCKET} /> : null}
        {texts.map((p, i) => <Bubble key={i} text={p} mine={mine} agent={agent} first={i === 0 && media === undefined} />)}
      </Pressable>
    </View>
  );
}

/** 发出去、回执还没回来的那句（#1473）：照「我说的」那一行画，气泡左边一个小转圈（照微信）。
    回执一到它就被 rows 里真的那条顶替——同一句、同一个位置，看起来只是转圈消失。派活开场白（#1665）在这里
    就画成卡：否则发出那一下先闪一段原文，回执到了才变卡 */
export function PendingMineRow({ text, selfName, selfAvatar }: { text: string; selfName: string; selfAvatar: string }) {
  const { c } = usePalette();
  const dispatch = parseDispatchOpening(text);
  return (
    <View style={{ flexDirection: "row-reverse", alignItems: "flex-start", gap: 10, paddingHorizontal: 12 }}>
      <PersonTile name={selfName} url={selfAvatar} size={AVATAR} me />
      <View style={{ flexShrink: 1, maxWidth: "76%", flexDirection: "row-reverse", alignItems: "center", gap: 6 }}>
        {dispatch !== null ? <DispatchCard view={dispatch} /> : <Bubble text={text} mine agent={false} first />}
        <ActivityIndicator size="small" color={c.mutedForeground} accessibilityLabel="发送中" />
      </View>
    </View>
  );
}

/** 派活卡（#1665；维护者看过 demo 选的 A「任务单」）：长按派活的那条开场白，拆回来画成一张卡——上面「派活」
    + 要办什么 + 出处，中间单独框出要办的那条，前面那几句收起来、点开才看。底色还是我的气泡色，读得出是我发的 */
function DispatchCard({ view }: { view: DispatchCardView }) {
  const { c } = usePalette();
  const [open, setOpen] = useState(false);
  const n = view.before.length;
  return (
    <View style={{ flexShrink: 1, minWidth: 240, borderRadius: RADIUS, borderTopRightRadius: 4, backgroundColor: c.bubbleMe, overflow: "hidden" }}>
      <View style={{ paddingTop: 11, paddingHorizontal: 13, paddingBottom: 9, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <Icon name="check" size={13} stroke={2.4} color={c.mutedForeground} />
          <Text style={{ fontSize: 12, letterSpacing: 0.5, color: c.mutedForeground }}>派活</Text>
        </View>
        <Text selectable style={{ fontSize: 17, lineHeight: 24, fontWeight: "600", color: c.foreground }}>{view.prompt}</Text>
        {view.source !== null ? (
          <View style={{ alignSelf: "flex-start", maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 999, backgroundColor: c.field }}>
            <Icon name="message-circle" size={12} stroke={2.2} color={c.mutedForeground} />
            <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 12, color: c.mutedForeground }}>{`来自 ${view.source}`}</Text>
          </View>
        ) : null}
      </View>
      <View style={{ marginHorizontal: 8, paddingVertical: 9, paddingHorizontal: 11, borderRadius: 10, backgroundColor: withAlpha(c.brand, 0.16), gap: 3 }}>
        <Text style={{ fontSize: 11, letterSpacing: 0.6, color: c.brand }}>要办的这条</Text>
        <Text selectable style={{ fontSize: 15, lineHeight: 22, color: c.foreground }}>
          <Text style={{ fontWeight: "600" }}>{`${view.target.who}：`}</Text>
          {view.target.text}
        </Text>
      </View>
      {n > 0 ? (
        <View style={{ paddingTop: 8, paddingHorizontal: 13, paddingBottom: 10, gap: 6 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={open ? "收起前面几句" : `看前面 ${n} 句`}
            onPress={() => setOpen((v) => !v)}
            hitSlop={8}
            style={({ pressed }) => [{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4 }, pressed && { opacity: 0.6 }]}
          >
            <Text style={{ fontSize: 13, color: c.brand }}>{`前面 ${n} 句`}</Text>
            <View style={open ? { transform: [{ rotate: "180deg" }] } : null}>
              <Icon name="chevron-down" size={12} stroke={2.4} color={c.brand} />
            </View>
          </Pressable>
          {open ? view.before.map((l, i) => (
            <Text key={i} selectable style={{ fontSize: 14, lineHeight: 20, color: c.mutedForeground }}>
              <Text style={{ color: c.foreground, opacity: 0.8 }}>{`${l.who}：`}</Text>
              {l.text}
            </Text>
          )) : null}
        </View>
      ) : <View style={{ height: 10 }} />}
    </View>
  );
}

function AgentAvatar({ ws, agentId, name, state = "plain" }: { ws: WorkspaceSnapshot; agentId: string; name: string; state?: FaceState }) {
  const face = agentFaceIfKnown(ws, agentId);
  return face !== null
    ? <FaceTile slot={face.slot} size={AVATAR} state={state} phase={facePhase(agentId)} />
    : <PersonTile name={name} url="" size={AVATAR} />;
}

/** 群名单变了那一行（A3）：居中；每个名字左边一张小脸（名册里查不到的不给脸，被移出的那只常常正是刚被删掉的那只） */
function RosterPill({ parts, ws }: { parts: readonly RosterLinePart[]; ws: WorkspaceSnapshot }) {
  const { c } = usePalette();
  return (
    <View
      accessible
      accessibilityLabel={parts.map((p) => p.text).join("")}
      style={{
        alignSelf: "center", maxWidth: "84%", flexDirection: "row", flexWrap: "wrap", justifyContent: "center", alignItems: "center",
        rowGap: 2, paddingVertical: 3, paddingHorizontal: 10, borderRadius: 6, backgroundColor: withAlpha(c.foreground, 0.05),
      }}
    >
      {parts.map((p, i) => {
        const face = p.agentId === undefined ? null : agentFaceIfKnown(ws, p.agentId);
        return (
          <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
            {face !== null ? <FaceTile slot={face.slot} size={14} radius={3} /> : null}
            <Text style={{ fontSize: 12, lineHeight: 18, color: p.agentId === undefined ? c.mutedForeground : c.foreground }}>{p.text}</Text>
          </View>
        );
      })}
    </View>
  );
}

export function ChatRowView({ row, ws, selfUid, selfName, selfAvatar, group, outreachChat = false, onOpenCall, onAgent, onCallAgent, onDecide, deciding, decideReady, friendAvatarOf, picking, onPickFriend, appConnectActionOf, connecting, onAppConnect, onAppConnectDismiss, onLongPress }: {
  row: ChatRow;
  /** 长按一句话（我的 / 别人的 / 智能体的）：派一只智能体去办（#1505）。缺席 = 这页不给 */
  onLongPress?: (row: ChatRow) => void;
  ws: WorkspaceSnapshot;
  selfUid: string;
  selfName: string;
  selfAvatar: string;
  /** 群里：别人那边的头像上方写名字 */
  group: boolean;
  /** 这是外联会话（#1441）：好友在这里只接电话，未接的来电记录不可回拨 */
  outreachChat?: boolean;
  onOpenCall: (seq: number) => void;
  onAgent: (agentId: string) => void;
  /** 点来电记录「接」或「回拨」：打给这一只（ChatScreen 的 callAgent） */
  onCallAgent: (agentId: string) => void;
  onDecide: (callId: string, decision: "approved" | "denied") => void;
  /** 正在批 / 拒的那张卡 */
  deciding: string | null;
  /** 房间连上了才批得动：连接中画的是本机缓存里的卡，批下去没有对应的那一轮（#1426） */
  decideReady: boolean;
  /** 选人卡的头像（#1520）：按 uid 从好友表取，取不到给空串画首字 */
  friendAvatarOf: (uid: string) => string;
  /** 选人卡里我刚点下、回执还没到的那一下（本地态，日志里没有） */
  picking: { pickId: string; uid: string | null } | null;
  onPickFriend: (pickId: string, uid: string | null) => void;
  /** 连接卡（#1666）的主按钮该是哪个：按这台手机的云端视图判（appConnectAction） */
  appConnectActionOf: (catalogId: string) => AppConnectAction;
  /** 连接卡里我刚发了帧、回执还没到的那一张（connectId；本地态，日志里没有） */
  connecting: string | null;
  onAppConnect: (row: Extract<ChatRow, { kind: "app_connect" }>) => void;
  onAppConnectDismiss: (row: Extract<ChatRow, { kind: "app_connect" }>) => void;
}) {
  const { c } = usePalette();
  switch (row.kind) {
    case "time":
      return <Text style={{ alignSelf: "center", fontSize: 11.5, color: c.faint, fontVariant: ["tabular-nums"], paddingVertical: 2 }}>{row.label}</Text>;
    case "mine":
      if (row.dispatch !== undefined) {
        return (
          <View style={{ flexDirection: "row-reverse", alignItems: "flex-start", gap: 10, paddingHorizontal: 12 }}>
            <PersonTile name={selfName} url={selfAvatar} size={AVATAR} me />
            <Pressable
              disabled={onLongPress === undefined}
              onLongPress={onLongPress === undefined ? undefined : () => onLongPress(row)}
              delayLongPress={350}
              style={({ pressed }) => [{ flexShrink: 1, maxWidth: "76%" }, pressed && onLongPress !== undefined && { opacity: 0.85 }]}
            >
              <DispatchCard view={row.dispatch} />
            </Pressable>
          </View>
        );
      }
      return <MessageRow mine avatar={<PersonTile name={selfName} url={selfAvatar} size={AVATAR} me />} name={null} paragraphs={[row.text]} {...(row.media !== undefined ? { media: row.media } : {})} {...(onLongPress !== undefined ? { onLongPress: () => onLongPress(row) } : {})} />;
    case "human":
      return (
        <MessageRow
          mine={false}
          avatar={<PersonTile name={row.name} url={row.uid !== null ? memberAvatarOf(ws, row.uid) : ""} size={AVATAR} />}
          name={group ? row.name : null}
          paragraphs={[row.text]}
          {...(row.media !== undefined ? { media: row.media } : {})}
          {...(onLongPress !== undefined ? { onLongPress: () => onLongPress(row) } : {})}
        />
      );
    case "agent":
      return (
        <MessageRow
          mine={false}
          agent
          avatar={<AgentAvatar ws={ws} agentId={row.agentId} name={row.name} />}
          name={group ? row.name : null}
          paragraphs={row.paragraphs}
          {...(agentFaceIfKnown(ws, row.agentId) !== null ? { onAvatar: () => onAgent(row.agentId) } : {})}
          {...(onLongPress !== undefined ? { onLongPress: () => onLongPress(row) } : {})}
        />
      );
    case "note":
      return <NotePill text={row.text} tone={row.tone} detail={row.detail} />;
    case "roster":
      return <RosterPill parts={row.parts} ws={ws} />;
    case "call": {
      const dur = row.card.endedTs === null ? "通话中" : callOffsetText(row.card.endedTs - row.card.sinceTs);
      if (group) {
        return (
          <SysPill onPress={() => onOpenCall(row.card.seq)}>
            {`语音通话 ${dur} · ${row.card.utterances} 句`}
            {row.topic !== null ? `\n${row.topic}` : ""}
          </SysPill>
        );
      }
      return (
        <View style={{ flexDirection: "row-reverse", alignItems: "flex-start", gap: 10, paddingHorizontal: 12 }}>
          <PersonTile name={selfName} url={selfAvatar} size={AVATAR} me />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`语音通话 ${dur}，点开看说了什么`}
            onPress={() => onOpenCall(row.card.seq)}
            style={({ pressed }) => [
              { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, paddingHorizontal: 12, borderRadius: RADIUS, borderTopRightRadius: 4, backgroundColor: c.bubbleMe },
              pressed && { opacity: 0.8 },
            ]}
          >
            <Icon name="phone" size={15} stroke={2} color={c.foreground} />
            <Text style={{ fontSize: 16, color: c.foreground }}>{row.card.endedTs === null ? "通话中" : `通话时长 ${dur}`}</Text>
          </Pressable>
        </View>
      );
    }
    case "ring":
      return <RingRecord row={row} ws={ws} group={group} noCallback={outreachChat} onOpenCall={onOpenCall} onCallAgent={onCallAgent} />;
    case "outreach":
      return <OutreachRecord row={row} ws={ws} group={group} onOpenCall={onOpenCall} />;
    case "friend_pick":
      return <FriendPickCard row={row} ws={ws} avatarOf={friendAvatarOf} picking={picking} ready={decideReady} onPick={onPickFriend} />;
    case "app_connect":
      return (
        <AppConnectCard
          row={row}
          ws={ws}
          action={appConnectActionOf(row.catalogId)}
          busy={connecting === row.connectId}
          ready={decideReady}
          onPrimary={onAppConnect}
          onDismiss={onAppConnectDismiss}
        />
      );
    case "approval":
      return <ApprovalCard row={row} busy={deciding === row.callId || !decideReady} onDecide={onDecide} selfUid={selfUid} />;
    case "task":
      return <TaskCard row={row} />;
    case "app":
      return <AppCard row={row} />;
    default: {
      const unhandled: never = row;
      return unhandled;
    }
  }
}

/** 任务卡（#1571 第 4 步）：居中一张，标题 + 状态 + 派给谁；等主人拍板的那句 / 收口的那句写在底下。点一下展开说明 */
function TaskCard({ row }: { row: Extract<ChatRow, { kind: "task" }> }) {
  const { c } = usePalette();
  const [open, setOpen] = useState(false);
  const tone = row.status === "needs_owner" ? c.brand : row.status === "failed" ? c.destructive : row.status === "done" ? c.ok : c.mutedForeground;
  const tail = row.status === "needs_owner" ? row.question : row.status === "done" || row.status === "failed" ? row.summary : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`任务 ${row.title}，${TASK_STATUS_TEXT[row.status]}${row.assigneeName === null ? "" : `，派给${row.assigneeName}`}${tail === null ? "" : `，${tail}`}`}
      onPress={() => setOpen((v) => !v)}
      style={({ pressed }) => [{ alignSelf: "center", width: "82%" }, pressed && { opacity: 0.7 }]}
    >
      <View style={{ borderRadius: 10, backgroundColor: c.card, borderWidth: 0.5, borderColor: c.border, paddingVertical: 8, paddingHorizontal: 12, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name="check" size={13} stroke={2.2} color={tone} />
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, fontWeight: "600", color: c.foreground }}>
            {row.parentTitle === null ? row.title : `${row.parentTitle} › ${row.title}`}
          </Text>
          <Text style={{ fontSize: 12, color: tone }}>{TASK_STATUS_TEXT[row.status]}</Text>
        </View>
        {row.assigneeName !== null ? <Text style={{ fontSize: 12, color: c.mutedForeground }}>{`派给 ${row.assigneeName}`}</Text> : null}
        {row.collaboratorName !== null ? <Text style={{ fontSize: 12, color: c.mutedForeground }}>{`协作：${row.collaboratorName}`}</Text> : null}
        {tail !== null ? <Text style={{ fontSize: 12, lineHeight: 17, color: row.status === "needs_owner" ? c.foreground : c.mutedForeground }}>{tail}</Text> : null}
        {open && row.brief !== "" ? <Text style={{ fontSize: 12, lineHeight: 17, color: c.mutedForeground }}>{row.brief}</Text> : null}
      </View>
    </Pressable>
  );
}

/** 旁白 / 出错。带全文（后台任务那一档、出错原文、拒绝的理由）时点一下展开 */
function NotePill({ text, tone, detail }: { text: string; tone: "muted" | "error"; detail: string | null }) {
  const [open, setOpen] = useState(false);
  if (detail === null) return <SysPill tone={tone}>{text}</SysPill>;
  return (
    <SysPill tone={tone} onPress={() => setOpen((v) => !v)}>
      {open ? `${text}\n${detail}` : `${text} ›`}
    </SysPill>
  );
}

/** 它打来的一通电话（#1411，维护者看过 demo 选的微信式通话记录）：私聊里是它那一侧的一个气泡——图标 + 「未接来电」/
    「来电 · 正在响」/「通话时长 00:12」，第二行是它要说的那句话；群里（或者打给的不是我）是居中灰条。点一下做什么
    与每一行怎么说都在 ringRecordView */
function RingRecord({ row, ws, group, noCallback, onOpenCall, onCallAgent }: {
  row: Extract<ChatRow, { kind: "ring" }>;
  ws: WorkspaceSnapshot;
  group: boolean;
  /** 外联会话里好友不能回拨（#1441） */
  noCallback: boolean;
  onOpenCall: (seq: number) => void;
  onCallAgent: (agentId: string) => void;
}) {
  const { c } = usePalette();
  const v = ringRecordView(row, group, { noCallback });
  const call = row.call;
  const onPress = v.tap === null ? undefined : v.tap === "open" ? (call !== null ? () => onOpenCall(call.seq) : undefined) : () => onCallAgent(row.agentId);
  const label = `${v.line}。${row.reason}`;
  if (group || !row.toMe) {
    const ink = v.tone === "missed" ? c.destructive : c.mutedForeground;
    return (
      <Pressable
        accessibilityRole={onPress === undefined ? "text" : "button"}
        accessibilityLabel={label}
        disabled={onPress === undefined}
        onPress={onPress}
        style={({ pressed }) => [{ alignSelf: "center", maxWidth: "80%" }, pressed && { opacity: 0.6 }]}
      >
        <View style={{ alignItems: "center", paddingVertical: 3, paddingHorizontal: 10, borderRadius: 6, backgroundColor: withAlpha(c.foreground, 0.05) }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Icon name={v.icon} size={12} stroke={2} color={ink} />
            <Text style={{ fontSize: 12, lineHeight: 18, color: ink, textAlign: "center" }}>{v.line}</Text>
          </View>
          <Text numberOfLines={2} style={{ fontSize: 12, lineHeight: 18, color: c.mutedForeground, textAlign: "center" }}>{row.reason}</Text>
        </View>
      </Pressable>
    );
  }
  const tint = v.tone === "missed" ? c.destructive : v.tone === "ringing" ? c.voice : c.foreground;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 12 }}>
      <AgentAvatar ws={ws} agentId={row.agentId} name={row.name} />
      <Pressable
        accessibilityRole={onPress === undefined ? "text" : "button"}
        accessibilityLabel={label}
        disabled={onPress === undefined}
        onPress={onPress}
        style={({ pressed }) => [
          { flexShrink: 1, maxWidth: "76%", gap: 3, paddingVertical: 9, paddingHorizontal: 12, borderRadius: RADIUS, borderTopLeftRadius: 4, backgroundColor: c.bubbleAgent },
          pressed && { opacity: 0.8 },
        ]}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name={v.icon} size={16} stroke={2} color={tint} />
          <Text style={{ flexShrink: 1, fontSize: 16, lineHeight: 24, color: c.foreground }}>{v.line}</Text>
        </View>
        <Text style={{ fontSize: 14, lineHeight: 20, color: c.mutedForeground }}>{row.reason}</Text>
      </Pressable>
    </View>
  );
}

/** 我的智能体打给朋友的一通电话（#1441）：私聊里是它那一侧的一个气泡，群里是居中灰条。进行中 / 未接 / 没打通都不可点；
    接通过且带转写的点开底部抽屉看全文（与通话卡同一扇）。文案与「点不点得开」的判据都在 mobileChat（outreachRowView / outreachCard） */
function OutreachRecord({ row, ws, group, onOpenCall }: {
  row: Extract<ChatRow, { kind: "outreach" }>;
  ws: WorkspaceSnapshot;
  group: boolean;
  onOpenCall: (seq: number) => void;
}) {
  const { c } = usePalette();
  const { card, view } = row;
  const onPress = card === null ? undefined : () => onOpenCall(card.seq);
  const icon = view.tone === "missed" ? "phone-missed" : "phone";
  const text = group ? row.groupText : view.text;
  const label = card === null ? text : `${text}，点开看说了什么`;
  if (group) {
    const ink = view.tone === "missed" ? c.destructive : c.mutedForeground;
    return (
      <Pressable
        accessibilityRole={onPress === undefined ? "text" : "button"}
        accessibilityLabel={label}
        disabled={onPress === undefined}
        onPress={onPress}
        style={({ pressed }) => [{ alignSelf: "center", maxWidth: "80%" }, pressed && { opacity: 0.6 }]}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 3, paddingHorizontal: 10, borderRadius: 6, backgroundColor: withAlpha(c.foreground, 0.05) }}>
          <Icon name={icon} size={12} stroke={2} color={ink} />
          <Text style={{ flexShrink: 1, fontSize: 12, lineHeight: 18, color: ink, textAlign: "center" }}>{text}</Text>
        </View>
      </Pressable>
    );
  }
  const tint = view.tone === "missed" ? c.destructive : view.tone === "live" ? c.voice : c.foreground;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 12 }}>
      <AgentAvatar ws={ws} agentId={row.agentId} name={row.name} />
      <Pressable
        accessibilityRole={onPress === undefined ? "text" : "button"}
        accessibilityLabel={label}
        disabled={onPress === undefined}
        onPress={onPress}
        style={({ pressed }) => [
          { flexShrink: 1, maxWidth: "76%", flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 9, paddingHorizontal: 12, borderRadius: RADIUS, borderTopLeftRadius: 4, backgroundColor: c.bubbleAgent },
          pressed && { opacity: 0.8 },
        ]}
      >
        <Icon name={icon} size={16} stroke={2} color={tint} />
        <Text style={{ flexShrink: 1, fontSize: 16, lineHeight: 24, color: view.tone === "missed" ? c.destructive : c.foreground }}>{text}</Text>
      </Pressable>
    </View>
  );
}

/** 选人卡（#1520；维护者看过 demo 选的 A 版）：长在它的气泡里——上面一句问话，下面一行一人（头像 + 名字 + 为什么猜他），
    最底下「都不是」。点人 = 直接拨（卡里存着交代与开场白，不再过一轮模型）。头像按 uid 从好友表取，取不到画首字。
    `picking` = 这张卡我刚点下、回执还没到（本地态，日志里没有）。
    `row.canPick` 为假（主场群里的客人）= 只读：没有电话图标、行不可点、没有「都不是」，开着时脚注写等谁选；
    点过 / 失败 / 过期这些结局两边画得一样 */
function FriendPickCard({ row, ws, avatarOf, picking, ready, onPick }: {
  row: Extract<ChatRow, { kind: "friend_pick" }>;
  ws: WorkspaceSnapshot;
  avatarOf: (uid: string) => string;
  picking: { pickId: string; uid: string | null } | null;
  ready: boolean;
  onPick: (pickId: string, uid: string | null) => void;
}) {
  const { c } = usePalette();
  const mine = picking !== null && picking.pickId === row.pickId ? picking : null;
  const open = row.status === "open" && mine === null && row.canPick;
  const waiting = row.status === "open" && !row.canPick;
  const chosen = mine?.uid ?? row.pickedUid;
  const chosenName = row.candidates.find((x) => x.uid === chosen)?.name ?? "";
  const line = { borderTopWidth: 1, borderTopColor: c.border } as const;
  const foot =
    mine !== null && mine.uid !== null ? (
      <View style={[line, { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 12 }]}>
        <ActivityIndicator size="small" color={c.voice} />
        <Text style={{ fontSize: 13, color: c.mutedForeground }}>{`正在拨给 ${chosenName}…`}</Text>
      </View>
    ) : row.status === "failed" ? (
      <Text style={[line, { paddingVertical: 8, paddingHorizontal: 12, fontSize: 13, lineHeight: 18, color: c.destructive }]}>{row.message ?? ""}</Text>
    ) : row.status === "dismissed" ? (
      <Text style={[line, { paddingVertical: 8, paddingHorizontal: 12, fontSize: 13, color: c.mutedForeground }]}>都不是。要打给谁，直接告诉我名字。</Text>
    ) : row.status === "expired" ? (
      <Text style={[line, { paddingVertical: 8, paddingHorizontal: 12, fontSize: 13, color: c.mutedForeground }]}>这张卡过期了，要打再跟我说。</Text>
    ) : waiting ? (
      <Text style={[line, { paddingVertical: 8, paddingHorizontal: 12, fontSize: 13, color: c.mutedForeground }]}>{row.waitingFor !== null ? `等 ${row.waitingFor} 选` : "等主人选"}</Text>
    ) : open ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="都不是"
        disabled={!ready}
        onPress={() => onPick(row.pickId, null)}
        style={({ pressed }) => [line, { paddingVertical: 9, alignItems: "center" }, pressed && { opacity: 0.6 }]}
      >
        <Text style={{ fontSize: 14, color: c.mutedForeground }}>都不是</Text>
      </Pressable>
    ) : null;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 12 }}>
      <AgentAvatar ws={ws} agentId={row.agentId} name={row.name} />
      <View style={{ flexShrink: 1, maxWidth: "76%", minWidth: 240, borderRadius: RADIUS, borderTopLeftRadius: 4, backgroundColor: c.bubbleAgent, overflow: "hidden" }}>
        <Text style={{ paddingTop: 9, paddingBottom: 7, paddingHorizontal: 12, fontSize: 16, lineHeight: 24, color: c.foreground }}>{row.question}</Text>
        {row.candidates.map((f) => {
          const picked = chosen === f.uid && row.status !== "dismissed" && row.status !== "expired";
          const dim = !open && !picked && !waiting; // 只读但还开着：行都是正常亮度，只是不可点
          const rowStyle: StyleProp<ViewStyle> = [
            line,
            { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 12 },
            picked && { backgroundColor: withAlpha(c.voice, 0.2) },
            dim && { opacity: 0.35 },
          ];
          // 头像描边：点中的那位圈一道 voice 色（demo 的 .picked .av）；别人也留同样大的透明边，免得整列头像错位
          const face = (
            <View style={{ padding: 1, borderWidth: 2, borderColor: picked ? c.voice : "transparent", borderRadius: tileRadius(36) + 3 }}>
              <PersonTile name={f.name} url={avatarOf(f.uid)} size={36} />
            </View>
          );
          const text = (
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ fontSize: 16, lineHeight: 22, fontWeight: "500", color: c.foreground }}>{f.name}</Text>
              {f.why !== "" ? <Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: c.mutedForeground }}>{f.why}</Text> : null}
            </View>
          );
          // 只读（不是主人）：一行普通的字，不是按钮——别让客人以为点得动
          if (!row.canPick) return <View key={f.uid} style={rowStyle}>{face}{text}</View>;
          return (
            <Pressable
              key={f.uid}
              accessibilityRole="button"
              accessibilityLabel={f.why === "" ? `打给 ${f.name}` : `打给 ${f.name}，${f.why}`}
              disabled={!open || !ready}
              onPress={() => onPick(row.pickId, f.uid)}
              style={({ pressed }) => [...rowStyle, pressed && open && { opacity: 0.7 }]}
            >
              {face}
              {text}
              {open ? <Icon name="phone" size={16} stroke={2} color={c.voice} /> : null}
            </Pressable>
          );
        })}
        {foot}
      </View>
    </View>
  );
}

/** 连接卡（#1666；维护者看过 demo 的「连接卡」）：长在它的气泡里——上面应用图标 + 标题 + 为什么要连，下面一条顶边线
    隔出两格「不用了 | 主按钮」。主按钮写什么（去连接 / 重新登录 / 打开 / 好了，接着办）由调用方按自己的云端视图算好
    递进来（`action`），卡本身不读 store。`busy` = 这张卡我刚发了帧、回执还没到（本地态）：两格都按不动，主按钮那格转圈。
    `row.canAct` 为假（主场群里的客人）= 只读：开着时只写等谁连；连上 / 没连 / 过期这些结局两边画得一样 */
function AppConnectCard({ row, ws, action, busy, ready, onPrimary, onDismiss }: {
  row: Extract<ChatRow, { kind: "app_connect" }>;
  ws: WorkspaceSnapshot;
  action: AppConnectAction;
  busy: boolean;
  ready: boolean;
  onPrimary: (row: Extract<ChatRow, { kind: "app_connect" }>) => void;
  onDismiss: (row: Extract<ChatRow, { kind: "app_connect" }>) => void;
}) {
  const { c } = usePalette();
  const line = { borderTopWidth: 1, borderTopColor: c.border } as const;
  const status = (text: string, color: string, check = false) => (
    <View style={[line, { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 9, paddingHorizontal: 13 }]}>
      {check ? <Icon name="check" size={14} stroke={2.6} color={color} /> : null}
      <Text style={{ flexShrink: 1, fontSize: 13, lineHeight: 18, color }}>{text}</Text>
    </View>
  );
  const off = busy || !ready;
  const foot =
    row.status === "connected" ? status("已连上，接着办", c.ok, true)
      : row.status === "dismissed" ? status("没连。要用再跟我说。", c.mutedForeground)
        : row.status === "expired" ? status("这张卡过期了，要用再跟我说。", c.mutedForeground)
          : !row.canAct ? status(row.waitingFor !== null ? `等 ${row.waitingFor} 连` : "等主人连", c.mutedForeground)
            : (
              <View style={[line, { flexDirection: "row" }]}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="不用了"
                  disabled={off}
                  onPress={() => onDismiss(row)}
                  style={({ pressed }) => [{ flex: 1, paddingVertical: 10, alignItems: "center", justifyContent: "center" }, pressed && { opacity: 0.55 }]}
                >
                  <Text style={{ fontSize: 15, lineHeight: 20, color: c.foreground }}>不用了</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={APP_CONNECT_BUTTON[action]}
                  disabled={off}
                  onPress={() => onPrimary(row)}
                  style={({ pressed }) => [
                    { flex: 1, paddingVertical: 10, alignItems: "center", justifyContent: "center", borderLeftWidth: 1, borderLeftColor: c.border },
                    pressed && { opacity: 0.55 },
                  ]}
                >
                  {busy
                    ? <ActivityIndicator size="small" color={c.brand} />
                    : <Text style={{ fontSize: 15, lineHeight: 20, fontWeight: "600", color: c.brand }}>{APP_CONNECT_BUTTON[action]}</Text>}
                </Pressable>
              </View>
            );
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 12 }}>
      <AgentAvatar ws={ws} agentId={row.agentId} name={row.name} />
      <View style={{ flexShrink: 1, maxWidth: "76%", minWidth: 240, borderRadius: RADIUS, borderTopLeftRadius: 4, backgroundColor: c.bubbleAgent, overflow: "hidden" }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 11, paddingVertical: 11, paddingHorizontal: 13 }}>
          <AppTile name={row.appName} icon={catalogIcon(row.catalogId)} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 16, lineHeight: 22, fontWeight: "600", color: c.foreground }}>{appConnectTitle(action, row.appName)}</Text>
            {row.why !== "" ? <Text style={{ marginTop: 2, fontSize: 14, lineHeight: 20, color: c.mutedForeground }}>{row.why}</Text> : null}
          </View>
        </View>
        {foot}
      </View>
    </View>
  );
}

/** 一张还没人批的审批卡（#1386 团队群）：谁要做什么 + 逐字段（字段值里的换行伪造不出第二格，#957 B-C2）；
    发起这一轮的人或群主才看得到「拒绝 / 允许」，别人看到「等 X 批」 */
function ApprovalCard({ row, busy, onDecide }: {
  row: Extract<ChatRow, { kind: "approval" }>;
  busy: boolean;
  onDecide: (callId: string, decision: "approved" | "denied") => void;
  selfUid: string;
}) {
  const { c } = usePalette();
  return (
    <View style={{ marginHorizontal: 24, padding: 14, borderRadius: 14, backgroundColor: c.card, borderWidth: 1, borderColor: withAlpha(c.warn, 0.5), gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="shield-check" size={16} stroke={2} color={c.warn} />
        <Text style={{ flex: 1, fontSize: 14, fontWeight: "600", color: c.foreground }}>{row.title}</Text>
      </View>
      {row.fields.length > 0 ? (
        row.fields.map((f, i) => (
          <View key={i} style={{ gap: 2 }}>
            <Text style={{ fontSize: 12, color: c.mutedForeground }}>{f.label}</Text>
            <Text selectable numberOfLines={6} style={{ fontSize: 14, lineHeight: 20, color: c.foreground }}>{f.value}</Text>
          </View>
        ))
      ) : (
        <Text selectable numberOfLines={6} style={{ fontSize: 14, lineHeight: 20, color: c.foreground }}>{row.summary}</Text>
      )}
      {row.canDecide ? (
        <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
          <Button grow size="compact" variant="secondary" label="拒绝" disabled={busy} onPress={() => onDecide(row.callId, "denied")} />
          <Button grow size="compact" variant="primary" label={busy ? "…" : "允许"} disabled={busy} onPress={() => onDecide(row.callId, "approved")} />
        </View>
      ) : (
        <Text style={{ fontSize: 13, color: c.mutedForeground }}>{`等 ${row.waitingFor} 批`}</Text>
      )}
    </View>
  );
}

/** 最底下那一行 =「此刻」：它那边一个打字的气泡（三个点一口一口地亮），脸跟着它在干什么走；
    右边一颗小的停钮，只在它真在跑时出现（demo 没画这颗，但停下这一轮是 ADR-0227 的能力，不能因为换了壳就没了）。
    钮里是实心小方块（#1482）——桌面「停止生成」同一个符号（composer 的 SquareIcon fill-current），
    不再写字「停」；正在停的那几百毫秒换成转圈，钮本身不变灰（变灰 + 字没了，看起来像坏了）。
    28pt 圆钮、底色 c.field、按下 0.5 透明：全是原来那颗胶囊的数 */
export function TypingRow({ ws, agentId, name, face, group, canStop, stopping, onStop }: {
  ws: WorkspaceSnapshot;
  agentId: string;
  name: string;
  face: FaceState;
  group: boolean;
  canStop: boolean;
  stopping: boolean;
  onStop: () => void;
}) {
  const { c } = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 12 }}>
      <AgentAvatar ws={ws} agentId={agentId} name={name} state={face} />
      <View style={{ gap: 3, alignItems: "flex-start" }}>
        {group ? <Text style={{ fontSize: 12, color: c.mutedForeground, paddingHorizontal: 2 }}>{name}</Text> : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <TypingDots />
          {canStop ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`让${name}停下这一轮`}
              accessibilityState={{ busy: stopping }}
              disabled={stopping}
              onPress={onStop}
              hitSlop={8}
              style={({ pressed }) => [
                { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: c.field },
                pressed && { opacity: 0.5 },
              ]}
            >
              {stopping ? <ActivityIndicator size="small" color={c.mutedForeground} /> : <Icon name="square" size={10} fill color={c.foreground} />}
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/** 三个点（demo 的 .bubble.typing）：一口一口地亮，1.2 秒一轮、依次错开 0.15 秒；关了动效就三颗静止的点 */
function TypingDots() {
  const { c } = usePalette();
  return (
    <View
      accessibilityLabel="正在回复"
      style={{ height: 38, paddingHorizontal: 14, borderRadius: RADIUS, borderTopLeftRadius: 4, backgroundColor: c.bubbleAgent, flexDirection: "row", alignItems: "center", gap: 4 }}
    >
      {[0, 1, 2].map((i) => <Dot key={i} delay={i * 150} />)}
    </View>
  );
}

function Dot({ delay }: { delay: number }) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const k = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(k, { toValue: 1, duration: 360, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(k, { toValue: 0, duration: 360, easing: Easing.in(Easing.quad), useNativeDriver: true }),
        Animated.delay(480 - delay),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduce, delay, k]);
  return (
    <Animated.View
      style={{
        width: 6, height: 6, borderRadius: 3, backgroundColor: c.foreground,
        opacity: reduce ? 0.4 : k.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.8] }),
        transform: reduce ? [] : [{ translateY: k.interpolate({ inputRange: [0, 1], outputRange: [0, -3] }) }],
      }}
    />
  );
}

/** 应用卡（#1591）：图标 + 名字 + 版本 + 这一版改了什么；点开进宿主。谁打的写在底下 */
function AppCard({ row }: { row: Extract<ChatRow, { kind: "app" }> }) {
  const { c } = usePalette();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`打开应用 ${row.name}`}
      onPress={() => navigation.navigate("MiniApp", { appId: row.appId })}
      style={({ pressed }) => [{ alignSelf: "stretch", marginHorizontal: 12 }, pressed && { opacity: 0.8 }]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: RADIUS, backgroundColor: withAlpha(c.brand, 0.08), borderWidth: 1, borderColor: withAlpha(c.brand, 0.25) }}>
        <View style={{ width: 44, height: 44, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: c.background }}>
          <Text style={{ fontSize: 24 }}>{row.icon}</Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: "600", color: c.foreground }}>{`${row.name} · v${row.version}`}</Text>
          <Text numberOfLines={2} style={{ fontSize: 13, color: c.mutedForeground }}>{row.note !== "" ? row.note : `${row.byName} 打好了，点开就能用`}</Text>
        </View>
        <Icon name="chevron-right" size={16} stroke={2} color={c.faint} />
      </View>
    </Pressable>
  );
}
