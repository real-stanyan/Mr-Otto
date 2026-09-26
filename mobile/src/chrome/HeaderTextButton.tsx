// 原生导航条右边那颗字钮（#1356 A1 起智能体设置的「存」，A3 加了建群的「建」、群设置的「存」）：
// 按不动时弱色，正在做时由调用方换字。挂法：`navigation.setOptions({ headerRight: () => <HeaderTextButton … /> })`，
// 调用方只在「按不按得动 / 正在做」变了时重设（不带依赖地每次渲染都 setOptions，会让导航器跟着重渲、再触发
// 调用方，形成死循环），按下去调的是 ref 里最新的那个函数。
import { Pressable, Text } from "react-native";
import { type as t, usePalette } from "../theme.js";

export function HeaderTextButton({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }) {
  const { c } = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={10}
      onPress={onPress}
      style={({ pressed }) => [pressed && { opacity: 0.6 }]}
    >
      <Text style={{ ...t.headline, color: disabled ? c.mutedForeground : c.brand }}>{label}</Text>
    </Pressable>
  );
}
