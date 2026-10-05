// 「聊天」页签的一行（#1386，demo 的 .mrow）：头像 48（右上角压一枚角标）| 名字 + 右边时间 | 第二行。
// 第二行的优先级：草稿（「[草稿]」加粗）>「[有人@我]」（点缀色）> 最后一句。按下整行变色（列表行的语汇），不缩放。
// 分隔线从头像右边开始（照微信），由列表那一层画。
import { memo, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ACTIVITY_TEXT, activityBadge } from "../../../src/shared/agentActivity.js";
import { listTimeLabel, type InboxRow } from "../../../src/shared/wechatInbox.js";
import { usePalette } from "../theme.js";
import { SpecAvatar } from "../wx/Avatar.js";
import { CountBadge, DotBadge, PresenceDot, StatusBadge } from "../wx/Badge.js";
import { usePresence } from "../friends/presenceStore.js";
import { Icon } from "../wx/Icon.js";
import { OwnerPill } from "../wx/OwnerPill.js";

export const CHAT_ROW_AVATAR = 48;
/** 分隔线从哪儿开始：左边距 16 + 头像 48 + 间距 12 */
export const CHAT_ROW_SEP = 76;

export const ChatListRow = memo(function ChatListRow({ row, draft, now, onPress, status }: {
  row: InboxRow;
  draft: string;
  now: number;
  onPress: () => void;
  /** 第二行底下再加一行（#1566 智能体列表里的「空闲 / 执行中 · 在〈群名〉」）；缺席 = 两行，与改动前相同 */
  status?: ReactNode;
}) {
  const { c } = usePalette();
  const time = row.ts > 0 ? listTimeLabel(row.ts, now) : "";
  const unreadText = row.unread === null ? "" : row.unread.kind === "count" ? `，${row.unread.n} 条新消息` : "，有新消息";
  const badge = activityBadge(row.activity ?? null);
  const activityText = row.activity !== undefined ? `，${ACTIVITY_TEXT[row.activity]}` : "";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.title}${row.owner !== undefined ? `，${row.owner.name} 的智能体` : ""}${activityText}${unreadText}${row.mention ? "，有人@我" : ""}${row.muted === true ? "，消息免打扰" : ""}，${draft !== "" ? `草稿：${draft}` : row.preview}${time !== "" ? `，${time}` : ""}`}
      onPress={onPress}
      style={({ pressed }) => [
        { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 72, paddingHorizontal: 16, backgroundColor: c.card },
        pressed && { backgroundColor: c.press },
      ]}
    >
      <View>
        <SpecAvatar spec={row.avatar} size={CHAT_ROW_AVATAR} />
        {row.unread?.kind === "count" ? (
          <View style={{ position: "absolute", top: -6, right: -7 }}>
            <CountBadge n={row.unread.n} ring={c.card} />
          </View>
        ) : row.unread?.kind === "dot" || row.mention ? (
          <View style={{ position: "absolute", top: -3, right: -3 }}>
            <DotBadge ring={c.card} />
          </View>
        ) : null}
        {badge !== null ? (
          <View style={{ position: "absolute", bottom: -3, right: -3 }}>
            <StatusBadge badge={badge} ring={c.card} size={10} />
          </View>
        ) : null}
        {/* 朋友私聊：在线点（#1460）。智能体那几种行右下角是状态角标，朋友行没有，两枚不打架 */}
        {row.target.kind === "friend" ? <FriendPresenceDot uid={row.target.uid} ring={c.card} /> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0, paddingVertical: 12, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          {/* 朋友的智能体（#1641）：名字在前，主人是右边那枚药丸；名字长了先截名字 */}
          <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 17, color: c.foreground }}>{row.title}</Text>
            {row.owner !== undefined ? <OwnerPill owner={row.owner} /> : null}
          </View>
          {time !== "" ? <Text style={{ fontSize: 12, color: c.faint, fontVariant: ["tabular-nums"] }}>{time}</Text> : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.mutedForeground }}>
          {draft !== "" ? (
            <>
              <Text style={{ fontWeight: "500", color: c.foreground }}>[草稿] </Text>
              {draft.replace(/\s+/g, " ")}
            </>
          ) : (
            <>
              {row.mention ? <Text style={{ color: c.brand }}>[有人@我] </Text> : null}
              {row.preview}
            </>
          )}
        </Text>
        {/* 免打扰（#1442）：同微信，第二行右边一枚静音标 */}
        {row.muted === true ? <Icon name="bell-off" size={14} stroke={1.8} color={c.faint} /> : null}
        </View>
        {status ?? null}
      </View>
    </Pressable>
  );
});

/** 单拎出来是因为 hook 只能在朋友行里调（ChatListRow 是所有行共用的） */
function FriendPresenceDot({ uid, ring }: { uid: string; ring: string }) {
  const presence = usePresence(uid);
  if (presence === null) return null;
  return (
    <View style={{ position: "absolute", bottom: -3, right: -3 }}>
      <PresenceDot presence={presence} ring={ring} size={10} />
    </View>
  );
}
