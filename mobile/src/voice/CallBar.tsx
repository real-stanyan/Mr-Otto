// 电话模式（#1356 A4，spec §5.7）：替换输入框，不是浮在上面——通话时那一格本来就不打字，把输入框留在
// 下面只会让人以为还能打；也不做全屏——它在把活干完，时间线要接着看（demo 里维护者定的三件事）。
//
// 受控组件：进来的是这一刻的事实，出去的是几个动作；接线在 ChatScreen（同 A3 的 NewGroupForm，冒烟时
// 拿假数据把每个样子摆出来）。两种样子：
// · live（这台在听）：脸 | 声浪 | 计时；底下三颗：转文字 / 静音（= 关麦）/ 挂断。
// · idle（通话还开着、这台没在听——锁过屏、从名册回来）：「通话还开着」| 计时；底下两颗：
//   接着听（这台听不了时换成一句为什么）/ 挂断。
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { callOffsetText } from "../../../src/shared/cloudTimeline.js";
import { waveAmplitude, type WaveMode } from "../../../src/shared/mobileCall.js";
import { HangUpGlyph, KeyboardGlyph, MicGlyph } from "../chrome/VoiceGlyphs.js";
import { PRESS_SPRING, type as t, usePalette, withAlpha } from "../theme.js";
import { useReduceMotion } from "../ui.js";

const BARS = 22;
/** 条满格 26 点（那一格 30 高）；最低 3 点（关着麦 / 没声时剩的那一截） */
const BAR_MAX = 26;
const BAR_MIN = 3;
/** 每根条自己的一口气：半个周期 130–320ms、起步错开，按下标派生（稳定；不整齐才像声音） */
const halfPeriod = (i: number): number => 130 + ((i * 7) % 11) * 19;
const startDelay = (i: number): number => ((i * 53) % 17) * 12;

export interface CallBarProps {
  mode: "live" | "idle";
  /** 左边那张脸（ChatScreen 画好：状态由它算）；null = 不画 */
  face: ReactNode;
  /** 这一场通话第一条名单事件的时刻（计时从这儿起） */
  sinceTs: number;
  wave: WaveMode;
  /** 麦克风能量 0..1 */
  level: number;
  micOn: boolean;
  captionsOn: boolean;
  /** 「转文字」那一行：它此刻在说的那句 / 你正在说的那句 */
  captions: { agent: string | null; me: string | null };
  /** idle 时：这台为什么听不了；null = 听得了 */
  joinBlocked: string | null;
  /** 开电话 / 挂断正在路上：挂断与接着听按不动 */
  busy: boolean;
  onToggleCaptions: () => void;
  onToggleMic: () => void;
  onHangUp: () => void;
  onJoin: () => void;
}

/** 计时：一秒一跳，作用域圈在这一格里（整页不跟着每秒重画） */
function CallTimer({ sinceTs }: { sinceTs: number }) {
  const { c } = usePalette();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <Text accessibilityLabel={`通话 ${callOffsetText(now - sinceTs)}`} style={{ fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"], color: c.mutedForeground }}>
      {callOffsetText(now - sinceTs)}
    </Text>
  );
}

/** 声浪：22 根竖条，全部走原生驱动——transform 的 scaleY 与透明度，不碰布局、不占 JS 线程（通话时 JS 线程
    正忙着收流式碎片、合成语音，按帧 setState 的声浪恰好在它开口的时候卡）。缩放 = 共用的响度（waveAmplitude，
    每次变了 90ms 线性跟过去，demo 的 transition 90ms linear）× 这根条自己的起伏循环。关着麦时响度为 0，
    剩一条灰线。减弱动态效果：不起伏不缩放，每根条一个静止的高度，响度改用透明度说（减弱不是取消） */
function Wave({ mode, level }: { mode: WaveMode; level: number }) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const amp = useRef(new Animated.Value(waveAmplitude(mode, level))).current;
  const swell = useRef(Array.from({ length: BARS }, () => new Animated.Value(0.35))).current;
  useEffect(() => {
    Animated.timing(amp, { toValue: waveAmplitude(mode, level), duration: 90, easing: Easing.linear, useNativeDriver: true }).start();
  }, [amp, mode, level]);
  useEffect(() => {
    if (reduce) return;
    const loops = swell.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(startDelay(i)),
          Animated.timing(v, { toValue: 1, duration: halfPeriod(i), easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.35, duration: halfPeriod(i), easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]),
      ),
    );
    for (const l of loops) l.start();
    return () => {
      for (const l of loops) l.stop();
    };
  }, [swell, reduce]);
  // 动画节点只建一次：响度一秒来十次，每次重建 22 条节点链是白干
  const bars = useMemo(
    () =>
      swell.map((v, i) =>
        reduce
          ? { opacity: Animated.add(0.35, Animated.multiply(0.65, amp)), transform: [{ scaleY: 0.3 + 0.5 * Math.abs(Math.sin(i * 0.55)) }] }
          : { transform: [{ scaleY: Animated.add(BAR_MIN / BAR_MAX, Animated.multiply((BAR_MAX - BAR_MIN) / BAR_MAX, Animated.multiply(amp, v))) }] },
      ),
    [swell, amp, reduce],
  );
  const color = mode === "off" ? withAlpha(c.mutedForeground, 0.5) : c.voice;
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ flex: 1, minWidth: 0, height: 30, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 2 }}
    >
      {bars.map((style, i) => (
        <Animated.View key={i} style={[{ width: 3, height: BAR_MAX, borderRadius: 1.5, backgroundColor: color }, style]} />
      ))}
    </View>
  );
}

