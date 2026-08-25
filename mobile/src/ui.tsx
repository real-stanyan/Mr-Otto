// 手机端的组件层。三屏共用,令牌全部来自 theme.ts(= 桌面 app.css 那张表)。
//
// 这一层刻意只做三件事,别的都留给屏幕自己:
// 1. **按下就有反馈**,不等抬手。延迟一出现,"直接操纵"的感觉就断了
// 2. **层级靠材质,不靠颜色堆**。地面 background / 浮起的面 card / 细线 border,
//    蓝色(primary)一屏只给一个真正的主动作——两个蓝按钮等于没有主次
// 3. **动效可被系统关掉**。开了"减弱动态效果"就退成不位移的透明度变化

import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo, Animated, Pressable, StyleSheet, Text, View,
  type StyleProp, type TextStyle, type ViewStyle,
} from "react-native";
import { MONO, PRESS_SPRING, radius, space, type, usePalette, type Palette } from "./theme.js";

/** 系统的「减弱动态效果」。缩放这种位移类反馈要让位,但反馈本身不能消失 */
export function useReduceMotion(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (alive) setOn(v); });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setOn);
    return () => { alive = false; sub.remove(); };
  }, []);
  return on;
}

/* ── 文字 ─────────────────────────────────────────────── */

type TextKind = keyof typeof type;

function useText(kind: TextKind, color: keyof Palette): TextStyle {
  const { c } = usePalette();
  return { ...type[kind], color: c[color] };
}

export function Title({ children }: { children: React.ReactNode }) {
  return <Text style={useText("largeTitle", "foreground")}>{children}</Text>;
}
export function Headline({ children }: { children: React.ReactNode }) {
  return <Text style={useText("headline", "foreground")}>{children}</Text>;
}
/** 说明文字。次要信息一律走 mutedForeground —— 正文色留给真正的正文 */
export function Hint({ children }: { children: React.ReactNode }) {
  return <Text style={useText("callout", "mutedForeground")}>{children}</Text>;
}
/** 句子里需要压住重音的那几个字。加粗 + 提到正文色,不换色相 */
export function Strong({ children }: { children: React.ReactNode }) {
  const { c } = usePalette();
  return <Text style={{ color: c.foreground, fontWeight: "600" }}>{children}</Text>;
}
/** 危险语义的重音(配对屏那句"对不上就不要配") */
export function Warn({ children }: { children: React.ReactNode }) {
  const { c } = usePalette();
  return <Text style={{ color: c.warn, fontWeight: "600" }}>{children}</Text>;
}
/** 路径、ID 这类要逐字看的东西 */
export function Mono({ children }: { children: React.ReactNode }) {
  const { c } = usePalette();
  return (
    <Text style={{ ...type.footnote, color: c.mutedForeground, fontFamily: MONO }} numberOfLines={2}>
      {children}
    </Text>
  );
}

/* ── 面 ───────────────────────────────────────────────── */

/** 浮在地面之上的一块板。桌面那侧就是 --card 压在 --background 上 */
export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { c } = usePalette();
  return (
    <View style={[
      { backgroundColor: c.card, borderRadius: radius.card, padding: space.md, gap: space.sm,
        borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
      style,
    ]}>
      {children}
    </View>
  );
}

/** 提示条。错误不是一行裸红字 —— 给它一块底,人才知道这是"一条消息"而不是标签 */
export function Note({ tone, children }: { tone: "error" | "warn"; children: React.ReactNode }) {
  const { c } = usePalette();
  const hue = tone === "error" ? c.destructive : c.warn;
  return (
    <View style={{
      backgroundColor: c.card, borderRadius: radius.control, padding: space.sm + 2,
      // 左边一条色边:比整块染色克制,在深浅两套底上都不会糊
      borderLeftWidth: 3, borderLeftColor: hue,
      borderTopWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    }}>
      <Text style={{ ...type.footnote, color: c.foreground }}>{children}</Text>
    </View>
  );
}

