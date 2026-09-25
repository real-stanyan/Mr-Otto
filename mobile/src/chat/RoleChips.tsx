// 六句现成的话（#1356 A2，spec §5.5）：只在它等着我说它是干什么的时候画，挂在它第一句话底下
// （判据 shared/agentOnboarding.ts 的 roleChipsAnchor）。点一下**只填进输入框、不发出去**——一颗点了
// 就不可撤销的钮，人多半想先改两个字（demo 那条纪律）。chip 上是几个字的称呼，填进去的是一整句
// （ROLE_PRESETS 的 label / text）。按下缩到 .96（demo 的 .chip:active），关了动效退成变暗。
import { useRef } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import { ROLE_PRESETS } from "../../../src/shared/agentOnboarding.js";
import { PRESS_SPRING, usePalette } from "../theme.js";
import { useReduceMotion } from "../ui.js";

function Chip({ label, onPress }: { label: string; onPress: () => void }) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number): void => {
    if (!reduce) Animated.spring(scale, { toValue: v, useNativeDriver: true, ...PRESS_SPRING }).start();
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="填进输入框，不会直接发出去"
      onPressIn={() => to(0.96)}
      onPressOut={() => to(1)}
      onPress={onPress}
      style={({ pressed }) => [reduce && pressed && { opacity: 0.7 }]}
    >
      <Animated.View
        style={{
          height: 34, paddingHorizontal: 13, borderRadius: 17, justifyContent: "center",
          backgroundColor: c.secondary, transform: [{ scale }],
        }}
      >
        <Text style={{ fontSize: 13.5, color: c.foreground }}>{label}</Text>
      </Animated.View>
    </Pressable>
  );
}

export function RoleChips({ onPick }: { onPick: (text: string) => void }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingTop: 2 }}>
      {ROLE_PRESETS.map((p) => (
        <Chip key={p.label} label={p.label} onPress={() => onPick(p.text)} />
      ))}
    </View>
  );
}
