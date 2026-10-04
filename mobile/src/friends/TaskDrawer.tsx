// 代办的抽屉（#1565，ADR-0364）：私聊页上一张任务卡点开的那一扇——这次请求的来回、管理员下发给了谁、谁回了什么，
// 按时间一行一行；底下一格能接着说（进的是这条任务所在的车道，不是私聊）。主页只留卡，过程全在这里。
import { useEffect, useState } from "react";
import { Keyboard, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LANE_TASK_STATUS_LABEL, laneTaskStatus, type LaneTask } from "../../../src/shared/laneTasks.js";
import { BottomSheet } from "../sheet/BottomSheet.js";
import { space, usePalette, withAlpha } from "../theme.js";

import { LaneBubble } from "./LaneBubble.js";

export function TaskDrawer({ visible, task, peer, busy, nameOf, slotOf, meName, meAvatar, friendName, friendAvatar, footer, onSend, onClose, onExited }: {
  visible: boolean;
  /** 点开的那一条；退场放完之前调用方不清它（onExited 才清），正文不会在退场时一下子空掉 */
  task: LaneTask | null;
  /** 这条任务在朋友的车道里（TA 的管理员在办）还是我的车道里 */
  peer: boolean;
  /** 这条车道此刻还有人在答 */
  busy: boolean;
  nameOf: (agentId: string) => string;
  slotOf: (agentId: string) => number;
  meName: string;
  meAvatar: string;
  friendName: string;
  friendAvatar: string;
  /** 每一行底下那句「谁看得到」 */
  footer: string;
  /** 接着说一句（进车道）。回 false = 没发出去，字留在框里 */
  onSend: (text: string) => Promise<boolean>;
  onClose: () => void;
  onExited: () => void;
}) {
  const { c } = usePalette();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const status = task === null ? null : laneTaskStatus(task, busy);
  const title = task === null ? "代办" : `${task.kind === "call" ? "电话" : "代办"} · ${LANE_TASK_STATUS_LABEL[status!]}`;
  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (text === "" || sending) return;
    setSending(true);
    const ok = await onSend(text);
    setSending(false);
    if (ok) setDraft("");
  };
  // 键盘让位（真机 2026-10-05：键盘一弹，底下那格输入框整个被盖住）：抽屉是个 Modal，KAV 在里面量不准，
  // 自己听键盘高度、给根 View 垫同样的底——抽屉已经垫了 insets.bottom，键盘盖住的那段要扣掉
  const insets = useSafeAreaInsets();
  const [kb, setKb] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", (e) => setKb(Math.max(0, e.endCoordinates.height - insets.bottom)));
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setKb(0));
    return () => { show.remove(); hide.remove(); };
  }, [insets.bottom]);
  return (
    <BottomSheet visible={visible} title={title} onClose={onClose} onExited={onExited}>
      <View style={{ flex: 1, paddingBottom: kb }}>
        {task === null ? (
          <Text style={{ fontSize: 13, color: c.mutedForeground, textAlign: "center", padding: space.md }}>这条任务已经不在了。</Text>
        ) : (
          <ScrollView contentContainerStyle={{ paddingVertical: space.md, gap: 16 }}>
            <Text style={{ fontSize: 15, fontWeight: "600", color: c.foreground, paddingHorizontal: 16 }}>{task.title}</Text>
            {task.items.length === 0 ? (
              <Text style={{ fontSize: 13, color: c.mutedForeground, textAlign: "center" }}>还没有进展。</Text>
            ) : (
              task.items.map((item) => (
                <LaneBubble
                  key={item.key}
                  item={item}
                  name={item.agentId !== undefined ? nameOf(item.agentId) : "智能体"}
                  slot={item.agentId !== undefined ? slotOf(item.agentId) : 0}
                  meName={meName}
                  meAvatar={meAvatar}
                  friendName={friendName}
                  friendAvatar={friendAvatar}
                  footer={item.handoff !== undefined ? `下发给 ${item.handoff.toAgentIds.map(nameOf).join("、")}` : footer}
                  peer={peer}
                />
              ))
            )}
          </ScrollView>
        )}
        {task !== null ? (
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 0.5, borderTopColor: c.border }}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={peer ? `对 ${friendName} 的管理员说…` : "接着说…"}
              placeholderTextColor={c.faint}
              multiline
              style={{ flex: 1, minHeight: 38, maxHeight: 120, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: withAlpha(c.foreground, 0.05), fontSize: 16, color: c.foreground }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="发送"
              disabled={sending || draft.trim() === ""}
              onPress={() => void send()}
              style={({ pressed }) => [{ height: 38, paddingHorizontal: 14, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: draft.trim() === "" ? withAlpha(c.foreground, 0.08) : c.brand }, pressed && { opacity: 0.7 }]}
            >
              <Text style={{ fontSize: 15, fontWeight: "600", color: draft.trim() === "" ? c.faint : "#fff" }}>{sending ? "…" : "发送"}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </BottomSheet>
  );
}
