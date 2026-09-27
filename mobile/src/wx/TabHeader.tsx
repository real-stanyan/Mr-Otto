// 页签根的页头（#1386，demo 的 .nav）：标题压在整条栏的正中（不随右边那颗漂），右边一颗图标钮。
// 推进来的页用原生导航条；页签根自己画，是因为底栏那一层没有原生导航条可借。
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePalette } from "../theme.js";

export const TAB_HEADER_HEIGHT = 44;

export function TabHeader({ title, right }: { title: string; right?: ReactNode }) {
  const { c } = usePalette();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingTop: insets.top, backgroundColor: c.background }}>
      <View style={{ height: TAB_HEADER_HEIGHT, alignItems: "center", justifyContent: "center" }}>
        <Text accessibilityRole="header" numberOfLines={1} style={{ fontSize: 17, fontWeight: "600", letterSpacing: -0.2, color: c.foreground, maxWidth: "60%" }}>
          {title}
        </Text>
        {right !== undefined ? <View style={{ position: "absolute", right: 6, top: 0, bottom: 0, justifyContent: "center" }}>{right}</View> : null}
      </View>
    </View>
  );
}

/** 页头里的一颗图标钮（demo 的 .nbtn）：40×40，按下变淡（不缩放——它小到缩放看不出来） */
export function HeaderIconButton({ label, onPress, children }: { label: string; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [{ width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 10 }, pressed && { opacity: 0.45 }]}
    >
      {children}
    </Pressable>
  );
}
