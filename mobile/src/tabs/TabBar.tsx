// 底部三格（#1386，demo 的 .tabbar）：聊天 / 通讯录 / 我。
// · 当前那一格点缀色、图标描边粗一档（2 vs 1.6）——颜色之外再给一个不靠颜色的区别；
// · 角标是点缀色不是红（DESIGN.md：红只说「出事了」）：「聊天」= 有新消息的聊天有几条，
//   「通讯录」= 别人加我、还没处理的；
// · 再点一下当前那一格 = 回到顶上（react-navigation 的 tabPress 默认行为 + 各页 useScrollToTop）。
// 底是 side 色实底 + 上沿一道细线：页签屏的内容不从它底下滚过去，所以不做半透明（透过去什么都看不到）。
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePalette } from "../theme.js";
import { CountBadge } from "../wx/Badge.js";
import { Icon, type IconName } from "../wx/Icon.js";

const TABS: Record<string, { icon: IconName; label: string }> = {
  Chats: { icon: "message-circle", label: "聊天" },
  Contacts: { icon: "contact-round", label: "通讯录" },
  Me: { icon: "user-round", label: "我" },
};

export const TAB_BAR_HEIGHT = 49;

export function TabBar({ state, navigation, badges }: BottomTabBarProps & { badges: Readonly<Record<string, number>> }) {
  const { c } = usePalette();
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row", height: TAB_BAR_HEIGHT + insets.bottom, paddingBottom: insets.bottom,
        backgroundColor: c.side, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border,
      }}
    >
      {state.routes.map((route, index) => {
        const meta = TABS[route.name];
        if (meta === undefined) return null;
        const on = state.index === index;
        const badge = badges[route.name] ?? 0;
        const color = on ? c.brand : c.mutedForeground;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={badge > 0 ? `${meta.label}，${badge} 条新的` : meta.label}
            onPress={() => {
              const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
              if (!on && !event.defaultPrevented) navigation.navigate(route.name, route.params);
            }}
            style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 2 }}
          >
            <View>
              <Icon name={meta.icon} size={25} stroke={on ? 2 : 1.6} color={color} />
              {badge > 0 ? (
                <View style={{ position: "absolute", top: -5, left: 15 }}>
                  <CountBadge n={badge} ring={c.side} />
                </View>
              ) : null}
            </View>
            <Text style={{ fontSize: 10.5, fontWeight: "500", color }}>{meta.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
