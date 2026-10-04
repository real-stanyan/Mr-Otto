// 居中弹窗（demo 的 .dlg，同桌面 AlertDialog）：表单与确认一律用它，不用底部抽屉（spec §3.2）。
//
// 默认只受控：没有「点遮罩关」，出口只有里面的按钮——一个正在收信的人手一抖就得从头再来。
// 例外是岔路口那一类（`dismissible`，spec §4）：「新建」那张问一句「建什么」的弹窗，按错了不该被关
// 在里面，点外面 / 安卓返回键就退。
// 进场从 .96 放到 1 + 淡入（不从 0 起：现实里没有东西从「没有」里长出来），退场更快：
// .98 + 淡出 140ms。关了动效就只淡入淡出。
// 「有值才画」的弹窗（{x ? <X/> : null}）不能在按钮里直接把自己卸掉——整棵子树当场消失，
// visible=false 送不到这里，退场那 140ms 永远跑不到。按钮先让 visible 变 false，onExited 里再卸。
// 键盘弹起时居中的是键盘上面那块：Modal 里的 KeyboardAvoidingView 量的是整屏坐标，
// 没有 ui.tsx 里 useKeyboardInset 说的那个「相对父级」的坑。
// 卡**限高到键盘上面那块**、超出的在卡里滚（#1456）：KAV 只把可用区缩到键盘上方，不管卡多高。
// 「新建智能体」那张（说明 + 72 的脸 + 输入框 + 十张脸的墙）比中文键盘上方剩下的还高，居中排版
// 让它上下一起溢出，上半截连标题带说明被推出屏幕顶——真机上看就是「整个弹窗被顶飞」。
// 可用高度量里面那一层的 onLayout（不自己算键盘高度：那是 KAV 已经做对的事，算第二遍就有两份判据）。
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Animated, Easing, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { spring, type as t, usePalette } from "./theme.js";
import { Button, useReduceMotion } from "./ui.js";

const WIDTH = 320;
/** 宽一档（demo 的 .dlg.wide：min(348, 屏宽 − 40)）：两行并列、左边带图的选择卡用 */
const WIDE_WIDTH = 348;
const RADIUS = 22;
/** 卡与可用区上下边之间至少留这么多（键盘起着时贴着键盘顶也不好看） */
const EDGE = 12;

export function Dialog({ visible, onExited, dismissible = false, onDismiss, wide = false, children }: {
  visible: boolean;
  /** 退场放完、Modal 收起之后调一次：「有值才画」的调用方在这里才真的把自己卸掉 */
  onExited?: () => void;
  /** 点暗幕 / 安卓返回键能退（岔路口那一类，spec §4）。表单 / 确认类不给 */
  dismissible?: boolean;
  /** 人点了暗幕 / 返回键：调用方把 visible 置 false。只在 dismissible 时会被调 */
  onDismiss?: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  /** 键盘上方（或整屏）扣掉安全区与边距之后，卡最多能有多高。还没量到时不限 */
  const [room, setRoom] = useState<number | null>(null);
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
  const dismiss = (): void => {
    if (dismissible) onDismiss?.();
  };
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={dismiss}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim, opacity: k }]} />
      {/* 退场途中不接手指：已经在关的弹窗再被点一下「发送」，就是一次谁都看不见的请求 */}
      <KeyboardAvoidingView
        pointerEvents={visible ? "auto" : "none"}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <View
          style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingTop: insets.top + EDGE, paddingBottom: EDGE }}
          onLayout={(e) => setRoom(Math.max(0, e.nativeEvent.layout.height - insets.top - EDGE * 2))}
        >
          {dismissible ? (
            // 暗幕那一层接不了手指（上面那层是 pointerEvents="none" 的动画层）：点外面退出挂在这里，
            // 排在卡的前面——卡是后画的兄弟，点在卡上落不到这一层
            <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} accessibilityRole="button" accessibilityLabel="关闭" />
          ) : null}
          <Animated.View
            accessibilityViewIsModal
            style={{
              width: wide ? Math.min(WIDE_WIDTH, width - 40) : Math.min(WIDTH, width - 48),
              borderRadius: RADIUS, backgroundColor: c.card,
              borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
              ...(room === null ? {} : { maxHeight: room }),
              shadowColor: "#000", shadowOpacity: 0.55, shadowRadius: 25, shadowOffset: { width: 0, height: 25 },
              opacity: k, transform: [{ scale }],
            }}
          >
            {/* 放得下时它就是一层透明的壳（不弹、不画滚动条）；放不下才滚。圆角靠里面这层自己裁：
                卡上不能 overflow:hidden，那会把卡的阴影一起裁掉 */}
            <ScrollView
              style={{ flexGrow: 0, flexShrink: 1, borderRadius: RADIUS }}
              contentContainerStyle={{ paddingTop: 24, paddingBottom: 20 }}
              keyboardShouldPersistTaps="handled"
              alwaysBounceVertical={false}
              showsVerticalScrollIndicator={false}
            >
              {children}
            </ScrollView>
          </Animated.View>
        </View>
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
  /** 右边那颗真的会删东西（删掉一只 / 解散群）：画成实底红（#1362）——触发它的那一行是红字，
      弹窗里真正按下去就删的那颗反而是品牌蓝，是一句反话 */
  tone?: "destructive";
}

/**
 * 底下那排（同桌面 AlertDialogFooter）：左边「不做这件事」、右边「做」，两颗等宽；「做」是删东西时右边那颗实底红。
 * 换步只换字不换位置——手指停在原地就能接着按。
 */
export function DialogFooter({ left, right }: { left: DialogAction; right: DialogAction }) {
  return (
    <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 20, paddingTop: 20 }}>
      <Button grow size="dialog" variant="secondary" label={left.label} onPress={left.onPress} disabled={left.disabled} />
      <Button
        grow
        size="dialog"
        variant={right.tone === "destructive" ? "danger" : "primary"}
        label={right.label}
        onPress={right.onPress}
        disabled={right.disabled}
      />
    </View>
  );
}
