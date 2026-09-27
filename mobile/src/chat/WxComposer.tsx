// 聊天页的输入栏（#1386，照微信，demo 的 .cbar）：左「按住说话 ⇄ 键盘」（只在开发版里有：识别要原生模块，ADR-0320）、
// 中间输入框 / 按住说话、右 表情 + ⊕（打了字 ⊕ 换成「发送」）。⊕ 与表情各是一块面板，从输入栏底下升起、顶掉键盘的位置；
// 点输入框 = 收面板、起键盘。
//
// · 回车就是发送（照微信：returnKeyType send，不换行）；回执三态照旧（ADR-0228）：ok / unknown 清，确定失败留着原文。
// · 群里打一个 @（刚打的那一个，shared 的 justOpenedMention）就弹选人：调用方开抽屉，挑中了经 ref.mention 插回来。
// · 按住说话：按下开麦（调用方接 voiceStore 的 startDictation）、上划 60pt 变「松开取消」、松手发出去。
//   中间那块提示（声浪 + 听到的字 + 松开发送 / 上划取消）由调用方画在屏幕正中：它要盖在时间线上面，这一栏画不到那里。
// · 草稿跟着这条线走（seenStore，内存里）：离开时存、回来时摆回去；列表那一行写「[草稿]」。
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Animated, Easing, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { insertAgentMention, justOpenedMention } from "../../../src/shared/agentMentionInput.js";
import { takeDraftSeed, useChatStore } from "../cloud/chatStore.js";
import { draftOf, setDraft } from "../inbox/seenStore.js";
import { usePalette } from "../theme.js";
import { useReduceMotion } from "../ui.js";
import { Icon, type IconName } from "../wx/Icon.js";
import { EMOJI } from "./emoji.js";

export interface ComposerHandle {
  /** 把一句话填进输入框（不发出去），焦点还给它、光标落在末尾 */
  fill(text: string): void;
  /** 在光标处插一个 `@名字 `（刚打的那个 @ 会被换掉），焦点还给它 */
  mention(name: string): void;
}

export interface PlusItem {
  key: string;
  icon: IconName;
  label: string;
  onPress: () => void;
}

export type HoldState = { phase: "idle" } | { phase: "down"; cancel: boolean };

const PANEL_H = 236;
const CANCEL_LIFT = 60;

