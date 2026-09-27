// 语音通话（#1386，demo 的 .mcall）：整屏升起——大脸、名字、在听 / 正在说、计时、转文字、静音、挂断；左上「收起」
// 回到聊天页、头部下面留一颗「通话中 00:12」的胶囊（点它回来）。#1356 A4 那一版是换掉输入框的一格，demo 改成整屏
// + 收起，编排原样（shared 的 voiceSession / mobileCall）：离开聊天页 = 这台停听、通话还在；回来那一格写「通话还开着」
// +「接着听」。
//
// 深色一屏、两个主题同一个样子（通话是一个场景，不跟着系统深浅走——同桌面全屏通话视图，ADR-0278）。
// 声浪 22 根竖条全走原生驱动（通话时 JS 线程正忙着收流式碎片、合成语音）；减弱动态效果时不起伏，响度改用透明度说。
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { callOffsetText } from "../../../src/shared/cloudTimeline.js";
import { waveAmplitude, type WaveMode } from "../../../src/shared/mobileCall.js";
import { usePalette, withAlpha } from "../theme.js";
import { useReduceMotion } from "../ui.js";
import { Icon, type IconName } from "../wx/Icon.js";

const SHELL = "#141416";
const FG = "#ffffff";
const FG2 = "rgba(255, 255, 255, 0.62)";
const BARS = 22;
const BAR_MAX = 30;
const BAR_MIN = 3;
const halfPeriod = (i: number): number => 130 + ((i * 7) % 11) * 19;
const startDelay = (i: number): number => ((i * 53) % 17) * 12;

