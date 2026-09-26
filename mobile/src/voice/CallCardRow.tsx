// 一场通话折成的那张卡（#1356 A4，spec §5.7，ADR-0288）：收起时只报「多久」和「聊的什么」，点开是全文。
// 不报「几句话」（demo：那是干活的量，读者据此做不了任何事，同 ADR-0250 的理由）。还开着写「通话中」、
// 不走表——电话那一格已经有一只表。
import { useRef } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import { callDurationText, type VoiceCallCard } from "../../../src/shared/cloudTimeline.js";
import { WaveGlyph } from "../chrome/VoiceGlyphs.js";
import { PRESS_SPRING, usePalette } from "../theme.js";
import { useReduceMotion } from "../ui.js";

export function callCardDuration(card: VoiceCallCard): string {
  return card.endedTs === null ? "通话中" : callDurationText(card.endedTs - card.sinceTs);
}

export function CallCardRow({ card, topic, onPress }: { card: VoiceCallCard; topic: string | null; onPress: () => void }) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number): void => {
    if (!reduce) Animated.spring(scale, { toValue: v, useNativeDriver: true, ...PRESS_SPRING }).start();
  };
  const duration = callCardDuration(card);
  return (
    <View style={{ paddingHorizontal: 16 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`语音聊天，${duration}${topic === null ? "" : `，${topic}`}`}
        accessibilityHint="点开看这通电话的全文"
        onPress={onPress}
        onPressIn={() => to(0.985)}
        onPressOut={() => to(1)}
        style={({ pressed }) => [reduce && pressed && { opacity: 0.7 }]}
      >
        <Animated.View style={{ backgroundColor: c.card, borderRadius: 18, paddingVertical: 13, paddingHorizontal: 15, transform: [{ scale }] }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <WaveGlyph color={c.foreground} size={17} weight={2.2} />
            <Text style={{ fontSize: 16, fontWeight: "600", letterSpacing: -0.15, color: c.foreground }}>语音聊天</Text>
            <View style={{ flex: 1 }} />
            <Text style={{ fontSize: 14, color: c.mutedForeground, fontVariant: ["tabular-nums"] }}>{duration}</Text>
          </View>
          {topic !== null ? (
            <Text numberOfLines={1} style={{ fontSize: 14.5, color: c.mutedForeground, marginTop: 3 }}>{topic}</Text>
          ) : null}
        </Animated.View>
      </Pressable>
    </View>
  );
}
