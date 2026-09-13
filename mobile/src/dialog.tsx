// 居中弹窗（demo 的 .dlg，同桌面 AlertDialog）：表单与确认一律用它，不用底部抽屉（spec §3.2）。
//
// 只受控：没有「点遮罩关」，出口只有里面的按钮——一个正在收信的人手一抖就得从头再来。
// 进场从 .96 放到 1 + 淡入（不从 0 起：现实里没有东西从「没有」里长出来），退场更快：
// .98 + 淡出 140ms。关了动效就只淡入淡出。
// 「有值才画」的弹窗（{x ? <X/> : null}）不能在按钮里直接把自己卸掉——整棵子树当场消失，
// visible=false 送不到这里，退场那 140ms 永远跑不到。按钮先让 visible 变 false，onExited 里再卸。
// 键盘弹起时居中的是键盘上面那块：Modal 里的 KeyboardAvoidingView 量的是整屏坐标，
// 没有 ui.tsx 里 useKeyboardInset 说的那个「相对父级」的坑。
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Animated, Easing, KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, View, useWindowDimensions,
} from "react-native";
import { spring, type as t, usePalette } from "./theme.js";
import { Button, useReduceMotion } from "./ui.js";

const WIDTH = 320;
const RADIUS = 22;

export function Dialog({ visible, onExited, children }: {
  visible: boolean;
  /** 退场放完、Modal 收起之后调一次：「有值才画」的调用方在这里才真的把自己卸掉 */
  onExited?: () => void;
  children: ReactNode;
}) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const { width } = useWindowDimensions();
  const [mounted, setMounted] = useState(visible);
  /** 0 = 收着，1 = 摊开。暗幕的透明度、卡的透明度与缩放都挂在它上面 */
  const k = useRef(new Animated.Value(0)).current;
  /** 这一次开过没有：初次挂载就是 visible=false 的弹窗从没出现过，不该收到 onExited */
  const opened = useRef(false);
  /** onExited 的最新一份：退场回调在 140ms 之后才跑，不能拿开始退场那一帧的闭包 */
  const exited = useRef(onExited);
  useEffect(() => {
    exited.current = onExited;
  }, [onExited]);

  useEffect(() => {
    if (visible) {
      opened.current = true;
      setMounted(true);
      const enter = Animated.spring(k, { toValue: 1, useNativeDriver: true, ...spring(0.28) });
      enter.start();
      return () => enter.stop();
    }
    if (!opened.current) return;
    const exit = Animated.timing(k, {
      toValue: 0, duration: 140, easing: Easing.out(Easing.quad), useNativeDriver: true,
    });
    exit.start(({ finished }) => {
      if (!finished) return;
      opened.current = false;
      setMounted(false);
      exited.current?.();
    });
    // 半路被打断（又要开 / 整个卸载）就停在原地：又要开的那段从当前值接着走，卸载了就什么都不再调
    return () => exit.stop();
  }, [visible, k]);

  if (!mounted) return null;
  const scale = reduce ? 1 : k.interpolate({ inputRange: [0, 1], outputRange: [visible ? 0.96 : 0.98, 1] });
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={() => {}}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim, opacity: k }]} />
      {/* 退场途中不接手指：已经在关的弹窗再被点一下「发送」，就是一次谁都看不见的请求 */}
      <KeyboardAvoidingView
        pointerEvents={visible ? "auto" : "none"}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
      >
        <Animated.View
          accessibilityViewIsModal
          style={{
            width: Math.min(WIDTH, width - 48), borderRadius: RADIUS, backgroundColor: c.card,
            borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, paddingTop: 24, paddingBottom: 20,
            shadowColor: "#000", shadowOpacity: 0.55, shadowRadius: 25, shadowOffset: { width: 0, height: 25 },
            opacity: k, transform: [{ scale }],
          }}
        >
          {children}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** 标题：22/28 粗体、居中（demo 的 .gdlg h2） */
export function DialogTitle({ children }: { children: ReactNode }) {
  const { c } = usePalette();
  return (
    <Text style={{ ...t.title, textAlign: "center", color: c.foreground, marginBottom: 8, paddingHorizontal: 20 }}>
      {children}
    </Text>
  );
}

/** 说明：15/21、暗色、居中。末行不留一个孤字（demo 的 text-wrap: pretty；iOS 上是 push-out 这条断行策略）。
    里面要压重音的那几个字（邮箱）用 ui.tsx 的 Strong */
export function DialogLead({ children }: { children: ReactNode }) {
  const { c } = usePalette();
  return (
    <Text
      lineBreakStrategyIOS="push-out"
      style={{ ...t.callout, textAlign: "center", color: c.mutedForeground, marginBottom: 18, paddingHorizontal: 20 }}
    >
      {children}
    </Text>
  );
}

/** 正文（输入框、验证码格子）：左右各 20 */
export function DialogBody({ children }: { children: ReactNode }) {
  return <View style={{ paddingHorizontal: 20, gap: 8 }}>{children}</View>;
}

interface DialogAction {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

/**
 * 底下那排（同桌面 AlertDialogFooter）：左边「不做这件事」、右边「做」，两颗等宽。
 * 换步只换字不换位置——手指停在原地就能接着按。
 */
export function DialogFooter({ left, right }: { left: DialogAction; right: DialogAction }) {
  return (
    <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 20, paddingTop: 20 }}>
      <Button grow size="dialog" variant="secondary" label={left.label} onPress={left.onPress} disabled={left.disabled} />
      <Button grow size="dialog" label={right.label} onPress={right.onPress} disabled={right.disabled} />
    </View>
  );
}