export function WxComposer({ placeholder, canSend, sessionId, draftKey, onSend, onAt, plus, hold, ref }: {
  placeholder: string;
  canSend: boolean;
  sessionId: string | null;
  /** 草稿挂在哪一条线上（列表那一行的键） */
  draftKey: string;
  onSend: (text: string) => Promise<boolean>;
  /** 群里：刚打了一个 @ */
  onAt?: () => void;
  plus: readonly PlusItem[];
  /** 按住说话；缺席 = 这台说不了（Expo Go / 正在听电话），左边那颗不画 */
  hold?: { onDown: () => void; onChange: (s: HoldState) => void; onUp: (send: boolean) => void };
  ref?: Ref<ComposerHandle>;
}) {
  const { c } = usePalette();
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const [draft, setDraftText] = useState(() => draftOf(draftKey));
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<"text" | "voice">("text");
  const [panel, setPanel] = useState<"plus" | "emoji" | null>(null);
  // 键盘起着的时候底下不再让出 home 条那一截（键盘本身已经盖过它了），否则输入栏和键盘之间空一道
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => setKeyboard(true));
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setKeyboard(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const seed = useChatStore().draftSeed;
  const input = useRef<TextInput>(null);
  const selection = useRef({ start: draft.length, end: draft.length });
  const draftNow = useRef(draft);
  useEffect(() => {
    draftNow.current = draft;
  }, [draft]);
  // 离开这条线时把草稿存下来（每敲一个字都存的话，底下那一列每个字都要重画一遍）
  useEffect(() => () => setDraft(draftKey, draftNow.current), [draftKey]);

  const put = (text: string, caret: number): void => {
    setDraftText(text);
    draftNow.current = text;
    selection.current = { start: caret, end: caret };
    setMode("text");
    setPanel(null);
    const el = input.current;
    if (el === null) return;
    el.focus();
    requestAnimationFrame(() => el.setSelection(caret, caret));
  };
  useImperativeHandle(ref, () => ({
    fill(text: string) {
      put(text, text.length);
    },
    mention(name: string) {
      const next = insertAgentMention(draftNow.current, selection.current.end, name);
      put(next.text, next.caret);
    },
  }), []);

  // 确定没发出去的那句（草稿里建私聊那第一句）摆回输入框——只在输入框空着时摆（人已经在打字了就别覆盖他）
  useEffect(() => {
    if (sessionId === null || draft !== "") return;
    const text = takeDraftSeed(sessionId);
    if (text !== null) setDraftText(text);
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
    if (clear) {
      setDraftText("");
      draftNow.current = "";
      selection.current = { start: 0, end: 0 };
    }
  };

  const onChange = (next: string): void => {
    const prev = draftNow.current;
    const caret = Math.max(0, Math.min(next.length, selection.current.end + (next.length - prev.length)));
    setDraftText(next);
    draftNow.current = next;
    selection.current = { start: caret, end: caret };
    if (onAt !== undefined && justOpenedMention(prev, next, caret)) onAt();
  };

  const togglePanel = (p: "plus" | "emoji"): void => {
    if (panel === p) {
      setPanel(null);
      input.current?.focus();
      return;
    }
    Keyboard.dismiss();
    setMode("text");
    setPanel(p);
  };

  // 面板升起 / 收起：高度跟一段 300ms 的 iOS 曲线；关了动效直接到位
  const h = useRef(new Animated.Value(0)).current;
  const panelH = PANEL_H + insets.bottom;
  useEffect(() => {
    const to = panel === null ? 0 : panelH;
    if (reduce) h.setValue(to);
    else Animated.timing(h, { toValue: to, duration: 300, easing: Easing.bezier(0.32, 0.72, 0, 1), useNativeDriver: false }).start();
  }, [panel, panelH, reduce, h]);

  const showSend = mode === "text" && draft.trim() !== "";
  return (
    <View style={{ backgroundColor: c.side }}>
      <View
        style={{
          flexDirection: "row", alignItems: "flex-end", gap: 6, paddingHorizontal: 8, paddingTop: 8,
          paddingBottom: panel !== null || keyboard ? 8 : Math.max(insets.bottom, 8),
          borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border,
        }}
      >
        {hold !== undefined ? (
          <BarButton
            icon={mode === "text" ? "audio-lines" : "keyboard"}
            label={mode === "text" ? "按住说话" : "打字"}
            onPress={() => {
              setPanel(null);
              if (mode === "text") {
                Keyboard.dismiss();
                setMode("voice");
              } else {
                setMode("text");
                requestAnimationFrame(() => input.current?.focus());
              }
            }}
          />
        ) : null}
        {mode === "text" || hold === undefined ? (
          <TextInput
            ref={input}
            multiline
            value={draft}
            onChangeText={onChange}
            onSelectionChange={(e) => {
              selection.current = e.nativeEvent.selection;
            }}
            onFocus={() => setPanel(null)}
            placeholder={placeholder}
            placeholderTextColor={c.faint}
            returnKeyType="send"
            submitBehavior="submit"
            onSubmitEditing={() => void submit()}
            style={{
              flex: 1, minHeight: 38, maxHeight: 110, borderRadius: 8, backgroundColor: c.inputBg,
              paddingHorizontal: 10, paddingTop: 8, paddingBottom: 8, fontSize: 16, lineHeight: 22, color: c.foreground,
            }}
          />
        ) : (
          <HoldButton hold={hold} />
        )}
        <BarButton icon="smile" label="表情" onPress={() => togglePanel("emoji")} />
        {showSend ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="发送"
            accessibilityState={{ disabled: !live }}
            disabled={!live}
            onPress={() => void submit()}
            style={({ pressed }) => [
              { height: 34, paddingHorizontal: 14, marginBottom: 2, borderRadius: 8, justifyContent: "center", backgroundColor: c.primary },
              (pressed || !live) && { opacity: live ? 0.8 : 0.45 },
            ]}
          >
            <Text style={{ fontSize: 15, fontWeight: "600", color: c.primaryForeground }}>发送</Text>
          </Pressable>
        ) : plus.length > 0 ? (
          <BarButton icon="circle-plus" label="更多" onPress={() => togglePanel("plus")} />
        ) : null}
      </View>
      <Animated.View style={{ height: h, overflow: "hidden" }}>
        {panel === "plus" ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 16, paddingTop: 18, rowGap: 18 }}>
            {plus.map((p) => (
              <Pressable
                key={p.key}
                accessibilityRole="button"
                accessibilityLabel={p.label}
                onPress={() => {
                  setPanel(null);
                  p.onPress();
                }}
                style={{ width: "25%", alignItems: "center", gap: 7 }}
              >
                {({ pressed }) => (
                  <>
                    <View style={{ width: 60, height: 60, borderRadius: 14, backgroundColor: c.card, alignItems: "center", justifyContent: "center", transform: [{ scale: pressed && !reduce ? 0.94 : 1 }] }}>
                      <Icon name={p.icon} size={26} stroke={1.6} color={c.foreground} />
                    </View>
                    <Text style={{ fontSize: 12, color: c.mutedForeground }}>{p.label}</Text>
                  </>
                )}
              </Pressable>
            ))}
          </View>
        ) : panel === "emoji" ? (
          <ScrollView contentContainerStyle={{ flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 10, paddingTop: 12, paddingBottom: insets.bottom + 12 }}>
            {EMOJI.map((e, i) => (
              <Pressable
                key={`${e}${i}`}
                accessibilityRole="button"
                accessibilityLabel={e}
                onPress={() => {
                  const at = selection.current.end;
                  const cur = draftNow.current;
                  const next = cur.slice(0, at) + e + cur.slice(at);
                  setDraftText(next);
                  draftNow.current = next;
                  selection.current = { start: at + e.length, end: at + e.length };
                }}
                style={({ pressed }) => [{ width: "12.5%", height: 44, alignItems: "center", justifyContent: "center", borderRadius: 8 }, pressed && { backgroundColor: c.press }]}
              >
                <Text style={{ fontSize: 26 }}>{e}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
      </Animated.View>
    </View>
  );
}

function BarButton({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const { c } = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [{ width: 36, height: 36, marginBottom: 1, borderRadius: 18, alignItems: "center", justifyContent: "center" }, pressed && { opacity: 0.5, transform: [{ scale: 0.92 }] }]}
    >
      <Icon name={icon} size={25} stroke={1.7} color={c.foreground} />
    </Pressable>
  );
}

/** 「按住 说话」（demo 的 .hold）：按下开始、手指往上挪过 60pt 变「松开 取消」、松手收尾。
    手指被系统抢走（来电、下拉控制中心）算取消——没松手的一句不该自己发出去 */
function HoldButton({ hold }: { hold: NonNullable<Parameters<typeof WxComposer>[0]["hold"]> }) {
  const { c } = usePalette();
  const [down, setDown] = useState(false);
  const [cancel, setCancel] = useState(false);
  const y0 = useRef(0);
  const cancelNow = useRef(false);
  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel="按住说话"
      accessibilityHint="按住说，松开发出去；往上划取消"
      onStartShouldSetResponder={() => true}
      onResponderGrant={(e) => {
        y0.current = e.nativeEvent.pageY;
        cancelNow.current = false;
        setCancel(false);
        setDown(true);
        hold.onDown();
        hold.onChange({ phase: "down", cancel: false });
      }}
      onResponderMove={(e) => {
        const next = y0.current - e.nativeEvent.pageY > CANCEL_LIFT;
        if (next === cancelNow.current) return;
        cancelNow.current = next;
        setCancel(next);
        hold.onChange({ phase: "down", cancel: next });
      }}
      onResponderRelease={() => {
        setDown(false);
        hold.onChange({ phase: "idle" });
        hold.onUp(!cancelNow.current);
      }}
      onResponderTerminate={() => {
        setDown(false);
        hold.onChange({ phase: "idle" });
        hold.onUp(false);
      }}
      style={{ flex: 1, height: 38, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: down ? c.press : c.inputBg }}
    >
      <Text style={{ fontSize: 16, fontWeight: "600", color: c.foreground }}>{down ? (cancel ? "松开 取消" : "松开 发送") : "按住 说话"}</Text>
    </View>
  );
}
