// 挑说话的声音（#1356 A4b，#1372，spec §10 第 95–98 条）：「自动」+ 六档，点一行就换成它并念一句它自己的话；
// 再点正在念的那一行 = 停。判据全在 shared 的 agentVoicePicker.ts（每一行、页脚、念哪一句、什么时候不念），
// 这里只画与接试听。点一行只改调用方手上那一格；写库在表收起时由调用方比一次、变了才存（资料页那一行，
// #1386 之后；原来是设置页按「存」，ADR-0323）。
//
// 试听：同一句在这张表开着时只合成一次（按「音色 + 那一句」记，表收起就扔）；换一行、收起、离开设置页
// 都先停上一段。`turn` 作废还没回来的那一次合成——慢的旧请求后到时不许把它念出来，也不许改这一行的样子。
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, ScrollView, Text, View } from "react-native";
import {
  PREVIEW_TIMEOUT_MESSAGE, PREVIEW_TIMEOUT_MS, VOICE_AUTO, voicePickerFooter, voicePickerRows, voicePreviewError,
  voicePreviewState, voicePreviewText,
} from "../../../src/shared/agentVoicePicker.js";
import type { VoiceSpeakResult } from "../../../src/shared/shellBridge.js";
import { CheckGlyph } from "../chrome/Glyphs.js";
import { RowGlyph } from "../chrome/RowGlyphs.js";
import { BottomSheet } from "../sheet/BottomSheet.js";
import { usePalette } from "../theme.js";
import { useReduceMotion } from "../ui.js";
import { nativeSpeech, playPreview, refreshVoiceBilling, speakPreview, useVoice } from "../voice/voiceStore.js";

type Phase = "wait" | "play";

export function VoicePickerSheet(p: {
  visible: boolean;
  agentId: string;
  /** 表单此刻的名字与职责：试听念的那一句从它们来 */
  name: string;
  description: string;
  /** 表单此刻的选择；null = 自动 */
  picked: string | null;
  /** 名册（顺序 = 派生解撞的顺序），带各自存下来的那一格 */
  agents: readonly { agentId: string; name: string; voice?: string }[];
  onPick: (voice: string | null) => void;
  onClose: () => void;
}) {
  const { c } = usePalette();
  const reduce = useReduceMotion();
  const voice = useVoice();
  const state = voicePreviewState({ native: nativeSpeech, inCall: voice.listen !== null, billing: voice.billing });
  const rows = voicePickerRows({ agentId: p.agentId, picked: p.picked, agents: p.agents });
  const [now, setNow] = useState<{ key: string; phase: Phase } | null>(null);
  const [failed, setFailed] = useState<{ key: string; text: string } | null>(null);
  const cache = useRef(new Map<string, Promise<VoiceSpeakResult>>());
  const stopPlay = useRef<(() => void) | null>(null);
  const turn = useRef(0);

  const stop = (): void => {
    turn.current++;
    stopPlay.current?.();
    stopPlay.current = null;
    setNow(null);
  };

  // 打开时拉一次订阅快照（页脚要知道念不念得了；拉失败留着上一次的）；收起 = 停、扔掉缓存、清掉红字
  useEffect(() => {
    if (p.visible) {
      void refreshVoiceBilling();
      return;
    }
    stop();
    setFailed(null);
    cache.current.clear();
  }, [p.visible]);

  // 离开设置页（整张卸载）时也停
  useEffect(
    () => () => {
      turn.current++;
      stopPlay.current?.();
      stopPlay.current = null;
    },
    [],
  );

  // 同一句只合成一次：连「还在路上」的那一次也算（点 A、再点 B、再回 A 不会给 A 付第二次钱）；
  // 抛出来的错折成 { ok: false }，失败的那一次从缓存里扔掉，下次点重来
  const synth = (k: string, text: string, voiceId: string): Promise<VoiceSpeakResult> => {
    const hit = cache.current.get(k);
    if (hit !== undefined) return hit;
    const pending = speakPreview(text, voiceId).catch(
      (err: unknown): VoiceSpeakResult => ({ ok: false, message: err instanceof Error ? err.message : String(err) }),
    );
    cache.current.set(k, pending);
    return pending;
  };

  const preview = async (key: string, voiceId: string): Promise<void> => {
    const again = now?.key === key;
    stop();
    setFailed(null);
    if (again || !state.can) return; // 再点正在念 / 正在等的那一行 = 停；念不了就只换不念
    const mine = ++turn.current;
    setNow({ key, phase: "wait" });
    const text = voicePreviewText(p.name, p.description);
    const k = `${voiceId}\n${text}`;
    const pending = synth(k, text, voiceId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<VoiceSpeakResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, message: PREVIEW_TIMEOUT_MESSAGE }), PREVIEW_TIMEOUT_MS);
    });
    const r = await Promise.race([pending, late]);
    clearTimeout(timer);
    // 失败或等超时的那一次扔掉（只扔自己放进去的那一个），下次点重新合成
    if (!r.ok && cache.current.get(k) === pending) cache.current.delete(k);
    if (mine !== turn.current) return;
    if (!r.ok) {
      setNow(null);
      setFailed({ key, text: voicePreviewError(r.message) });
      return;
    }
    stopPlay.current = playPreview(r.audio, {
      start: () => {
        if (mine === turn.current) setNow({ key, phase: "play" });
      },
      end: () => {
        if (mine !== turn.current) return;
        stopPlay.current = null;
        setNow(null);
      },
      fail: (message) => {
        if (mine !== turn.current) return;
        stopPlay.current = null;
        setNow(null);
        setFailed({ key, text: voicePreviewError(message) });
      },
    });
  };

  return (
    <BottomSheet visible={p.visible} title="说话的声音" onClose={p.onClose}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        {rows.map((row) => {
          const phase = now?.key === row.key ? now.phase : null;
          const err = failed?.key === row.key ? failed.text : null;
          return (
            <Pressable
              key={row.key}
              accessibilityRole="button"
              accessibilityState={{ selected: row.checked, busy: phase !== null }}
              accessibilityLabel={`${row.label}，${err ?? row.hint}${err === null && row.also !== null ? `，${row.also}` : ""}`}
              onPress={() => {
                if (!p.visible) return; // 收起动画那一小段里行还点得到：那时不改表单也不念
                p.onPick(row.key === VOICE_AUTO ? null : row.key);
                void preview(row.key, row.voiceId);
              }}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                minHeight: 58,
                paddingHorizontal: 20,
                paddingVertical: 10,
                backgroundColor: pressed ? c.muted : "transparent",
              })}
            >
              <VoiceRowIcon phase={phase} reduce={reduce} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: 16, color: c.foreground }}>{row.label}</Text>
                <Text
                  style={{ fontSize: 13, lineHeight: 18, marginTop: 1, color: err === null ? c.mutedForeground : c.destructive }}
                >
                  {err ?? row.hint}
                </Text>
                {row.also !== null && err === null ? (
                  <Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, marginTop: 1, color: c.mutedForeground }}>
                    {row.also}
                  </Text>
                ) : null}
              </View>
              <View style={{ width: 20, alignItems: "center" }}>
                {row.checked ? <CheckGlyph color={c.brand} size={17} /> : null}
              </View>
            </Pressable>
          );
        })}
        <Text style={{ paddingHorizontal: 20, paddingTop: 10, fontSize: 13, lineHeight: 18, color: c.mutedForeground }}>
          {voicePickerFooter(state)}
        </Text>
      </ScrollView>
    </BottomSheet>
  );
}

