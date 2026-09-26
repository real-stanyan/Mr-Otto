// 「@ 谁」（#1356 A3，spec §5.6）：群聊输入框上方那颗钮 + 点开的底部抽屉。抽屉只列这个群里的智能体，
// 点一只就收；`@名字 ` 等抽屉退场放完再插进输入框（调用方在 onExited 里插——抽屉的 Modal 还在的时候
// 输入框拿不到焦点）。插在哪由 shared 的 insertAgentMention 判；发出去时点了谁仍由 resolveSendMentions
// 说了算（与桌面同一份）。私聊里不画这颗钮（名单里只有它一只）；空群也不画（没有谁可点）。
import { useRef } from "react";
import { Animated, Pressable, ScrollView, Text } from "react-native";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { AgentPickRow } from "../group/AgentPickRow.js";
import { BottomSheet } from "../sheet/BottomSheet.js";
import { PRESS_SPRING, space, usePalette } from "../theme.js";
import { Group, useReduceMotion } from "../ui.js";

/** 抽屉底下那一句：不 @ 谁时谁接（ADR-0270 的派活）。demo 那句后面补了「都不对口就没人接」——
    群里闲聊没人接是那边定的口径，不说的话人会一直等 */
export const MENTION_FOOTER = "不 @ 谁 = 它们自己认领：读一遍名册和最近几句，挑职责对口的那只；都不对口就没人接。";

/** 输入框上方那颗「@ 谁」：按下缩到 .96（同 RoleChips 的 chip），关了动效退成变暗 */
export function MentionChip({ onPress }: { onPress: () => void }) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number): void => {
    if (!reduce) Animated.spring(scale, { toValue: v, useNativeDriver: true, ...PRESS_SPRING }).start();
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="@ 谁"
      accessibilityHint="挑一只智能体接这一句，它的名字会插进输入框"
      hitSlop={6}
      onPressIn={() => to(0.96)}
      onPressOut={() => to(1)}
      onPress={onPress}
      style={({ pressed }) => [reduce && pressed && { opacity: 0.7 }]}
    >
      <Animated.View
        style={{
          height: 30, paddingHorizontal: 12, borderRadius: 15, justifyContent: "center",
          backgroundColor: c.secondary, transform: [{ scale }],
        }}
      >
        <Text style={{ fontSize: 13.5, color: c.foreground }}>@ 谁</Text>
      </Animated.View>
    </Pressable>
  );
}

export function MentionSheet({ visible, ws, agentIds, onPick, onClose, onExited }: {
  visible: boolean;
  ws: WorkspaceSnapshot;
  /** 这个群此刻的名单（已与现存名册求过交集、名册顺序） */
  agentIds: string[];
  onPick: (agentId: string) => void;
  onClose: () => void;
  onExited?: () => void;
}) {
  return (
    <BottomSheet visible={visible} title="点谁接这一句" onClose={onClose} {...(onExited === undefined ? {} : { onExited })}>
      <ScrollView contentContainerStyle={{ padding: space.md }}>
        <Group footer={MENTION_FOOTER}>
          {agentIds.map((id) => (
            <AgentPickRow key={id} ws={ws} agentId={id} onPress={() => onPick(id)} />
          ))}
        </Group>
      </ScrollView>
    </BottomSheet>
  );
}