function CallButton({ label, tone, width = 62, onPress, disabled = false, selected, children }: {
  label: string;
  /** plain：次级底；on：点缀的警示底（静音着）；end：实底红（挂断）；go：主色（接着听） */
  tone: "plain" | "on" | "end" | "go";
  width?: number;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
  children: ReactNode;
}) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number): void => {
    if (!reduce) Animated.spring(scale, { toValue: v, useNativeDriver: true, ...PRESS_SPRING }).start();
  };
  const bg = tone === "end" ? c.destructive : tone === "go" ? c.primary : tone === "on" ? withAlpha(c.warn, 0.26) : withAlpha(c.foreground, 0.1);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, ...(selected === undefined ? {} : { selected }) }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => to(0.94)}
      onPressOut={() => to(1)}
      style={({ pressed }) => [disabled ? { opacity: 0.4 } : reduce && pressed ? { opacity: 0.7 } : null]}
    >
      <Animated.View style={{ width, height: 46, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: bg, transform: [{ scale }] }}>
        {children}
      </Animated.View>
    </Pressable>
  );
}

function Captions({ agent, me }: { agent: string | null; me: string | null }) {
  const { c } = usePalette();
  return (
    <View accessibilityLiveRegion="polite" style={{ paddingHorizontal: 8, gap: 2 }}>
      {agent === null && me === null ? <Text style={{ ...t.footnote, color: c.mutedForeground }}>这会儿没人说话。</Text> : null}
      {agent !== null ? <Text numberOfLines={2} style={{ ...t.footnote, color: c.mutedForeground }}>{agent}</Text> : null}
      {me !== null ? <Text numberOfLines={1} style={{ ...t.footnote, color: c.foreground }}>{`你：${me}`}</Text> : null}
    </View>
  );
}

export function CallBar(p: CallBarProps) {
  const { c } = usePalette();
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  // 出现那一下：淡入并上移 10 点（220ms ease-out；减弱动态效果时只淡入）。输入框一下子换成高出一截的另一块
  // 会读作「坏了」。live ⇄ idle 在同一个组件里换，不重放
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [enter]);
  const frame = [
    { gap: 10, paddingHorizontal: 12, paddingTop: 9, paddingBottom: Math.max(insets.bottom, 12) },
    { opacity: enter, transform: reduce ? [] : [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] },
  ];
  // 脸那一格按脸的真实尺寸给盒子（69×56，demo：不给底、不裁、不圈边）
  const faceBox = p.face === null ? null : <View style={{ width: 69, height: 56, alignItems: "center", justifyContent: "center" }}>{p.face}</View>;
  if (p.mode === "idle") {
    return (
      <Animated.View style={frame}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 6 }}>
          {faceBox}
          <Text style={{ ...t.callout, color: c.foreground, flex: 1 }}>通话还开着</Text>
          <CallTimer sinceTs={p.sinceTs} />
        </View>
        {p.joinBlocked !== null ? <Text style={{ ...t.footnote, color: c.mutedForeground, paddingHorizontal: 8 }}>{p.joinBlocked}</Text> : null}
        <View style={{ flexDirection: "row", gap: 9, justifyContent: "center" }}>
          {p.joinBlocked === null ? (
            <CallButton label="接着听" tone="go" width={124} onPress={p.onJoin} disabled={p.busy}>
              <Text style={{ fontSize: 15, fontWeight: "600", color: c.primaryForeground }}>接着听</Text>
            </CallButton>
          ) : null}
          <CallButton label="挂断" tone="end" width={76} onPress={p.onHangUp} disabled={p.busy}>
            <HangUpGlyph color={c.destructiveForeground} />
          </CallButton>
        </View>
      </Animated.View>
    );
  }
  return (
    <Animated.View style={frame}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 6 }}>
        {faceBox}
        <Wave mode={p.wave} level={p.level} />
        <CallTimer sinceTs={p.sinceTs} />
      </View>
      {p.captionsOn ? <Captions agent={p.captions.agent} me={p.captions.me} /> : null}
      <View style={{ flexDirection: "row", gap: 9, justifyContent: "center" }}>
        <CallButton label="转文字" tone="plain" selected={p.captionsOn} onPress={p.onToggleCaptions}>
          <KeyboardGlyph color={c.foreground} />
        </CallButton>
        <CallButton label={p.micOn ? "静音" : "取消静音"} tone={p.micOn ? "plain" : "on"} selected={!p.micOn} onPress={p.onToggleMic}>
          <MicGlyph color={p.micOn ? c.foreground : c.warn} />
        </CallButton>
        <CallButton label="挂断" tone="end" width={76} onPress={p.onHangUp} disabled={p.busy}>
          <HangUpGlyph color={c.destructiveForeground} />
        </CallButton>
      </View>
    </Animated.View>
  );
}
