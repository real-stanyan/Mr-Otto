// 语音消息的气泡（#1492，ADR-0351；照微信）：一条横条，长度随时长（2 秒 ~ 60 秒映到 88 ~ 220pt），左边 ▶ / ■，
// 右边 N″；点一下播，再点停；同一时刻只放一条（新的一按，上一条停）。底下一行「转文字」：展开发送方录的时候
// 听写出来的那份 transcript（没有就说「没有文字」）——接收方不再识别一遍（维护者拍板）。
//
// 放音走 expo-video 的无头播放器（AVPlayer 放 m4a 没问题）：不碰 otto-speech 的音频会话——那边管的是通话；
// 代价是通话进行中按语音条会和通话抢扬声器，先不管（通话里本来也不该听别的）。
import { createVideoPlayer, type VideoPlayer } from "expo-video";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type ChatMediaItem } from "../../../src/shared/chatMedia.js";
import { usePalette } from "../theme.js";
import { Spinner } from "../ui.js";
import { retryMediaUrl, useMediaUrl } from "./mediaUrls.js";

const MIN_W = 88;
const MAX_W = 220;
const RADIUS = 12;

/** 时长 → 条的宽度（线性，2 秒以内都是最短） */
export function audioBarWidth(durationMs: number): number {
  const s = Math.max(0, Math.min(60, durationMs / 1000));
  if (s <= 2) return MIN_W;
  return Math.round(MIN_W + ((s - 2) / 58) * (MAX_W - MIN_W));
}

export function audioSecondsLabel(durationMs: number): string {
  return `${Math.max(1, Math.round(durationMs / 1000))}″`;
}

/** 同一时刻只放一条 */
let current: { stop: () => void } | null = null;

export function AudioBubble({ item, bucket, mine }: { item: ChatMediaItem; bucket: string; mine: boolean }) {
  const { c } = usePalette();
  const url = useMediaUrl(item.path, bucket);
  const [playing, setPlaying] = useState(false);
  const [showText, setShowText] = useState(false);
  const player = useRef<VideoPlayer | null>(null);

  const stop = (): void => {
    const p = player.current;
    player.current = null;
    if (p !== null) {
      try {
        p.pause();
        p.release();
      } catch {
        // 已经释放过
      }
    }
    setPlaying(false);
    if (current !== null && current.stop === stop) current = null;
  };
  useEffect(() => () => stop(), []);

  const toggle = (): void => {
    if (playing) {
      stop();
      return;
    }
    if (typeof url !== "string") {
      if (url === "failed") retryMediaUrl(item.path, bucket);
      return;
    }
    if (current !== null) current.stop();
    const p = createVideoPlayer(url);
    player.current = p;
    current = { stop };
    p.addListener("playToEnd", () => stop());
    p.addListener("statusChange", ({ status }) => {
      if (status === "error") stop();
    });
    p.play();
    setPlaying(true);
  };

  const width = audioBarWidth(item.durationMs ?? 0);
  const bg = mine ? c.bubbleMe : c.bubbleThem;
  return (
    <View style={{ alignItems: mine ? "flex-end" : "flex-start", gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`语音 ${audioSecondsLabel(item.durationMs ?? 0)}，${playing ? "点一下停" : "点一下播放"}`}
        onPress={toggle}
        style={({ pressed }) => [
          { width, height: 40, borderRadius: RADIUS, ...(mine ? { borderTopRightRadius: 4 } : { borderTopLeftRadius: 4 }), backgroundColor: bg, flexDirection: mine ? "row-reverse" : "row", alignItems: "center", paddingHorizontal: 12, gap: 8 },
          pressed && { opacity: 0.8 },
        ]}
      >
        {url === null ? <Spinner /> : (
          <Text style={{ fontSize: 14, color: url === "failed" ? c.destructive : c.foreground }}>{url === "failed" ? "！" : playing ? "■" : "▶"}</Text>
        )}
        <View style={{ flex: 1 }} />
        <Text style={{ fontSize: 13, color: c.foreground, fontVariant: ["tabular-nums"] }}>{audioSecondsLabel(item.durationMs ?? 0)}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={showText ? "收起文字" : "转文字"} onPress={() => setShowText((v) => !v)} hitSlop={6}>
        <Text style={{ fontSize: 12, color: c.mutedForeground, paddingHorizontal: 2 }}>{showText ? "收起" : "转文字"}</Text>
      </Pressable>
      {showText ? (
        <View style={{ maxWidth: 260, paddingVertical: 8, paddingHorizontal: 12, borderRadius: RADIUS, backgroundColor: c.card, borderWidth: 0.5, borderColor: c.border }}>
          <Text selectable style={{ fontSize: 15, lineHeight: 22, color: item.transcript !== undefined ? c.foreground : c.mutedForeground }}>
            {item.transcript ?? "这条语音没有文字（对方录的时候没听清）。"}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** 还没传完的那条：同样一条横条，压一层半透明 */
export function AudioPendingBar({ durationMs, dim }: { durationMs: number; dim: boolean }) {
  const { c } = usePalette();
  return (
    <View style={{ width: audioBarWidth(durationMs), height: 40, borderRadius: RADIUS, borderTopRightRadius: 4, backgroundColor: c.bubbleMe, flexDirection: "row-reverse", alignItems: "center", paddingHorizontal: 12, opacity: dim ? 0.6 : 1 }}>
      <Text style={{ fontSize: 14, color: c.foreground }}>▶</Text>
      <View style={{ flex: 1 }} />
      <Text style={{ fontSize: 13, color: c.foreground, fontVariant: ["tabular-nums"] }}>{audioSecondsLabel(durationMs)}</Text>
    </View>
  );
}