/** 状态点。颜色只承担"哪一类",文字仍然把话说全 —— 不靠颜色单独传信息 */
export function Dot({ tone }: { tone: "ok" | "warn" | "busy" | "idle" }) {
  const { c } = usePalette();
  const color = tone === "ok" ? c.ok : tone === "warn" ? c.warn : tone === "busy" ? c.brand : c.mutedForeground;
  return <View style={{ width: 8, height: 8, borderRadius: radius.pill, backgroundColor: color }} />;
}

/** 一行:状态点 + 一句话 */
export function StatusLine({ tone, children }: { tone: "ok" | "warn" | "busy" | "idle"; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
      <Dot tone={tone} />
      <Hint>{children}</Hint>
    </View>
  );
}

/**
 * 6 位安全码。**拆成一格一格**是有理由的:这串数字的唯一用途是跟另一块屏幕
 * 逐位比对(ADR-0095),一整条 "097162" 比 "097 162" 难对得多。3+3 分组,
 * 等宽字,格子给足高度——这是这一屏的主角。
 */
export function CodeTiles({ code }: { code: string }) {
  const { c } = usePalette();
  const digits = [...code];
  return (
    <View style={{ flexDirection: "row", justifyContent: "center", gap: space.xs }}>
      {digits.map((d, i) => (
        <View
          key={i}
          style={[
            { backgroundColor: c.background, borderRadius: radius.tile,
              borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
              minWidth: 40, paddingVertical: space.sm, alignItems: "center" },
            // 3+3 之间多一口气,眼睛才会自动分成两组
            i === Math.floor(digits.length / 2) && { marginLeft: space.sm },
          ]}
        >
          <Text style={{ fontSize: 26, lineHeight: 32, fontFamily: MONO, color: c.foreground }}>{d}</Text>
        </View>
      ))}
    </View>
  );
}

/* ── 按钮 ─────────────────────────────────────────────── */

export type ButtonVariant = "primary" | "secondary" | "destructive" | "ghost";

export function Button(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: ButtonVariant;
  /** 并排摆时平分宽度。竖着摆的按钮不要 flex —— 会把自己抻开 */
  grow?: boolean;
}) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const v = props.variant ?? "primary";
  const scale = useRef(new Animated.Value(1)).current;

  // 反馈挂在**按下**上,不是抬手。0.97 是能感到、但不会让文字发虚的量
  const to = (value: number): void => {
    if (reduce) return;
    Animated.spring(scale, { toValue: value, useNativeDriver: true, ...PRESS_SPRING }).start();
  };

  const face: ViewStyle =
    v === "primary" ? { backgroundColor: c.primary }
    : v === "destructive" ? { backgroundColor: c.destructive }
    : v === "secondary" ? { backgroundColor: c.secondary, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border }
    : { backgroundColor: "transparent" };

  const fg =
    v === "primary" ? c.primaryForeground
    : v === "destructive" ? c.destructiveForeground
    : v === "secondary" ? c.secondaryForeground
    : c.brand; // ghost = 纯文字按钮,用点缀色让它读成"可点",而不是一段说明

  return (
    <Animated.View style={[props.grow ? { flex: 1 } : null, { transform: [{ scale }] }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !!props.disabled }}
        onPressIn={() => to(0.97)}
        onPressOut={() => to(1)}
        onPress={props.onPress}
        disabled={props.disabled}
        // 命中区往外放一点:手指落点和视觉边界从来不完全重合
        hitSlop={8}
        style={({ pressed }) => [
          { borderRadius: radius.control, paddingVertical: 15, paddingHorizontal: space.md,
            // alignItems + justifyContent 都要:少一个,文字在某些容器里会跑到看不见的地方
            // (虚拟机上第一版就是一条没有字的蓝条)
            alignItems: "center", justifyContent: "center", minHeight: 50 },
          face,
          // 关了动效时,按下的反馈退成变暗——反馈本身不能没有
          reduce && pressed && { opacity: 0.7 },
          props.disabled && { opacity: 0.4 },
        ]}
      >
        <Text style={{ ...type.headline, color: fg }}>{props.label}</Text>
      </Pressable>
    </Animated.View>
  );
}
