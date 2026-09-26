// 一只智能体占一行（#1356 A3，spec §5.6）：脸（s 档）| 名字 + 职责 | 右边一格（勾 / 「移出」/ 空）。
// 建群那一列、群设置的「里面有谁」、「加一只」与「@ 谁」两张抽屉共用这一副（demo 的 .row / .opt 同一个形状）。
// 能点的时候按下整行变色、不缩放（列表行的语汇，同 ui.tsx 的 Row）；`checked` 在场 = 这是一格勾选
// （读屏念「复选框，已选中」）。按不动时整行压到 .45（demo 与桌面建群弹窗同一个透明度）。
// 调用方递进来的都是与名册求过交集的 id，名字与职责现查名册。
import { useRef, type ReactNode } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { agentFaceSlot } from "../../../src/shared/agentAvatar.js";
import { agentNameOf } from "../../../src/shared/workspaceView.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { Face } from "../face/Face.js";
import { type as t, usePalette } from "../theme.js";

export function AgentPickRow({ ws, agentId, trailing, onPress, disabled = false, checked }: {
  ws: WorkspaceSnapshot;
  agentId: string;
  trailing?: ReactNode;
  /** 缺席 = 这一行本身不能点（右边那颗钮自己接手指） */
  onPress?: () => void;
  disabled?: boolean;
  /** 在场 = 勾选行 */
  checked?: boolean;
}) {
  const { c } = usePalette();
  const hi = useRef(new Animated.Value(0)).current;
  const name = agentNameOf(ws, agentId);
  const description = ws.agents.find((a) => a.agentId === agentId)?.description ?? "";
  // 按下那一帧就变色（setValue，不是动画）；松手才淡出——同 ui.tsx 的 Row
  const press = (down: boolean): void => {
    if (down) return hi.setValue(1);
    Animated.timing(hi, { toValue: 0, duration: 250, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  };
  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 9, minHeight: 52 }}>
      <Face slot={agentFaceSlot(ws, agentId)} tier="s" />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text numberOfLines={1} style={{ ...t.body, fontWeight: "600", color: c.foreground }}>{name}</Text>
        {description !== "" ? (
          <Text numberOfLines={1} style={{ ...t.footnote, color: c.mutedForeground }}>{description}</Text>
        ) : null}
      </View>
      {trailing}
    </View>
  );
  if (onPress === undefined) return <View style={disabled ? { opacity: 0.45 } : undefined}>{body}</View>;
  return (
    <Pressable
      accessibilityRole={checked === undefined ? "button" : "checkbox"}
      accessibilityLabel={description !== "" ? `${name}，${description}` : name}
      accessibilityState={checked === undefined ? { disabled } : { disabled, checked }}
      disabled={disabled}
      onPressIn={() => press(true)}
      onPressOut={() => press(false)}
      onPress={onPress}
      style={disabled ? { opacity: 0.45 } : undefined}
    >
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: c.muted, opacity: hi }]} />
      {body}
    </Pressable>
  );
}
