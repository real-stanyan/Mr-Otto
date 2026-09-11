// 三栏的页签栏。浮在内容上的一层毛玻璃（demo 的 .tabbar：blur + 半透明 + 顶上一道细线），
// 内容从它底下滚过去——滚动容器自己让出 useTabInset() 那么高（ui.tsx 的 Page 已经让了）。
// 选中只靠颜色和线宽，不加下划线 / 底色；按下时图标缩到 .88（demo 同值）。
import { useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Icon, type IconName } from "../icons.js";
import { PRESS_SPRING, usePalette } from "../theme.js";
import { useReduceMotion } from "../ui.js";
import { TAB_BAR_HEIGHT, useTabChrome } from "../chrome.js";

const META: Record<string, { label: string; icon: IconName }> = {
  TasksTab: { label: "任务", icon: "spark" },
  ProjectsTab: { label: "项目", icon: "folder" },
  TeamsTab: { label: "团队", icon: "people" },
};

export function OttoTabBar({ state, navigation }: BottomTabBarProps) {
  const { c } = usePalette();
  const insets = useSafeAreaInsets();
  const { hidden } = useTabChrome();
  if (hidden) return null;
  return (
    <View style={{
      position: "absolute", left: 0, right: 0, bottom: 0,
      height: TAB_BAR_HEIGHT + insets.bottom, paddingBottom: insets.bottom,
      flexDirection: "row",
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border,
    }}>
      <BlurView tint="systemChromeMaterial" intensity={100} style={StyleSheet.absoluteFill} />
      {state.routes.map((route, i) => {
        const meta = META[route.name];
        if (!meta) return null;
        const focused = state.index === i;
        return (
          <TabButton
            key={route.key} label={meta.label} icon={meta.icon} focused={focused}
            onPress={() => {
              const e = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
              if (!focused && !e.defaultPrevented) navigation.navigate(route.name, route.params);
            }}
          />
        );
      })}
    </View>
  );
}

function TabButton({ label, icon, focused, onPress }: {
  label: string;
  icon: IconName;
  focused: boolean;
  onPress: () => void;
}) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  // 反馈挂在按下上，不是抬手；关了动效就不缩（颜色变化本身还在）
  const to = (v: number): void => {
    if (!reduce) Animated.spring(scale, { toValue: v, useNativeDriver: true, ...PRESS_SPRING }).start();
  };
  const color = focused ? c.foreground : c.mutedForeground;
  return (
    <Pressable
      accessibilityRole="tab" accessibilityState={{ selected: focused }} accessibilityLabel={label}
      onPressIn={() => to(0.88)} onPressOut={() => to(1)} onPress={onPress}
      style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 3 }}
    >
      <Animated.View style={{ transform: [{ scale }] }}>
        <Icon name={icon} size={24} stroke={focused ? 2 : 1.7} color={color} />
      </Animated.View>
      <Text style={{ fontSize: 10.5, lineHeight: 13, letterSpacing: 0.1, fontWeight: focused ? "600" : "500", color }}>
        {label}
      </Text>
    </Pressable>
  );
}