/** 计时：一秒一跳，作用域圈在这一格里（整页不跟着每秒重画） */
export function CallTimer({ sinceTs, color, size = 14 }: { sinceTs: number; color: string; size?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const t = callOffsetText(now - sinceTs);
  return <Text accessibilityLabel={`通话 ${t}`} style={{ fontSize: size, fontWeight: "600", fontVariant: ["tabular-nums"], color }}>{t}</Text>;
}

function Wave({ mode, level, color }: { mode: WaveMode; level: number; color: string }) {
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
  const bars = useMemo(
    () =>
      swell.map((v, i) =>
        reduce
          ? { opacity: Animated.add(0.35, Animated.multiply(0.65, amp)), transform: [{ scaleY: 0.3 + 0.5 * Math.abs(Math.sin(i * 0.55)) }] }
          : { transform: [{ scaleY: Animated.add(BAR_MIN / BAR_MAX, Animated.multiply((BAR_MAX - BAR_MIN) / BAR_MAX, Animated.multiply(amp, v))) }] },
      ),
    [swell, amp, reduce],
  );
  return (
    <View importantForAccessibility="no-hide-descendants" style={{ height: 36, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 3 }}>
      {bars.map((style, i) => (
        <Animated.View key={i} style={[{ width: 3, height: BAR_MAX, borderRadius: 1.5, backgroundColor: mode === "off" ? withAlpha(FG, 0.3) : color }, style]} />
      ))}
    </View>
  );
}

function RoundControl({ icon, label, tone, onPress, disabled = false, selected }: {
  icon: IconName;
  label: string;
  tone: "plain" | "on" | "end" | "go";
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
}) {
  const { c } = usePalette();
  const bg = tone === "end" ? c.destructive : tone === "go" ? c.voice : tone === "on" ? FG : withAlpha(FG, 0.16);
  return (
    <View style={{ alignItems: "center", gap: 8, opacity: disabled ? 0.4 : 1 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled, ...(selected === undefined ? {} : { selected }) }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [{ width: 72, height: 72, borderRadius: 36, alignItems: "center", justifyContent: "center", backgroundColor: bg }, pressed && { transform: [{ scale: 0.94 }], opacity: 0.85 }]}
      >
        <Icon name={icon} size={30} stroke={1.8} color={tone === "on" ? SHELL : FG} />
      </Pressable>
      <Text style={{ fontSize: 13, color: FG2 }}>{label}</Text>
    </View>
  );
}

export interface CallOverlayProps {
  visible: boolean;
  /** live = 这台在听；idle = 通话还开着、这台没在听 */
  mode: "live" | "idle";
  title: string;
  /** 正中那几张脸（调用方画好：状态由它算） */
  faces: ReactNode;
  status: string;
  sinceTs: number;
  wave: WaveMode;
  level: number;
  micOn: boolean;
  captionsOn: boolean;
  captions: { agent: string | null; me: string | null };
  joinBlocked: string | null;
  busy: boolean;
  onMinimize: () => void;
  onToggleCaptions: () => void;
  onToggleMic: () => void;
  onHangUp: () => void;
  onJoin: () => void;
}

export function CallOverlay(p: CallOverlayProps) {
  const { c } = usePalette();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={p.visible} animationType="slide" presentationStyle="fullScreen" statusBarTranslucent onRequestClose={p.onMinimize}>
      <View style={{ flex: 1, backgroundColor: SHELL, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 28, paddingHorizontal: 24 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Pressable accessibilityRole="button" accessibilityLabel="收起，回到聊天" hitSlop={10} onPress={p.onMinimize} style={({ pressed }) => [{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }, pressed && { opacity: 0.5 }]}>
            <Icon name="chevron-down" size={28} stroke={2} color={FG} />
          </Pressable>
          <CallTimer sinceTs={p.sinceTs} color={FG2} />
          <View style={{ width: 40 }} />
        </View>

        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 14 }}>
          {p.faces}
          <Text numberOfLines={1} style={{ fontSize: 26, fontWeight: "600", color: FG, marginTop: 6 }}>{p.title}</Text>
          <Text style={{ fontSize: 15, color: FG2 }}>{p.status}</Text>
          {p.mode === "live" ? <Wave mode={p.wave} level={p.level} color={c.voice} /> : null}
        </View>

        <View accessibilityLiveRegion="polite" style={{ minHeight: 84, justifyContent: "flex-end", paddingBottom: 18, opacity: p.captionsOn && p.mode === "live" ? 1 : 0 }}>
          {p.captions.agent !== null ? <Text numberOfLines={3} style={{ fontSize: 17, lineHeight: 24, color: FG, textAlign: "center" }}>{p.captions.agent}</Text> : null}
          {p.captions.me !== null ? <Text numberOfLines={2} style={{ fontSize: 15, lineHeight: 21, color: FG2, textAlign: "center" }}>{`你：${p.captions.me}`}</Text> : null}
        </View>

        {p.mode === "idle" && p.joinBlocked !== null ? <Text style={{ fontSize: 14, lineHeight: 20, color: FG2, textAlign: "center", paddingBottom: 16 }}>{p.joinBlocked}</Text> : null}

        <View style={{ flexDirection: "row", justifyContent: "center", gap: 34 }}>
          {p.mode === "live" ? (
            <>
              <RoundControl icon={p.micOn ? "mic" : "mic-off"} label={p.micOn ? "静音" : "取消静音"} tone={p.micOn ? "plain" : "on"} selected={!p.micOn} onPress={p.onToggleMic} />
              <RoundControl icon="phone-off" label="挂断" tone="end" onPress={p.onHangUp} disabled={p.busy} />
              <RoundControl icon="type" label="转文字" tone={p.captionsOn ? "on" : "plain"} selected={p.captionsOn} onPress={p.onToggleCaptions} />
            </>
          ) : (
            <>
              {p.joinBlocked === null ? <RoundControl icon="phone" label="接着听" tone="go" onPress={p.onJoin} disabled={p.busy} /> : null}
              <RoundControl icon="phone-off" label="挂断" tone="end" onPress={p.onHangUp} disabled={p.busy} />
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

/** 收起之后头部下面那颗「通话中」胶囊：点它回到整屏 */
export function CallPill({ sinceTs, onPress }: { sinceTs: number; onPress: () => void }) {
  const { c } = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="回到通话"
      onPress={onPress}
      style={({ pressed }) => [
        { position: "absolute", top: 8, right: 12, height: 34, paddingLeft: 10, paddingRight: 12, borderRadius: 17, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: c.voice,
          shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
        pressed && { opacity: 0.85 },
      ]}
    >
      <Icon name="phone" size={15} stroke={2.2} color={FG} />
      <CallTimer sinceTs={sinceTs} color={FG} />
    </Pressable>
  );
}