/** 行首那一格：平时是一枚声浪；等合成时一明一暗；在念时换成三根跳动的条（通话青）。
    「减弱动态效果」时不闪不跳：等合成停在调暗的那一枚声浪，在念停在三根不跳的条——
    两档各自停在自己那一帧，不与「空闲」的满亮共用一帧 */
function VoiceRowIcon({ phase, reduce }: { phase: Phase | null; reduce: boolean }) {
  const { c } = usePalette();
  const pulse = useRef(new Animated.Value(1)).current;
  const bars = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;

  useEffect(() => {
    pulse.setValue(reduce && phase === "wait" ? 0.5 : 1); // 减弱动态效果：等合成时停在调暗的一帧，不闪——但也不能和空闲时一模一样
    bars.forEach((b) => b.setValue(reduce ? 0.5 : 0));
    if (reduce || phase === null) return;
    const ease = Easing.inOut(Easing.ease);
    const loop =
      phase === "wait"
        ? Animated.loop(
            Animated.sequence([
              Animated.timing(pulse, { toValue: 0.35, duration: 700, easing: ease, useNativeDriver: true }),
              Animated.timing(pulse, { toValue: 1, duration: 700, easing: ease, useNativeDriver: true }),
            ]),
          )
        : Animated.loop(
            Animated.stagger(
              140,
              bars.map((b) =>
                Animated.sequence([
                  Animated.timing(b, { toValue: 1, duration: 420, easing: ease, useNativeDriver: true }),
                  Animated.timing(b, { toValue: 0, duration: 420, easing: ease, useNativeDriver: true }),
                ]),
              ),
            ),
          );
    loop.start();
    return () => loop.stop();
  }, [phase, reduce, pulse, bars]);

  if (phase === "play") {
    return (
      <View
        style={{
          width: 29, height: 29, borderRadius: 8, backgroundColor: c.secondary,
          flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 2,
        }}
      >
        {bars.map((b, i) => (
          <Animated.View
            key={i}
            style={{
              width: 3, height: 15, borderRadius: 2, backgroundColor: c.voice,
              transform: [{ scaleY: b.interpolate({ inputRange: [0, 1], outputRange: [0.27, 1] }) }],
            }}
          />
        ))}
      </View>
    );
  }
  return (
    <Animated.View style={{ opacity: pulse }}>
      <RowGlyph name="wave" color={c.mutedForeground} />
    </Animated.View>
  );
}
