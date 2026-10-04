// 从左边滑出来的侧页（#1574，照微信「收藏」那一页）：整页从左缘滑进来盖住底下的列表，右边留一条暗的边
// （点它收回）；往左拽过四分之一或一甩也收回；右上角一枚圆形「<」。
//
// · 走 Modal（同 BottomSheet）：聊天页在页签导航器里，不走 Modal 盖不住底栏——微信的侧页也是盖住底栏的。
//   代价是底下的列表不能跟着「被推到右边」，右边那条边是暗幕不是列表本身；接受。
// · 开的手势（从左缘右划）不在这里——那是底下那一页的事（ChatsScreen 的 edge pan），识别到就把 visible 置 true，
//   侧页弹簧进场；不做「跟着手指一点点拉开」（Modal 装不下那种半开状态）。
// · 关的手势挂在整页上（横向，activeOffsetX 负向），不跟里面的纵向列表抢。
// · 「有值才画」同 dialog.tsx：先让 visible 变 false，onExited 里再做收尾（比如推下一页——Modal 还盖着时推的页看不见）。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { Easing, Extrapolation, interpolate, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { projectMomentum } from "../../../src/shared/gestureMath.js";
import { spring, type as t, usePalette, withAlpha } from "../theme.js";
import { useReduceMotion } from "../ui.js";
import { Icon } from "./Icon.js";

/** 右边露出来的那条边（微信约 1/10 屏宽） */
export const SIDE_PANEL_PEEK = 44;
const DISMISS_DISTANCE = 0.25;
const DISMISS_VELOCITY = 900;
const EXIT_MS = 220;
const OPEN_SPRING = spring(0.35);
/** 底下那一页从左缘多宽以内起手算「开侧页」 */
export const SIDE_PANEL_EDGE = 28;

export function SidePanel({ visible, title, onClose, onExited, children }: {
  visible: boolean;
  title: string;
  onClose: () => void;
  onExited?: () => void;
  children: ReactNode;
}) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const panelW = width - SIDE_PANEL_PEEK;
  const [mounted, setMounted] = useState(visible);
  const x = useSharedValue(-panelW);
  const exited = useRef(onExited);
  exited.current = onExited;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      x.value = reduce ? 0 : withSpring(0, OPEN_SPRING);
      return;
    }
    if (!mounted) return;
    const done = (): void => {
      setMounted(false);
      exited.current?.();
    };
    if (reduce) {
      x.value = -panelW;
      done();
      return;
    }
    x.value = withTiming(-panelW, { duration: EXIT_MS, easing: Easing.out(Easing.cubic) });
    const timer = setTimeout(done, EXIT_MS);
    return () => clearTimeout(timer);
    // mounted 只在这里改，不进依赖：它变了不该再起一次退场
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reduce, panelW, x]);

  const pan = Gesture.Pan()
    .activeOffsetX([-12, 999])
    .failOffsetY([-10, 10])
    .runOnJS(true)
    .onUpdate((e) => {
      x.value = Math.min(0, e.translationX);
    })
    .onEnd((e) => {
      const landing = -(e.translationX + projectMomentum(e.velocityX));
      if (e.velocityX < -DISMISS_VELOCITY || landing > panelW * DISMISS_DISTANCE) {
        onClose();
        return;
      }
      x.value = reduce ? 0 : withSpring(0, { ...OPEN_SPRING, velocity: e.velocityX });
    });

  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: interpolate(x.value, [-panelW, 0], [0, 1], Extrapolation.CLAMP) }));

  if (!mounted) return null;
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }, scrimStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="收起" />
        </Animated.View>
        <GestureDetector gesture={pan}>
          <Animated.View
            accessibilityViewIsModal
            style={[
              { position: "absolute", left: 0, top: 0, bottom: 0, width: panelW, backgroundColor: c.background, paddingTop: insets.top, paddingBottom: insets.bottom },
              panelStyle,
            ]}
          >
            <View style={{ height: 52, flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 12 }}>
              <Text accessibilityRole="header" numberOfLines={1} style={{ ...t.title, fontSize: 24, fontWeight: "700", color: c.foreground, flex: 1 }}>{title}</Text>
              <Pressable
                accessibilityRole="button" accessibilityLabel="收起" hitSlop={10} onPress={onClose}
                style={({ pressed }) => [
                  { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: withAlpha(c.foreground, 0.07) },
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Icon name="chevron-left" size={18} stroke={2.2} color={c.foreground} />
              </Pressable>
            </View>
            <View style={{ flex: 1 }}>{children}</View>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}
