// 从底下升起来的几个选项（#1386，demo 的 avatarSheet：换头像）：在几样里挑一样是选择器，按规矩走底部
// （维护者：表单 / 确认用居中弹窗，选择器照旧）。几行选项一组、隔一道地面、底下单独一行「取消」（iOS 的动作单）。
// 进场 260ms 缓出、从下往上；关了动效只淡入。点暗幕、点取消都是不选。选了一样：先收起，**等 Modal 真的
// 退掉（onDismiss）再做**——选完多半要开系统相册，而 iOS 不许在一个正在退场的 Modal 上再叠一个系统界面：
// 动画放完就调的话相册悄悄不出来（模拟器上撞见过，一个字的报错都没有）。
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePalette } from "../theme.js";
import { useReduceMotion } from "../ui.js";

export interface SheetOption {
  key: string;
  label: string;
  tone?: "destructive";
}

export function ActionSheet({ visible, title, options, onPick, onClose }: {
  visible: boolean;
  title?: string;
  options: readonly SheetOption[];
  /** 选了一样：收完之后才调 */
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const { c } = usePalette();
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const [mounted, setMounted] = useState(visible);
  const k = useRef(new Animated.Value(0)).current;
  const picked = useRef<string | null>(null);
  const pick = useRef(onPick);
  useEffect(() => {
    pick.current = onPick;
  }, [onPick]);
  /** Modal 真的退掉之后才做选中的那一样（见文件头）；安卓没有 onDismiss，退场放完隔一拍再做 */
  const fire = (): void => {
    const key = picked.current;
    picked.current = null;
    if (key !== null) pick.current(key);
  };
  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(k, { toValue: 1, duration: 260, easing: Easing.bezier(0.32, 0.72, 0, 1), useNativeDriver: true }).start();
      return;
    }
    Animated.timing(k, { toValue: 0, duration: 200, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(({ finished }) => {
      if (!finished) return;
      setMounted(false);
      if (Platform.OS !== "ios") setTimeout(fire, 50);
    });
    // fire 只读 ref，不进依赖
  }, [visible, k]);
  if (!mounted && picked.current === null) return null;
  const shift = reduce ? 0 : k.interpolate({ inputRange: [0, 1], outputRange: [320, 0] });
  const row = (label: string, onPress: () => void, color: string, key: string, first: boolean) => (
    <View key={key}>
      {first ? null : <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />}
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [{ height: 56, alignItems: "center", justifyContent: "center" }, pressed && { backgroundColor: c.press }]}
      >
        <Text style={{ fontSize: 17, color }}>{label}</Text>
      </Pressable>
    </View>
  );
  return (
    <Modal transparent visible={mounted} animationType="none" statusBarTranslucent onRequestClose={onClose} onDismiss={fire}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim, opacity: k }]} />
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="取消" />
      <Animated.View
        accessibilityViewIsModal
        style={{
          position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: c.background,
          borderTopLeftRadius: 14, borderTopRightRadius: 14, overflow: "hidden", paddingBottom: insets.bottom,
          opacity: reduce ? k : 1, transform: [{ translateY: shift }],
        }}
      >
        <View style={{ backgroundColor: c.card }}>
          {title !== undefined ? (
            <Text style={{ fontSize: 13, color: c.mutedForeground, textAlign: "center", paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }}>
              {title}
            </Text>
          ) : null}
          {options.map((o, i) =>
            row(o.label, () => {
              picked.current = o.key;
              onClose();
            }, o.tone === "destructive" ? c.destructive : c.foreground, o.key, i === 0),
          )}
        </View>
        <View style={{ height: 8 }} />
        <View style={{ backgroundColor: c.card }}>{row("取消", onClose, c.mutedForeground, "cancel", true)}</View>
      </Animated.View>
    </Modal>
  );
}
