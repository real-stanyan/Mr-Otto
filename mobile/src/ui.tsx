// 手机端的组件层。三屏共用,令牌全部来自 theme.ts(= 桌面 app.css 那张表)。
//
// 这一层刻意只做三件事,别的都留给屏幕自己:
// 1. **按下就有反馈**,不等抬手。延迟一出现,"直接操纵"的感觉就断了
// 2. **层级靠材质,不靠颜色堆**。地面 background / 浮起的面 card / 细线 border,
//    蓝色(primary)一屏只给一个真正的主动作——两个蓝按钮等于没有主次
// 3. **动效可被系统关掉**。开了"减弱动态效果"就退成不位移的透明度变化

import { Children, Fragment, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, Text, View,
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
/** lines=1 时超出用省略号收尾。会话标题是用户起的,长度没有上限,
    不限行的话一张卡片能被一个标题撑成三行,整列的节奏就没了 */
export function Headline({ children, lines }: { children: React.ReactNode; lines?: number }) {
  return (
    <Text style={useText("headline", "foreground")} numberOfLines={lines} ellipsizeMode="tail">
      {children}
    </Text>
  );
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

/** 提示条。错误不是一行裸红字 —— 给它一块底,人才知道这是"一条消息"而不是标签。
    整条用同色细边 + 同色文字,不加左侧色条:桌面那侧没有色条这个语汇,
    多一种别处不用的装饰就是多一条要记的规矩 */
export function Note({ tone, children }: { tone: "error" | "warn"; children: React.ReactNode }) {
  const { c } = usePalette();
  const hue = tone === "error" ? c.destructive : c.warn;
  return (
    <View style={{
      backgroundColor: c.card, borderRadius: radius.control, padding: space.sm + 2,
      borderWidth: StyleSheet.hairlineWidth, borderColor: hue,
    }}>
      <Text style={{ ...type.footnote, color: hue }}>{children}</Text>
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

/**
 * 元信息。**等宽 + 暗**是桌面那侧最认得出的一条:`1 步 · 120 tokens`、
 * `elapsed 13ms tok/s 8000`、模型名,全走这个样式。跟着它,手机端才读成同一个产品。
 */
export function Meta({ children }: { children: React.ReactNode }) {
  const { c } = usePalette();
  return (
    <Text style={{ ...type.footnote, color: c.mutedForeground, fontFamily: MONO }}>{children}</Text>
  );
}

/** 行首那个小方块。桌面的 permission-grant 就是 `size-7 rounded-lg bg-foreground/[0.05]`
    里放一个图标 —— 手机端没装图标库(要 native 的 expo-font),放状态点或一个等宽字符 */
export function Tile({ children }: { children: React.ReactNode }) {
  const { c } = usePalette();
  return (
    <View style={{
      width: 28, height: 28, borderRadius: radius.tile, backgroundColor: c.muted,
      alignItems: "center", justifyContent: "center",
    }}>
      {children}
    </View>
  );
}

/* ── 页签图标 ──────────────────────────────────────────
   **用 View 画的,不是图标库。** @expo/vector-icons 要 native 的 expo-font,
   加了就得重新 build + 装机,会废掉真机上那个 build 的热重载。三个形状简单到
   画出来比引一个依赖便宜:列表条 / 两个人头 / 两条带旋钮的滑竿(SF 的
   slider.horizontal 那个,比齿轮好画得多,语义一样是"调设置")。

   线宽 1.6 是挑过的:1 在 3x 屏上偏细发灰,2 又比 SF Symbols 的 regular 粗一档。 */

const ICON = 24;
const STROKE = 1.6;

export function TabIcon({ name, color }: { name: "sessions" | "friends" | "settings"; color: string }) {
  // 前面那个圈要挖掉后面那个的一角,两个圈才读成"一前一后两个人";
  // 不挖的话交叠处两条弧线交在一起,整体读成一副链环
  const bg = usePalette().c.background;
  if (name === "sessions") {
    // 三条长短不一的横线 = 一份列表。等长的话读起来像"菜单"而不是"内容"
    return (
      <View style={{ width: ICON, height: ICON, justifyContent: "center", gap: 4 }}>
        {[18, 13, 16].map((w, i) => (
          <View key={i} style={{ width: w, height: STROKE, borderRadius: 1, backgroundColor: color }} />
        ))}
      </View>
    );
  }
  if (name === "friends") {
    // 两个交叠的圈 = 两个人。交叠是"关系"的意思,并排只是"两个东西"
    return (
      <View style={{ width: ICON, height: ICON, alignItems: "center", justifyContent: "center" }}>
        <View style={{ flexDirection: "row" }}>
          <View style={{
            width: 12, height: 12, borderRadius: radius.pill,
            borderWidth: STROKE, borderColor: color,
          }} />
          <View style={{
            width: 12, height: 12, borderRadius: radius.pill,
            borderWidth: STROKE, borderColor: color, marginLeft: -4,
            backgroundColor: bg,
          }} />
        </View>
      </View>
    );
  }
  // 两条滑竿,旋钮错开 —— 错开才读成"可调",对齐就成了两条普通横线
  return (
    <View style={{ width: ICON, height: ICON, justifyContent: "center", gap: 6 }}>
      {[6, 12].map((x, i) => (
        <View key={i} style={{ height: 7, justifyContent: "center" }}>
          <View style={{ width: 19, height: STROKE, borderRadius: 1, backgroundColor: color }} />
          <View style={{
            position: "absolute", left: x, width: 7, height: 7, borderRadius: radius.pill,
            borderWidth: STROKE, borderColor: color,
            // 旋钮要盖住底下那条线,否则线从它中间穿过去
            backgroundColor: "transparent",
          }} />
        </View>
      ))}
    </View>
  );
}

/* ── 按钮 ─────────────────────────────────────────────── */

/**
 * 桌面那侧的常规控件是**描边**的(侧栏那个「+ 新会话」= 透明底 + 一条细边),
 * 实底只留给真正的主动作。手机端跟同一条:
 *   primary  实底蓝——一屏只给一个
 *   outline  透明底 + 细边——绝大多数按钮
 *   plain    纯文字 + 点缀色——"刷新""用邮箱密码登录"这种读成链接的
 *   quiet    纯文字 + 暗色——"拒绝"这种和主动作并排、要让位的
 *   destructive 透明底 + 红字红边——不实底,因为它不是主动作
 */
export type ButtonVariant = "primary" | "outline" | "plain" | "quiet" | "destructive";

export function Button(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: ButtonVariant;
  /** 并排摆时平分宽度。竖着摆的按钮不要 flex —— 会把自己抻开 */
  grow?: boolean;
  /** auto = 自己多宽算多宽的小胶囊,右对齐成一行。桌面 permission-grant 的动作行
      就是这个形状:安静、不抢卡片的主体。整屏的主按钮才用默认的通栏 */
  size?: "full" | "auto";
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

  const hair = { borderWidth: StyleSheet.hairlineWidth };
  const face: ViewStyle =
    v === "primary" ? { backgroundColor: c.primary }
    : v === "outline" ? { backgroundColor: "transparent", ...hair, borderColor: c.border }
    : v === "destructive" ? { backgroundColor: "transparent", ...hair, borderColor: c.destructive }
    : { backgroundColor: "transparent" };

  const fg =
    v === "primary" ? c.primaryForeground
    : v === "destructive" ? c.destructive
    : v === "outline" ? c.foreground
    : v === "quiet" ? c.mutedForeground
    : c.brand; // plain = 纯文字按钮,用点缀色让它读成"可点",而不是一段说明

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
          props.size === "auto"
            ? { borderRadius: radius.pill, paddingVertical: 11, paddingHorizontal: space.lg, minHeight: 44 }
            : { borderRadius: radius.control, paddingVertical: 15, paddingHorizontal: space.md, minHeight: 50 },
          {
            // alignItems + justifyContent 都要:少一个,文字在某些容器里会跑到看不见的地方
            // (虚拟机上第一版就是一条没有字的蓝条)
            alignItems: "center", justifyContent: "center" },
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

/* ── 分组列表 ──────────────────────────────────────────
   设置屏的语汇是 iOS 的 inset grouped list,不是一摞表单卡片:
   **同一类的事挤进一块板,靠细线分行**,板上一句小标题、板下一句解释。
   区别不在好看 —— 一摞 Card 里每一张都在喊"我是独立的一件事",
   而设置里绝大多数行是同一件事的几个面(账号的邮箱和退出是一组)。

   行的反馈也和按钮不同:iOS 的列表行**整行变色**,不缩放。缩放是
   "这是个按钮"的语汇,整行高亮是"我选中了这一行"。 */

/** 一组行。header 在板上、footer 在板下,都用小字暗色,左边和行内文字对齐 */
export function Group({ header, footer, children }: {
  header?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { c } = usePalette();
  // 条件渲染出来的 null 会占一个位置,不滤掉就会多画一条分隔线
  const rows = Children.toArray(children).filter(Boolean);
  const side = { ...type.footnote, color: c.mutedForeground, paddingHorizontal: space.md };
  return (
    <View style={{ gap: space.xs }}>
      {header ? <Text style={side}>{header}</Text> : null}
      <View style={{
        backgroundColor: c.card, borderRadius: radius.card,
        borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
        // 行的高亮铺满整行,不裁的话会从圆角里溢出去
        overflow: "hidden",
      }}>
        {rows.map((row, i) => (
          <Fragment key={i}>
            {/* 分隔线左边缩进到和文字对齐 —— 通到底的线会把一组切成两组 */}
            {i > 0 ? (
              <View style={{
                height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: space.md,
              }} />
            ) : null}
            {row}
          </Fragment>
        ))}
      </View>
      {footer ? <Text style={side}>{footer}</Text> : null}
    </View>
  );
}

/** 右边那个 ›。画出来的,理由和 TabIcon 一样:不为三个形状引一个 native 依赖 */
function Chevron({ color }: { color: string }) {
  return (
    <View style={{
      width: 8, height: 8, borderRightWidth: 1.6, borderTopWidth: 1.6,
      borderColor: color, transform: [{ rotate: "45deg" }],
    }} />
  );
}

export function Row(props: {
  label: string;
  /** 右边的值。只读信息走这里,不要做成按钮 */
  value?: string;
  /** 值是机器数据(中继地址、设备 id):等宽 + 小一号,和 Meta 同一条规矩。
      **截断从中间截** —— id 和 URL 两头都要紧,掐掉尾巴等于没显示 */
  mono?: boolean;
  /** 行首的东西,一般是状态点 */
  leading?: React.ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  /** 有下一层可去。只在真的会推进一屏时给 —— 它是个承诺 */
  chevron?: boolean;
  /** 单独成组、居中的动作行(iOS 的「退出登录」就是这个形状) */
  align?: "split" | "center";
  tone?: "default" | "destructive";
}) {
  const { c } = usePalette();
  const hi = useRef(new Animated.Value(0)).current;
  const center = props.align === "center";
  const fg = props.tone === "destructive" ? c.destructive : c.foreground;

  // **按下那一帧就变色**(setValue,不是动画);松手才淡出。
  // 反过来做——按下淡入——延迟会直接吃掉"直接操纵"的感觉
  const press = (down: boolean): void => {
    if (down) return hi.setValue(1);
    Animated.timing(hi, {
      toValue: 0, duration: 250, easing: Easing.out(Easing.quad), useNativeDriver: true,
    }).start();
  };

  const body = (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: space.sm,
      paddingHorizontal: space.md, paddingVertical: 12,
      minHeight: 44, // HIG 的最小可点高度
      justifyContent: center ? "center" : "space-between",
    }}>
      {/* 左边不收缩、右边收缩:要截也该截机器数据那一串,不是"中继"这两个字 */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexShrink: 0 }}>
        {props.leading}
        <Text style={{ ...type.body, color: fg }} numberOfLines={1}>{props.label}</Text>
      </View>
      {center ? null : (
        <View style={{
          flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center",
          justifyContent: "flex-end", gap: space.xs,
        }}>
          {props.value === undefined ? null : (
            <Text
              style={props.mono
                ? { ...type.footnote, fontFamily: MONO, color: c.mutedForeground }
                : { ...type.body, color: c.mutedForeground }}
              numberOfLines={1}
              ellipsizeMode={props.mono ? "middle" : "tail"}
              // 长按能拷走。手机上没有别的办法把这串东西送进工单里
              selectable={props.mono && !props.onPress}
            >
              {props.value}
            </Text>
          )}
          {props.chevron ? <Chevron color={c.mutedForeground} /> : null}
        </View>
      )}
    </View>
  );

  if (!props.onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!props.disabled }}
      onPressIn={() => press(true)}
      onPressOut={() => press(false)}
      onPress={props.onPress}
      disabled={props.disabled}
      style={props.disabled ? { opacity: 0.4 } : undefined}
    >
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: c.muted, opacity: hi }]}
      />
      {body}
    </Pressable>
  );
}
