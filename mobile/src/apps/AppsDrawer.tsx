// 主页下拉出来的应用抽屉（#1648，参考微信下拉小程序）：整屏从上往下盖下来——搜索、「最近使用」一排、「我的应用」格子。
// 走 Modal（同 SidePanel：盖得住底栏）；往上划或点底下那条收起。点一个先收、退场完再推应用页（Modal 盖着时推的页看不见）。
import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { AppRow } from "../../../src/shared/apps.js";
import { recentApps, searchApps } from "../../../src/shared/appsDrawer.js";
import { spring, usePalette, withAlpha } from "../theme.js";
import { useReduceMotion } from "../ui.js";
import { Icon } from "../wx/Icon.js";
import { refreshApps, useApps } from "./appsStore.js";
import { useRecentApps } from "./recentApps.js";

const EXIT_MS = 220;
const OPEN_SPRING = spring(0.35);

function AppIcon({ app, onPress }: { app: AppRow; onPress: () => void }) {
  const { c } = usePalette();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`打开 ${app.name}`} onPress={onPress} style={({ pressed }) => [{ width: "25%", alignItems: "center", gap: 6, paddingVertical: 8 }, pressed && { opacity: 0.6 }]}>
      <View style={{ width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center", backgroundColor: withAlpha(c.foreground, 0.08) }}>
        <Text style={{ fontSize: 28 }}>{app.icon}</Text>
      </View>
      <Text numberOfLines={1} style={{ fontSize: 13, color: c.foreground, maxWidth: 76 }}>{app.name}</Text>
    </Pressable>
  );
}

export function AppsDrawer({ visible, onClose, onPick }: { visible: boolean; onClose: () => void; onPick: (appId: string) => void }) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [mounted, setMounted] = useState(visible);
  const [q, setQ] = useState("");
  const y = useSharedValue(-height);
  const picked = useRef<string | null>(null);
  const apps = useApps();
  const recent = useRecentApps();

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setQ("");
      void refreshApps();
      y.value = reduce ? 0 : withSpring(0, OPEN_SPRING);
      return;
    }
    if (!mounted) return;
    const done = (): void => {
      setMounted(false);
      const id = picked.current;
      picked.current = null;
      if (id !== null) onPick(id);
    };
    if (reduce) {
      y.value = -height;
      done();
      return;
    }
    y.value = withTiming(-height, { duration: EXIT_MS, easing: Easing.out(Easing.cubic) });
    const timer = setTimeout(done, EXIT_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reduce, height, y]);

  const pan = Gesture.Pan()
    .activeOffsetY([-12, 999])
    .failOffsetX([-10, 10])
    .runOnJS(true)
    .onUpdate((e) => { y.value = Math.min(0, e.translationY); })
    .onEnd((e) => {
      if (e.velocityY < -600 || e.translationY < -height * 0.2) { onClose(); return; }
      y.value = reduce ? 0 : withSpring(0, OPEN_SPRING);
    });
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));

  if (!mounted) return null;
  const all = apps.apps ?? [];
  const searching = q.trim() !== "";
  const shown = searchApps(all, q);
  const recents = recentApps(recent, all);
  const pick = (id: string): void => { picked.current = id; onClose(); };

  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View accessibilityViewIsModal style={[StyleSheet.absoluteFill, { backgroundColor: c.background, paddingTop: insets.top + 12 }, style]}>
          <Text accessibilityRole="header" style={{ fontSize: 17, fontWeight: "600", color: c.foreground, textAlign: "center", marginBottom: 14 }}>应用</Text>
          <View style={{ marginHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 8, height: 38, borderRadius: 10, paddingHorizontal: 12, backgroundColor: withAlpha(c.foreground, 0.06) }}>
            <Icon name="search" size={16} stroke={2} color={c.faint} />
            <TextInput value={q} onChangeText={setQ} placeholder="搜索应用" placeholderTextColor={c.faint} style={{ flex: 1, fontSize: 16, color: c.foreground }} />
          </View>
          <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 18, paddingBottom: 24, gap: 18 }}>
            {apps.apps === null ? (
              <Text style={{ fontSize: 14, color: c.mutedForeground, textAlign: "center", marginTop: 24 }}>{apps.error ?? "正在读…"}</Text>
            ) : all.length === 0 ? (
              <Text style={{ fontSize: 14, lineHeight: 21, color: c.mutedForeground, textAlign: "center", marginTop: 24, paddingHorizontal: 24 }}>
                还没有应用。跟管理员说一句「给我做个记账本」，它会派应用专员做好放这儿。
              </Text>
            ) : searching ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
                {shown.length === 0 ? <Text style={{ fontSize: 14, color: c.mutedForeground, marginLeft: 8 }}>{`没有找到「${q.trim()}」`}</Text> : shown.map((a) => <AppIcon key={a.id} app={a} onPress={() => pick(a.id)} />)}
              </View>
            ) : (
              <>
                {recents.length > 0 ? (
                  <View style={{ gap: 4 }}>
                    <Text style={{ fontSize: 13, color: c.mutedForeground, marginLeft: 8 }}>最近使用</Text>
                    <View style={{ flexDirection: "row", flexWrap: "wrap" }}>{recents.slice(0, 8).map((a) => <AppIcon key={`r-${a.id}`} app={a} onPress={() => pick(a.id)} />)}</View>
                  </View>
                ) : null}
                <View style={{ gap: 4 }}>
                  <Text style={{ fontSize: 13, color: c.mutedForeground, marginLeft: 8 }}>我的应用</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap" }}>{all.map((a) => <AppIcon key={a.id} app={a} onPress={() => pick(a.id)} />)}</View>
                </View>
              </>
            )}
          </ScrollView>
          <GestureDetector gesture={pan}>
            <Pressable accessibilityRole="button" accessibilityLabel="收起" onPress={onClose} style={{ alignItems: "center", paddingTop: 10, paddingBottom: insets.bottom + 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border }}>
              <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: withAlpha(c.foreground, 0.2), marginBottom: 6 }} />
              <Text style={{ fontSize: 13, color: c.mutedForeground }}>上划或点这里回到聊天</Text>
            </Pressable>
          </GestureDetector>
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}
