// 底部抽屉（#1356 A1，spec §4）：从下往上、定高 70%、下拽可关（落点（位置 + 动量投影）
// 过四分之一，或往下甩过 900pt/s，都关）；X 在左、标题绝对居中。第一个消费方是智能体设置
// 里的「换个形象」，A2 的「新建智能体」复用同一副骨架。
//
// · 用 reanimated 驱动位移、gesture-handler 接下拽（ADR-0293 决定 3：两者跟第一个抽屉
//   一起进）。手势回调跑在 JS 线程（`runOnJS(true)`）——少一层 worklet 与 JS 之间的来回，
//   这一屏没有重到需要把手势挪上 UI 线程的东西。
// · 下拽只挂在把手 + 标题那一条上：内容区常常是一块能滚的列表，两个手势抢同一个方向就是
//   「想往下滚却把抽屉拽下来了」。
// · 往上拉给阻尼（`rubberband`）：越拉越跟不动，趋近 24pt 但永远到不了，不是撞墙
//   （Apple 的越界手感）。
// · 进场是临界阻尼的弹簧（可打断：半路又拽回去时速度接得上），退场 220ms 缓出；
//   关了动效就直接到位（瞬切，不是「快一点」）。
// · `locked`（A2）：正在建的那几秒里拖不走、X 与暗幕与返回键都不理——半路关掉的话，行可能落了、
//   私聊可能建了，而人以为什么都没发生。
// · 「有值才画」的调用方同 dialog.tsx：先让 visible 变 false，在 onExited 里再卸。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  Easing, Extrapolation, interpolate, useAnimatedStyle, useSharedValue, withSpring, withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { projectMomentum, rubberband } from "../../../src/shared/gestureMath.js";
import { CloseGlyph } from "../chrome/Glyphs.js";
import { spring, type as t, usePalette, withAlpha } from "../theme.js";
import { useReduceMotion } from "../ui.js";

/** 占屏高的比例（spec §4：定高 70%） */
const HEIGHT_RATIO = 0.7;
/** 下拽超过自身高度的这一比例就关 */
const DISMISS_DISTANCE = 0.25;
/** 或者松手时往下的速度（pt/s）超过这个——一甩就该关，不必拖过阈值 */
const DISMISS_VELOCITY = 900;
/** 往上越界的阻尼：初始跟手 0.2 倍、越拉越跟不动，永远到不了 24pt（不是撞墙） */
const RUBBER_MAX = 24;
const RUBBER_SLOPE = 0.2;
const EXIT_MS = 220;
const OPEN_SPRING = spring(0.35);
const RADIUS = 22;

export function BottomSheet({ visible, title, onClose, onExited, closeLabel = "关闭", locked = false, children }: {
  visible: boolean;
  title: string;
  /** 人要关：点 X / 点暗幕 / 下拽过阈值或一甩。调用方把 visible 置 false */
  onClose: () => void;
  /** 退场放完之后调一次 */
  onExited?: () => void;
  /** 左上那颗 X 念什么（读屏）。缺省「关闭」；「新建智能体」那张写「不建了」（demo） */
  closeLabel?: string;
  /** 锁住：拖不走、X / 暗幕 / 返回键都不理（见头注） */
  locked?: boolean;
  children: ReactNode;
}) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const sheetH = Math.round(height * HEIGHT_RATIO);
  const [mounted, setMounted] = useState(visible);
  /** 0 = 完全展开；sheetH = 完全收起 */
  const y = useSharedValue(sheetH);
  const exited = useRef(onExited);
  useEffect(() => {
    exited.current = onExited;
  }, [onExited]);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      y.value = reduce ? 0 : withSpring(0, OPEN_SPRING);
      return;
    }
    if (!mounted) return;
    y.value = reduce ? sheetH : withTiming(sheetH, { duration: EXIT_MS, easing: Easing.out(Easing.quad) });
    // 退场的收尾挂一个 JS 定时器，不从动画回调里回 JS：少一次 worklet → JS 的来回，
    // 时长本来就是我们自己定的
    const timer = setTimeout(() => {
      setMounted(false);
      exited.current?.();
    }, reduce ? 0 : EXIT_MS + 20);
    return () => clearTimeout(timer);
    // 只跟 visible 走：mounted / sheetH / reduce 读的是这一刻的值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const requestClose = (): void => {
    if (!locked) onClose();
  };

  const pan = Gesture.Pan()
    .enabled(!locked)
    .runOnJS(true)
    .onUpdate((e) => {
      y.value = e.translationY >= 0 ? e.translationY : rubberband(e.translationY, RUBBER_MAX, RUBBER_SLOPE);
    })
    .onEnd((e) => {
      // 关不关看落点不看松手那一刻：位置 + 速度衰减完还会走的那段。拖过一半又往回甩 = 不关
      const landing = e.translationY + projectMomentum(e.velocityY);
      if (e.velocityY > DISMISS_VELOCITY || landing > sheetH * DISMISS_DISTANCE) {
        onClose();
        return;
      }
      y.value = reduce ? 0 : withSpring(0, { ...OPEN_SPRING, velocity: e.velocityY });
    });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(y.value, [0, sheetH], [1, 0], Extrapolation.CLAMP),
  }));

  if (!mounted) return null;
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={requestClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }, scrimStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={requestClose} accessibilityRole="button" accessibilityLabel="关闭" />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          style={[
            {
              position: "absolute", left: 0, right: 0, bottom: 0, height: sheetH,
              backgroundColor: c.card, borderTopLeftRadius: RADIUS, borderTopRightRadius: RADIUS,
              borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, paddingBottom: insets.bottom, overflow: "hidden",
            },
            sheetStyle,
          ]}
        >
          <GestureDetector gesture={pan}>
            <View>
              <View style={{ alignItems: "center", paddingTop: 8 }}>
                <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: c.foreground, opacity: 0.18 }} />
              </View>
              <View style={{ height: 52, justifyContent: "center", paddingHorizontal: 60 }}>
                <Text accessibilityRole="header" style={{ ...t.headline, color: c.foreground, textAlign: "center" }} numberOfLines={1}>{title}</Text>
              </View>
              <Pressable
                accessibilityRole="button" accessibilityLabel={closeLabel} accessibilityState={{ disabled: locked }}
                disabled={locked} hitSlop={10} onPress={onClose}
                style={({ pressed }) => [
                  {
                    position: "absolute", left: 12, top: 21, width: 36, height: 36, borderRadius: 18,
                    alignItems: "center", justifyContent: "center", backgroundColor: withAlpha(c.foreground, 0.07),
                  },
                  pressed && { opacity: 0.6 },
                  locked && { opacity: 0.4 },
                ]}
              >
                <CloseGlyph color={c.foreground} size={13} />
              </Pressable>
            </View>
          </GestureDetector>
          <View style={{ flex: 1 }}>{children}</View>
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}
