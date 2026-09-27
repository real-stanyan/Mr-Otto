// 右上角那颗 ⊕ 点开的菜单（#1386，demo 的 plusMenu）：从那颗钮下面长出来（缩放原点在右上角，不是正中），
// 点外面收起。几样东西的岔路口，不是表单——所以是一张小卡，不是居中弹窗。
// 进场 150ms 缓出、从 .96 放大；关了动效只淡入。选了一样：先收菜单，等 Modal 真的退掉（onDismiss）再做——
// 下一样多半是另一个 Modal（新建智能体的弹窗），iOS 不许在一个正在退场的 Modal 上再叠一个。
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePalette } from "../theme.js";
import { useReduceMotion } from "../ui.js";
import { Icon, type IconName } from "./Icon.js";
import { TAB_HEADER_HEIGHT } from "./TabHeader.js";

export interface MenuItem {
  key: string;
  icon: IconName;
  label: string;
}

export function PlusMenu({ visible, items, onPick, onClose }: {
  visible: boolean;
  items: readonly MenuItem[];
  /** 选了一样：菜单收完之后才调 */
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const { c, isDark } = usePalette();
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const [mounted, setMounted] = useState(visible);
  const k = useRef(new Animated.Value(0)).current;
  const picked = useRef<string | null>(null);
  const pick = useRef(onPick);
  useEffect(() => {
    pick.current = onPick;
  }, [onPick]);
  const fire = (): void => {
    const key = picked.current;
    picked.current = null;
    if (key !== null) pick.current(key);
  };
  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(k, { toValue: 1, duration: 150, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
      return;
    }
    Animated.timing(k, { toValue: 0, duration: 110, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(({ finished }) => {
      if (!finished) return;
      setMounted(false);
      if (Platform.OS !== "ios") setTimeout(fire, 50);
    });
    // fire 只读 ref，不进依赖
  }, [visible, k]);
  if (!mounted && picked.current === null) return null;
  const scale = reduce ? 1 : k.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] });
  return (
    <Modal transparent visible={mounted} animationType="none" statusBarTranslucent onRequestClose={onClose} onDismiss={fire}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="收起菜单" />
      <Animated.View
        accessibilityViewIsModal
        style={{
          position: "absolute", right: 10, top: insets.top + TAB_HEADER_HEIGHT - 2, minWidth: 168,
          backgroundColor: isDark ? c.secondary : c.card, borderRadius: 12, paddingVertical: 4,
          shadowColor: "#281f0c", shadowOpacity: isDark ? 0.5 : 0.16, shadowRadius: 16, shadowOffset: { width: 0, height: 10 },
          opacity: k, transformOrigin: "top right", transform: [{ scale }],
        }}
      >
        {items.map((it, i) => (
          <View key={it.key}>
            {i > 0 ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: 46 }} /> : null}
            <Pressable
              accessibilityRole="menuitem"
              onPress={() => {
                picked.current = it.key;
                onClose();
              }}
              style={({ pressed }) => [
                { flexDirection: "row", alignItems: "center", gap: 12, height: 46, paddingHorizontal: 14 },
                pressed && { backgroundColor: c.press },
              ]}
            >
              <Icon name={it.icon} size={19} stroke={1.8} color={c.foreground} />
              <Text style={{ fontSize: 16, color: c.foreground }}>{it.label}</Text>
            </Pressable>
          </View>
        ))}
      </Animated.View>
    </Modal>
  );
}
