// 一句轻提示（#1386，demo 的 toast）：「申请已发出」「头像换好了」这种做完了、不需要人再做什么的话。
// 2.2 秒后淡出；只有一条（新的顶掉旧的）。要人做决定的一律不走这里（那是弹窗）。
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Animated, Easing, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { createStore } from "../externalStore.js";
import { usePalette } from "../theme.js";

const store = createStore<{ text: string | null; seq: number }>({ text: null, seq: 0 });

export function toast(text: string): void {
  store.set((s) => ({ text, seq: s.seq + 1 }));
}

export function ToastHost() {
  const { c, isDark } = usePalette();
  const insets = useSafeAreaInsets();
  const s = useSyncExternalStore(store.subscribe, store.get);
  const k = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (s.text === null) return;
    k.setValue(0);
    const anim = Animated.sequence([
      Animated.timing(k, { toValue: 1, duration: 160, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.delay(2200),
      Animated.timing(k, { toValue: 0, duration: 220, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]);
    anim.start(({ finished }) => {
      if (finished) store.set({ text: null });
    });
    return () => anim.stop();
  }, [s.seq, s.text, k]);
  if (s.text === null) return null;
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 24, right: 24, bottom: insets.bottom + 110, alignItems: "center" }}>
      <Animated.View
        accessibilityLiveRegion="polite"
        style={{
          maxWidth: "100%", paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12,
          backgroundColor: isDark ? c.secondary : c.card, opacity: k,
          transform: [{ translateY: k.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }],
          shadowColor: "#281f0c", shadowOpacity: isDark ? 0.5 : 0.16, shadowRadius: 16, shadowOffset: { width: 0, height: 8 },
        }}
      >
        <Text style={{ fontSize: 14, color: c.foreground, textAlign: "center" }}>{s.text}</Text>
      </Animated.View>
    </View>
  );
}
