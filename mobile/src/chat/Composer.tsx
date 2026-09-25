// 聊天页的输入框（#1356 A1 / A2，spec §5.3 / §5.5）：一张卡 + 右边一颗 48 的圆钮。打了字 = 发出去；空着时
// 是一颗灰的发送钮（A4 起空着变「开电话」，一物两用）。没有型号选择器、没有上下文环。
// 回执三态记在 chatStore（ADR-0228）；这里只决定清不清输入框：ok / unknown 清，确定失败留着。
// 有字才亮：空框旁边一颗常亮的发送钮是在说「点我就发」，而点了什么都不会发生。
// `ref` 上的 `fill(text)`（A2）：六句现成话点一下只填进来、不发出去——盖掉原来那几个字（点 chip 就是
// 要这一句，demo 同款），焦点还给输入框、光标落在末尾。
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Animated, Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SendGlyph } from "../chrome/Glyphs.js";
import { takeDraftSeed, useChatStore } from "../cloud/chatStore.js";
import { PRESS_SPRING, usePalette, withAlpha } from "../theme.js";
import { useReduceMotion } from "../ui.js";

export interface ComposerHandle {
  /** 把一句话填进输入框（不发出去），焦点还给它、光标落在末尾 */
  fill(text: string): void;
}

export function Composer({ placeholder, canSend, sessionId, onSend, ref }: {
  placeholder: string;
  /** 草稿里总能发（发了才建）；有会话时只有 ready 才能发——gone 时照常能打字，发送钮灰 */
  canSend: boolean;
  sessionId: string | null;
  /** 回 true = 这句话已经交出去（或不确定有没有），清输入框 */
  onSend: (text: string) => Promise<boolean>;
  /** React 19 的函数组件直接收 ref：只开「填一句话进来」这一个口 */
  ref?: Ref<ComposerHandle>;
}) {
  const { c } = usePalette();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const seed = useChatStore().draftSeed;
  const reduce = useReduceMotion();
  const input = useRef<TextInput>(null);
  const sendScale = useRef(new Animated.Value(1)).current;
  const pressTo = (v: number): void => {
    if (!reduce) Animated.spring(sendScale, { toValue: v, useNativeDriver: true, ...PRESS_SPRING }).start();
  };
  useImperativeHandle(
    ref,
    () => ({
      fill(text: string) {
        setDraft(text);
        const el = input.current;
        if (el === null) return;
        el.focus();
        // 值要等这一拍渲染落到原生那侧才在；下一帧再把光标挪到末尾（刚聚焦时光标可能落在任何地方）
        requestAnimationFrame(() => el.setSelection(text.length, text.length));
      },
    }),
    [],
  );
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
          ref={input}
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
