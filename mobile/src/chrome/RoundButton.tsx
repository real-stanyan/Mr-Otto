// 浮在内容上的圆钮（demo 的 .rbtn）：44 的毛玻璃圆，按下缩到 .93。名册头上那三颗、聊天页的
// 回退 / 设置都是它（spec §4）。毛玻璃 = expo-blur 一层 + 前景色 10% 叠一层（demo：
// color-mix(fg 10%, glass)）——只有 blur 的话浅色底上它会淡到看不见边。
// 关了动效时，按下的反馈退成变暗——反馈本身不能没有（同 ui.tsx 的 Button）。
import { BlurView } from "expo-blur";
import { useRef, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { PRESS_SPRING, usePalette, withAlpha } from "../theme.js";
import { useReduceMotion } from "../ui.js";

export const ROUND_BUTTON_SIZE = 44;

export function RoundButton({ children, onPress, label }: {
  children: ReactNode;
  onPress: () => void;
  label: string;
}) {
  const { c, isDark } = usePalette();
  const reduce = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number): void => {
    if (!reduce) Animated.spring(scale, { toValue: v, useNativeDriver: true, ...PRESS_SPRING }).start();
  };
  return (
    <Pressable
      accessibilityRole="button" accessibilityLabel={label} hitSlop={6}
      onPressIn={() => to(0.93)} onPressOut={() => to(1)} onPress={onPress}
      style={({ pressed }) => [reduce && pressed && { opacity: 0.7 }]}
    >
      <Animated.View style={[styles.disc, { transform: [{ scale }] }]}>
        <BlurView intensity={40} tint={isDark ? "dark" : "light"} style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(c.foreground, 0.1) }]} />
        <View style={styles.center}>{children}</View>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  disc: {
    width: ROUND_BUTTON_SIZE, height: ROUND_BUTTON_SIZE, borderRadius: ROUND_BUTTON_SIZE / 2, overflow: "hidden",
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
