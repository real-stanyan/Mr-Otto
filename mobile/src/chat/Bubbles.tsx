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
import { ActivityIndicator, Animated, Easing, Pressable, Text, View } from "react-native";
import { agentFaceIfKnown } from "../../../src/shared/agentAvatar.js";
import type { RosterLinePart } from "../../../src/shared/cloudTimeline.js";
import { callOffsetText } from "../../../src/shared/cloudTimeline.js";
import { ringRecordView, type ChatRow } from "../../../src/shared/mobileChat.js";
import { CHAT_MEDIA_BUCKET, mediaBodyHidden, type ChatMediaItem } from "../../../src/shared/chatMedia.js";
import { MediaBubble } from "../media/MediaBubble.js";
import { facePhase } from "../../../src/shared/ottoFace/art.js";
import type { FaceState } from "../../../src/shared/ottoFace/index.js";
import { memberAvatarOf } from "../../../src/shared/workspaceView.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { usePalette, withAlpha } from "../theme.js";
import { Button, useReduceMotion } from "../ui.js";
import { FaceTile, PersonTile } from "../wx/Avatar.js";
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
    回执一到它就被 rows 里真的那条顶替——同一句、同一个位置，看起来只是转圈消失 */
export function PendingMineRow({ text, selfName, selfAvatar }: { text: string; selfName: string; selfAvatar: string }) {
  const { c } = usePalette();
  return (
    <View style={{ flexDirection: "row-reverse", alignItems: "flex-start", gap: 10, paddingHorizontal: 12 }}>
      <PersonTile name={selfName} url={selfAvatar} size={AVATAR} me />
      <View style={{ flexShrink: 1, maxWidth: "76%", flexDirection: "row-reverse", alignItems: "center", gap: 6 }}>
        <Bubble text={text} mine agent={false} first />
        <ActivityIndicator size="small" color={c.mutedForeground} accessibilityLabel="发送中" />
      </View>
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

export function ChatRowView({ row, ws, selfUid, selfName, selfAvatar, group, outreachChat = false, onOpenCall, onAgent, onCallAgent, onDecide, deciding, decideReady, onLongPress }: {
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
}) {
  const { c } = usePalette();
  switch (row.kind) {
    case "time":
      return <Text style={{ alignSelf: "center", fontSize: 11.5, color: c.faint, fontVariant: ["tabular-nums"], paddingVertical: 2 }}>{row.label}</Text>;
    case "mine":
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
    case "approval":
      return <ApprovalCard row={row} busy={deciding === row.callId || !decideReady} onDecide={onDecide} selfUid={selfUid} />;
    default: {
      const unhandled: never = row;
      return unhandled;
    }
  }
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
