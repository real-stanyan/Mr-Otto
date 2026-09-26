// 聊天页的输入框（#1356 A1 / A2，spec §5.3 / §5.5）：一张卡 + 右边一颗 48 的圆钮。打了字 = 发出去；空着时
// 是一颗灰的发送钮；这台打得了电话时（A4）空着变「开电话」，一物两用。没有型号选择器、没有上下文环。
// 回执三态记在 chatStore（ADR-0228）；这里只决定清不清输入框：ok / unknown 清，确定失败留着。
// 有字才亮：空框旁边一颗常亮的发送钮是在说「点我就发」，而点了什么都不会发生。
// `ref` 上的 `fill(text)`（A2）：六句现成话点一下只填进来、不发出去——盖掉原来那几个字（点 chip 就是
// 要这一句，demo 同款），焦点还给输入框、光标落在末尾。
// `mention(name)`（A3）：「@ 谁」那张抽屉挑了一只——在光标处插一个 `@名字 `（插在哪由 shared 的
// insertAgentMention 判），焦点还给输入框、光标落在插进去那一段后面。要知道光标在哪，所以记着最近一次的选区。
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Animated, Easing, Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { insertAgentMention } from "../../../src/shared/agentMentionInput.js";
import { SendGlyph } from "../chrome/Glyphs.js";
import { WaveGlyph } from "../chrome/VoiceGlyphs.js";
import { takeDraftSeed, useChatStore } from "../cloud/chatStore.js";
import { PRESS_SPRING, usePalette, withAlpha } from "../theme.js";
import { useReduceMotion } from "../ui.js";

export interface ComposerHandle {
  /** 把一句话填进输入框（不发出去），焦点还给它、光标落在末尾 */
  fill(text: string): void;
  /** 在光标处插一个 `@名字 `（A3），焦点还给它、光标落在插进去那一段后面 */
  mention(name: string): void;
}

export function Composer({ placeholder, canSend, sessionId, onSend, phone, ref }: {
  placeholder: string;
  /** 草稿里总能发（发了才建）；有会话时只有 ready 才能发——gone 时照常能打字，发送钮灰 */
  canSend: boolean;
  sessionId: string | null;
  /** 回 true = 这句话已经交出去（或不确定有没有），清输入框 */
  onSend: (text: string) => Promise<boolean>;
  /** 输入框空着时右边那颗变「开电话」（A4，spec §5.3 一物两用）；缺席 = 这台打不了电话，照旧是那颗灰的发送钮。
      `busy`：电话正在打出去，这颗按不动 */
  phone?: { onCall: () => void; busy: boolean };
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
  /** 最近一次的选区与正文：句柄是一次建好的（useImperativeHandle 的依赖是 []），读 state 会读到旧值 */
  const selection = useRef({ start: 0, end: 0 });
  const draftNow = useRef("");
  useEffect(() => {
    draftNow.current = draft;
  }, [draft]);
  const sendScale = useRef(new Animated.Value(1)).current;
  const pressTo = (v: number): void => {
    if (!reduce) Animated.spring(sendScale, { toValue: v, useNativeDriver: true, ...PRESS_SPRING }).start();
  };
  useImperativeHandle(
    ref,
    () => {
      /** 把一句话摆进输入框、光标落在 `caret`，焦点还给它 */
      const put = (text: string, caret: number): void => {
        setDraft(text);
        draftNow.current = text;
        selection.current = { start: caret, end: caret };
        const el = input.current;
        if (el === null) return;
        el.focus();
        // 值要等这一拍渲染落到原生那侧才在；下一帧再挪光标（刚聚焦时光标可能落在任何地方）
        requestAnimationFrame(() => el.setSelection(caret, caret));
      };
      return {
        fill(text: string) {
          put(text, text.length);
        },
        mention(name: string) {
          const next = insertAgentMention(draftNow.current, selection.current.end, name);
          put(next.text, next.caret);
        },
      };
    },
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
  const calling = phone !== undefined && draft.trim() === "";
  const enabled = calling ? !(phone?.busy ?? false) : live;
  // 「开电话」⇄「发出去」换那一下：160ms 淡入 + 从 .7 放大（减弱动态效果时只淡入）
  const swap = useRef(new Animated.Value(1)).current;
  const lastCalling = useRef(calling);
  useEffect(() => {
    if (lastCalling.current === calling) return;
    lastCalling.current = calling;
    swap.setValue(0);
    Animated.timing(swap, { toValue: 1, duration: 160, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [calling, swap]);
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
          onSelectionChange={(e) => {
            selection.current = e.nativeEvent.selection;
          }}
          placeholder={placeholder}
          placeholderTextColor={c.mutedForeground}
          style={{ fontSize: 16, lineHeight: 22, maxHeight: 110, color: c.foreground, padding: 0 }}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={calling ? "开电话" : "发送"}
        accessibilityState={{ disabled: !enabled }}
        disabled={!enabled}
        onPress={() => {
          if (calling) phone?.onCall();
          else void submit();
        }}
        onPressIn={() => pressTo(0.93)}
        onPressOut={() => pressTo(1)}
        style={({ pressed }) => [reduce && pressed && { opacity: 0.7 }]}
      >
        <Animated.View
          style={{
            width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center",
            backgroundColor: calling || live ? c.primary : withAlpha(c.foreground, 0.07),
            opacity: calling && !enabled ? 0.5 : 1,
            transform: [{ scale: sendScale }],
          }}
        >
          <Animated.View style={{ opacity: swap, transform: reduce ? [] : [{ scale: swap.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) }] }}>
            {calling ? <WaveGlyph color={c.primaryForeground} /> : <SendGlyph color={live ? c.primaryForeground : c.mutedForeground} />}
          </Animated.View>
        </Animated.View>
      </Pressable>
    </View>
  );
}
