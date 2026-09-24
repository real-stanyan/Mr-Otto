// 聊天页的输入框（#1356 A1，spec §5.3）：一张卡 + 右边一颗 48 的圆钮。打了字 = 发出去；空着时
// 是一颗灰的发送钮（A4 起空着变「开电话」，一物两用）。没有型号选择器、没有上下文环。
// 回执三态记在 chatStore（ADR-0228）；这里只决定清不清输入框：ok / unknown 清，确定失败留着。
// 有字才亮：空框旁边一颗常亮的发送钮是在说「点我就发」，而点了什么都不会发生。
import { useEffect, useRef, useState } from "react";
import { Animated, Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SendGlyph } from "../chrome/Glyphs.js";
import { takeDraftSeed, useChatStore } from "../cloud/chatStore.js";
import { PRESS_SPRING, usePalette, withAlpha } from "../theme.js";
import { useReduceMotion } from "../ui.js";

export function Composer({ placeholder, canSend, sessionId, onSend }: {
  placeholder: string;
  /** 草稿里总能发（发了才建）；有会话时只有 ready 才能发——gone 时照常能打字，发送钮灰 */
  canSend: boolean;
  sessionId: string | null;
  /** 回 true = 这句话已经交出去（或不确定有没有），清输入框 */
  onSend: (text: string) => Promise<boolean>;
}) {
  const { c } = usePalette();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const seed = useChatStore().draftSeed;
  const reduce = useReduceMotion();
  const sendScale = useRef(new Animated.Value(1)).current;
  const pressTo = (v: number): void => {
    if (!reduce) Animated.spring(sendScale, { toValue: v, useNativeDriver: true, ...PRESS_SPRING }).start();
  };
  // 确定没发出去的那句（草稿里那第一句）摆回输入框——**只在输入框是空的时候摆**（桌面
  // CloudSessionPage 同一条）：人已经在打字了就别覆盖他；不取走，它就还留在 store 里，
  // 等输入框空了再摆回来
  useEffect(() => {
    if (sessionId === null || draft !== "") return;
    const text = takeDraftSeed(sessionId);
    if (text !== null) setDraft(text);
  }, [seed, sessionId, draft]);
  const live = draft.trim() !== "" && canSend && !sending;
  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!live) return;
    setSending(true);
    let clear = false;
    try {
      clear = await onSend(text);
    } finally {
      setSending(false);
    }
    if (clear) setDraft("");
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 10, paddingHorizontal: 12, paddingTop: 9, paddingBottom: Math.max(insets.bottom, 12) }}>
      <View style={{
        flex: 1, minHeight: 48, justifyContent: "center", backgroundColor: c.card,
        borderWidth: 1, borderColor: c.input, borderRadius: 22, paddingLeft: 15, paddingRight: 11, paddingVertical: 12,
      }}>
        <TextInput
          multiline
          value={draft}
          onChangeText={setDraft}
          placeholder={placeholder}
          placeholderTextColor={c.mutedForeground}
          style={{ fontSize: 16, lineHeight: 22, maxHeight: 110, color: c.foreground, padding: 0 }}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="发送"
        accessibilityState={{ disabled: !live }}
        disabled={!live}
        onPress={() => void submit()}
        onPressIn={() => pressTo(0.93)}
        onPressOut={() => pressTo(1)}
        style={({ pressed }) => [reduce && pressed && { opacity: 0.7 }]}
      >
        <Animated.View
          style={{
            width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center",
            backgroundColor: live ? c.primary : withAlpha(c.foreground, 0.07),
            transform: [{ scale: sendScale }],
          }}
        >
          <SendGlyph color={live ? c.primaryForeground : c.mutedForeground} />
        </Animated.View>
      </Pressable>
    </View>
  );
}
