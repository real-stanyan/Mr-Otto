// 「@ 谁」（#1386，demo 的 mentionSheet）：群里打一个 @、或 ⊕ 里点「@ 谁」，从底下升起一张单子——群里的智能体，
// 团队群里还有别的人。点一个就收；`@名字 ` 等抽屉退场放完再插进输入框（调用方在 onExited 之后再等一帧：
// Modal 还在的时候输入框拿不到焦点）。发出去时点了谁仍由 resolveSendMentions 说了算（与桌面同一份）。
// 选人是挑东西，按规矩走底部抽屉。
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { agentNameOf } from "../../../src/shared/workspaceView.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { BottomSheet } from "../sheet/BottomSheet.js";
import { usePalette } from "../theme.js";
import { FaceTile, PersonTile } from "../wx/Avatar.js";

/** 抽屉底下那一句：不 @ 谁时谁接（ADR-0270 的派活） */
export const MENTION_FOOTER = "不 @ 谁 = 它们自己认领：读一遍名册和最近几句，挑职责对口的那只；都不对口就没人接。";
/** 座位制的群（#1682）：没有派活，不 @ 就只是人跟人说话；别家的管理员动手要它主人点头 */
export const SEAT_MENTION_FOOTER = "不 @ 谁就是人跟人聊天。@ 自己的管理员，它马上替你办；@ 别人的管理员，能聊，要动手得先等它的主人点头。";

export function MentionSheet({ visible, ws, agentIds, entries, humans, footer = MENTION_FOOTER, onPick, onClose, onExited }: {
  visible: boolean;
  ws: WorkspaceSnapshot;
  agentIds: readonly string[];
  /** 团队群里别的人（名字 + 头像）；主场群里没有 */
  humans: readonly { uid: string; name: string; url: string }[];
  /** 底下那一句。默认是群里的派活规矩；朋友私聊里（#1493）不 @ 谁是发给朋友，调用方换一句；null 不画 */
  footer?: string | null;
  /** 给了就按这份画（朋友私聊：两边的管理员同一个 agentId、都叫管理员，要靠 key / 名字 / 标签分开，#1571）；没给按 agentIds 画 */
  entries?: readonly { key: string; name: string; tag: string; slot: number }[];
  /** 挑中的那个名字 */
  onPick: (name: string) => void;
  onClose: () => void;
  onExited?: () => void;
}) {
  const { c } = usePalette();
  const row = (key: string, avatar: React.ReactNode, name: string, tag: string, first: boolean) => (
    <View key={key}>
      {first ? null : <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: 64 }} />}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`@${name}，${tag}`}
        onPress={() => onPick(name)}
        style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 12, height: 58, paddingHorizontal: 16 }, pressed && { backgroundColor: c.press }]}
      >
        {avatar}
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 17, color: c.foreground }}>{name}</Text>
        <Text style={{ fontSize: 13, color: c.mutedForeground }}>{tag}</Text>
      </Pressable>
    </View>
  );
  return (
    <BottomSheet visible={visible} title="选择要 @ 的" onClose={onClose} {...(onExited === undefined ? {} : { onExited })}>
      <ScrollView contentContainerStyle={{ paddingBottom: 12 }}>
        <View style={{ backgroundColor: c.card }}>
          {entries !== undefined
            ? entries.map((e, i) => row(e.key, <FaceTile slot={e.slot} size={36} />, e.name, e.tag, i === 0))
            : agentIds.map((id, i) => row(`a:${id}`, <FaceTile slot={agentFaceSlot(ws, id)} size={36} />, agentNameOf(ws, id), "智能体", i === 0))}
          {humans.map((h, i) => row(`h:${h.uid}`, <PersonTile name={h.name} url={h.url} size={36} />, h.name, "成员", agentIds.length === 0 && (entries?.length ?? 0) === 0 && i === 0))}
        </View>
        {(agentIds.length > 0 || (entries?.length ?? 0) > 0) && footer !== null ? <Text style={{ fontSize: 13, lineHeight: 19, color: c.mutedForeground, padding: 16 }}>{footer}</Text> : null}
      </ScrollView>
    </BottomSheet>
  );
}
